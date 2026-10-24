import fs from 'node:fs/promises';
import { EventSubscriptions } from './events.mjs';
import { Submissions } from './submissions.mjs';
import { settledResultSchema } from './settled-result.mjs';
import { publicError } from './errors.mjs';
import path from 'node:path';
import { compactReceipt, nativeCompactReason } from './compact.mjs';
import { modelsSchema } from './models.mjs';
import { modelSettings } from './set-model.mjs';
import { loadModelCatalog } from './model-catalog.mjs';
import { randomUUID } from 'node:crypto';
import { readSchema, searchSchema } from './read-schema.mjs';
import { publicOperationSchemas } from './tool-schemas.mjs';
import { isDeepStrictEqual } from 'node:util';
import { inside, permitted, permissionsHealth } from './permissions.mjs';
import { sessionMetadata, runtimeMetadata } from './session-metadata.mjs';
import { prepareSession, persistSession } from './create-session.mjs';
import {
  SEND_MODES,
  promptInput,
  hasPromptSettings,
  assertPromptSelection,
  promptOptions,
  promptResult,
  attachedPromptResult,
} from './prompt-input.mjs';
import { ContextReadCache } from './read-cache.mjs';
import { prepareContextRead } from './context-read.mjs';
import { CompatibilityModules } from './compatibility.mjs';
import { CompatibilityServices } from './compatibility-services.mjs';
import { captureSessionRead } from './session-readers.mjs';
import { checkObservation, unavailableObservation } from './context-observation.mjs';
import {
  discover,
  readSessionIdentity,
  loadSavedSession,
  validateExecutionCwd,
  assertSingleSessionFile,
} from './data.mjs';
import { atomicJson, assertPrivateDirectory, assertNativeDirectory } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
import { stopReceipt, inlineWithdrawal, withdrawalOutput } from './stop-execution.mjs';
import { bashOutput, inlineBashResult } from './bash-execution.mjs';
import { PiRpc, RuntimePool, launchProfile } from './rpc.mjs';
import { nativeSdk } from './pi-installation.mjs';
import {
  privateDirectory,
  readClaim,
  readOwnerRecord,
  ownerAlive,
  registryTransaction,
  updateOwner,
  claimFile,
} from './attachments.mjs';
import { serveOwnerControl } from './owner-runtime.mjs';
import { readOwnerConfig, validateOwnerConfig } from './owner-config.mjs';
import { diagnostics } from './diagnostics.mjs';
import { prepareTrash } from './trash.mjs';
import { idleHandoff, cancelHandoff } from './idle-handoff.mjs';
import { scheduleAutoRelease } from './auto-release.mjs';
import { optionalResultFields } from './response-budget.mjs';
import { ownerReadFeatures } from './read-features.mjs';
function scopeSnapshot(config) {
  const folders = Object.freeze(config.folders.map((folder) => Object.freeze({ ...folder })));
  const sessionRoots = Object.freeze([...config.sessionRoots]);
  return Object.freeze({ folders, sessionRoots });
}

export class Bridge {
  constructor(config, factory, { configFile } = {}) {
    this.config = config;
    this.configFile = configFile;
    const { grants, defaults, folders, sessionRoots, herdr, ...settings } = config;
    this.ownerSettings = structuredClone(settings);
    this.compatibilityServices = new CompatibilityServices();
    this.compatibility = new CompatibilityModules(
      config.compatibilityModules,
      this.compatibilityServices,
    );
    this.pool = new RuntimePool(config, factory, {
      compatibility: this.compatibilityServices,
      configFile,
      completionControl: { stateDir: config.stateDir, attachmentDir: config.attachmentDir },
    });
    this.pendingMutations = new Set();
    this.locks = new Map();
    this.handoffs = new Map();
    this.inputs = new Set();
    this.sessionFiles = new Map();
    this.titleCache = new Map();
    this.readCache = new ContextReadCache();
    this.autoReleases = new Set();
    this.events = new EventSubscriptions(this);
    this.submissions = new Submissions();
    this.pool.onIdleCandidate = (runtime) => scheduleAutoRelease(this, runtime);
  }
  async init() {
    validateOwnerConfig(this.config);
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.config.stateDir);
    for (const root of this.config.sessionRoots) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await assertNativeDirectory(root);
    }
    await privateDirectory(this.pool.attachmentDir);
    // Configured execution directories may be offline while saved history is
    // still accessible. Create and cold resume validate their cwd on demand.
    // Service lifetime exclusivity is independent of the short registry mutex.
    this.lock = await kernelLock('bridge:' + this.config.stateDir, {
      busy: 'BRIDGE_ALREADY_RUNNING',
    });
    try {
      await this.compatibility.start();
      await this.events.init();
      this.ownerControl = await serveOwnerControl(this);
    } catch (error) {
      await Promise.allSettled([this.compatibility.stop(), this.events.close()]);
      await this.lock.close();
      this.lock = null;
      throw error;
    }
    return this;
  }
  async locked(id, fn) {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) {
        this.locks.delete(id);
        if (id.startsWith('stop:') || id.startsWith('bash:'))
          this.pool.instances.get(id.slice(5))?.onIdleCandidate?.();
      }
    }
  }
  registerInput(sessionId) {
    const input = { sessionId, stopped: this.locks.has(`stop:${sessionId}`) };
    this.inputs.add(input);
    return input;
  }
  async withInput(sessionId, input, fn) {
    input ??= this.registerInput(sessionId);
    // Keep cancellation across batch lanes, permission and state I/O.
    // A completed stop must not revive input that has not reached Pi yet.
    const beforeDispatch = () => {
      this.assertOpen();
      if (input.stopped || this.locks.has(`stop:${sessionId}`)) throw new Error('STOP_IN_PROGRESS');
      if (this.handoffs.get(sessionId)?.kind === 'delete') throw new Error('HANDOFF_PENDING');
    };
    try {
      return await fn(beforeDispatch);
    } finally {
      this.inputs.delete(input);
    }
  }
  async sessions(requestContext) {
    // Owner-local identity lookup is not business admission and remains available
    // during cleanup. Unknown identities use current scope, not startup roots.
    const scope =
      requestContext?.scope ??
      scopeSnapshot(
        this.configFile ? (await readOwnerConfig(this.configFile)).config : this.config,
      );
    const config = { ...this.config, ...scope };
    const sessions = await diagnostics.measure('session.discover', {}, () => discover(config));
    this.sessionFiles = new Map(sessions.map((s) => [s.id, s.file]));
    return sessions;
  }
  async mutationLock(id, action, requestContext, fn, lockId = id) {
    const blockedReason = () =>
      this.handoffs.has(id) && this.handoffs.get(id).kind !== 'auto_release'
        ? 'HANDOFF_PENDING'
        : action === 'send' && this.locks.has(`stop:${id}`)
          ? 'STOP_IN_PROGRESS'
          : null;
    const blocked = async (reason) => {
      try {
        this.check(action, await this.session(id, requestContext), requestContext);
        return { status: 'rejected', reason };
      } catch (error) {
        return { status: 'rejected', reason: safeReason(error) };
      }
    };
    const reason = blockedReason();
    if (reason) return blocked(reason);
    return this.locked(lockId, () => {
      const reason = blockedReason();
      return reason ? blocked(reason) : fn();
    });
  }
  async captureRequestContext() {
    this.assertOpen();
    return diagnostics.measure('permission.snapshot', {}, async () => {
      let policy = this.config;
      let restartRequired = [];
      if (this.configFile) {
        const { config } = await readOwnerConfig(this.configFile);
        const { grants, defaults, folders, sessionRoots, herdr, ...settings } = config;
        restartRequired = [
          ...new Set([...Object.keys(this.ownerSettings), ...Object.keys(settings)]),
        ].filter((key) => !isDeepStrictEqual(settings[key], this.ownerSettings[key]));
        // Hot scope must remain valid against ACTIVE storage, not just a
        // proposed stateDir that will only take effect after restart.
        validateOwnerConfig({ ...this.config, grants, defaults, folders, sessionRoots });
        policy = config;
      }
      const defaults = Object.freeze({ ...policy.defaults });
      const grants = Object.freeze((policy.grants ?? []).map((rule) => Object.freeze({ ...rule })));
      const scope = scopeSnapshot(policy);
      return Object.freeze({
        permissions: Object.freeze({ defaults, grants }),
        scope,
        restartRequired: Object.freeze(restartRequired),
      });
    });
  }
  async session(id, requestContext) {
    let file = this.sessionFiles.get(id) ?? this.pool.instances.get(id)?.session?.file;
    // Owner-local cleanup may outlive both scope membership and the discovery cache.
    // Reuse the existing claim's identity, never a previous permission policy.
    if (!requestContext && !file && /^ps_[a-f0-9]{32}$/.test(id)) {
      await privateDirectory(this.pool.attachmentDir);
      file = (
        await readOwnerRecord(
          this.pool.attachmentDir,
          path.join(this.pool.attachmentDir, `${id}.owner.json`),
        )
      )?.file;
    }
    if (
      file &&
      (!requestContext || requestContext.scope.sessionRoots.some((root) => inside(file, root)))
    ) {
      const current = await readSessionIdentity(file).catch(() => null);
      if (current?.id === id) return current;
      this.sessionFiles.delete(id);
    }
    const s = (await this.sessions(requestContext)).find((s) => s.id === id);
    if (!s) throw new Error('NOT_FOUND_OR_DENIED');
    return s;
  }
  // Request policy is immutable. Check at admission and after refreshing a
  // target identity, not repeatedly across awaits with the same target/policy.
  check(action, s, requestContext) {
    const allowed = permitted(requestContext.permissions, action, s);
    diagnostics.emit('permission.check', { op: action, allowed });
    if (!allowed) throw new Error('NOT_FOUND_OR_DENIED');
  }
  async models(args = {}, { requestContext } = {}) {
    if (!modelsSchema.safeParse(args).success) throw new Error('INVALID_MODELS_ARGUMENTS');
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const policy = requestContext.permissions;
    let allowed = requestContext.scope.folders.some((folder) =>
      ['send', 'command', 'create'].some((action) =>
        permitted(policy, action, { cwd: folder.path }),
      ),
    );
    const mayExecuteSession = ['send', 'command'].some(
      (action) =>
        policy.defaults[action] === true || policy.grants.some((rule) => rule[action] === true),
    );
    if (!allowed && mayExecuteSession) {
      // folders configures creation targets, not the universe of native history.
      // Discover identity metadata once; no transcript or owner is acquired.
      allowed = (await this.sessions(requestContext)).some((session) =>
        ['send', 'command'].some((action) => permitted(policy, action, session)),
      );
    }
    diagnostics.emit('permission.check', { op: 'models', allowed });
    if (!allowed) throw new Error('NOT_FOUND_OR_DENIED');
    return loadModelCatalog(this.config, args);
  }
  set_model(args, options) {
    return this.#mutation('set_model', args, options, this.#setModel);
  }
  send(args, options) {
    return this.#mutation('send', args, options, this.#send);
  }
  async submission(args, { requestContext } = {}) {
    if (!publicOperationSchemas.submission.safeParse(args).success)
      throw new Error('INVALID_ARGUMENTS');
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const session = await this.session(args.session_id, requestContext);
    if (
      !['read', 'send', 'create'].some((action) =>
        permitted(requestContext.permissions, action, session),
      )
    )
      throw new Error('NOT_FOUND_OR_DENIED');
    const record = this.submissions.get(session.id, args.submission_id);
    if (
      !['read', 'send'].some((action) => permitted(requestContext.permissions, action, session)) &&
      !(record.operation === 'create' && permitted(requestContext.permissions, 'create', session))
    )
      throw new Error('NOT_FOUND_OR_DENIED');
    return record;
  }
  create(args, options) {
    return this.#mutation('create', args, options, this.#create);
  }
  command(args, options) {
    return this.#mutation('command', args, options, this.#command);
  }
  stop(args, options) {
    return this.#mutation('stop', args, options, this.#stop);
  }
  compact(args, options) {
    return this.#mutation('compact', args, options, this.#compact);
  }
  delete(args, options) {
    return this.#mutation('delete', args, options, this.#delete);
  }

  async #mutation(op, input, options, action) {
    const parsed = publicOperationSchemas[op].safeParse(input);
    if (!parsed.success) throw new Error('INVALID_ARGUMENTS');
    this.assertOpen();
    let releaseCandidate;
    const work = (async () => {
      try {
        return await action.call(this, parsed.data, {
          ...options,
          markForAutoRelease: (runtime) => {
            if (runtime instanceof PiRpc) releaseCandidate = runtime;
          },
        });
      } finally {
        if (releaseCandidate) {
          releaseCandidate.autoReleaseWanted = true;
          releaseCandidate.onIdleCandidate?.();
        }
      }
    })();
    this.pendingMutations.add(work);
    const settled = () => this.pendingMutations.delete(work);
    work.then(settled, settled);
    return work;
  }
  async #compact(args, { requestContext, markForAutoRelease, pendingInput } = {}) {
    return this.withInput(args.session_id, pendingInput, async (checkInput) => {
      requestContext = await (requestContext ?? this.captureRequestContext());
      this.assertOpen();
      const session = await this.session(args.session_id, requestContext);
      this.check('send', session, requestContext);
      if (args.interrupt) this.check('stop', session, requestContext);
      const body = { instructions: args.instructions ?? '', interrupt: args.interrupt ?? false };
      return this.mutationLock(session.id, 'send', requestContext, async () => {
        try {
          let runtime = await this.pool.forRead(session);
          if (!runtime) {
            await validateExecutionCwd(session.cwd);
            await loadSavedSession(session, { config: this.config });
            checkInput();
            runtime = await this.pool.resolve(session);
          }
          markForAutoRelease(runtime);
          if (!runtime.attached && !body.interrupt)
            await runtime.assertIdle({
              busy: 'COMPACT_BUSY',
              unconfirmed: 'COMPACT_IDLE_UNCONFIRMED',
            });
          const authorized = checkInput;
          await authorized();
          const late = () => {}; // Keep native late-ACK identity validation.
          const result = runtime.attached
            ? await runtime.compact(body, undefined, authorized)
            : await runtime.command(
                { type: 'compact', customInstructions: body.instructions },
                undefined,
                late,
                authorized,
              );
          return { interrupt_requested: body.interrupt, ...compactReceipt(result) };
        } catch (error) {
          const nativeReason =
            error.code === 'PI_REJECTED' ? nativeCompactReason(error.native_reason) : undefined;
          return {
            status: error.uncertain ? 'unknown' : 'rejected',
            reason: safeReason(error),
            ...(nativeReason ? { native_reason: nativeReason } : {}),
            native_effects:
              error.code === 'PI_REJECTED' || error.uncertain ? 'native_compact_attempted' : 'none',
          };
        }
      });
    });
  }
  async list(args = {}, { requestContext } = {}) {
    const parsed = publicOperationSchemas.list.safeParse(args);
    if (!parsed.success) throw new Error('INVALID_ARGUMENTS');
    args = parsed.data;
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const sessions = args.session_id
      ? await this.session(args.session_id, requestContext).then(
          (s) => [s],
          (error) => {
            if (error.message === 'NOT_FOUND_OR_DENIED') return [];
            throw error;
          },
        )
      : await this.sessions(requestContext);
    if (args.session_id && sessions[0]?.header.parentSession) {
      const parentId = [...this.sessionFiles].find(
        ([, file]) => file === sessions[0].header.parentSession,
      )?.[0];
      const parent = parentId && (await this.session(parentId, requestContext).catch(() => null));
      if (parent) sessions.push(parent);
    }
    const matches = (value, query) =>
      !query || (value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
    const candidates = [];
    for (const session of sessions) {
      if (!permitted(requestContext.permissions, 'list', session)) continue;
      if (args.session_id && session.id !== args.session_id) continue;
      if (!matches(session.header.cwd, args.project)) continue;
      let stat;
      try {
        stat = await fs.stat(session.file);
      } catch {
        continue;
      }
      const activity = new Date(stat.mtimeMs).toISOString();
      if (args.active_after && activity < new Date(args.active_after).toISOString()) continue;
      if (args.active_before && activity > new Date(args.active_before).toISOString()) continue;
      candidates.push({ session, last_activity: activity });
    }
    candidates.sort(
      (a, b) =>
        b.last_activity.localeCompare(a.last_activity) || a.session.id.localeCompare(b.session.id),
    );
    const offset = args.offset ?? 0,
      limit = args.limit ?? 30,
      selected = [];
    let matching = 0,
      hasMore = false;
    // Keep status polling concurrent across the ordinary page, as before name
    // and status began sharing the same native observation.
    const observations = new Map();
    if (!args.name)
      for (const { session } of candidates.slice(offset, offset + limit))
        observations.set(session.id, runtimeMetadata(this.pool, session));
    for (const [index, candidate] of candidates.entries()) {
      // Only native state is prefetched. Saved metadata is read in result order,
      // and scanning stops after the page plus one additional matching row.
      if (args.name)
        for (const next of candidates.slice(index, index + 4))
          if (!observations.has(next.session.id))
            observations.set(next.session.id, runtimeMetadata(this.pool, next.session));
      // With no title filter, earlier pages need no transcript scan at all.
      if (!args.name && matching++ < offset) continue;
      if (!args.name && selected.length === limit) {
        hasMore = true;
        break;
      }
      const session = candidate.session;
      let metadata;
      const observed = await (observations.get(session.id) ?? runtimeMetadata(this.pool, session));
      observations.delete(session.id);
      try {
        metadata =
          observed.name !== undefined
            ? { name: observed.name }
            : await sessionMetadata(session, this.titleCache);
      } catch {
        continue;
      }
      if (!matches(metadata.name, args.name)) continue;
      if (args.name && matching++ < offset) continue;
      if (selected.length === limit) {
        hasMore = true;
        break;
      }
      const parent = sessions.find((other) => other.file === session.header.parentSession);
      selected.push({
        session_id: session.id,
        project: session.header.cwd || null,
        name: metadata.name,
        parent_session_id:
          parent && permitted(requestContext.permissions, 'list', parent) ? parent.id : null,
        last_activity: candidate.last_activity,
        status: observed.status,
      });
    }
    return {
      sessions: selected,
      next_offset: hasMore ? offset + limit : null,
      // Project discovery is independent of existing sessions and their page.
      // Session-specific list grants do not disclose other creation targets.
      creatable_projects: requestContext.scope.folders
        .filter(({ path }) =>
          ['list', 'create'].every((action) =>
            permitted(requestContext.permissions, action, { cwd: path }),
          ),
        )
        .map(({ path }) => path),
    };
  }
  async health(args = {}, { requestContext } = {}) {
    const { session_id } = publicOperationSchemas.health.parse(args);
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    // Diagnose only the requested session, without its metadata or source paths.
    if (session_id) {
      const target = await this.session(session_id, requestContext).catch(() => ({
        id: session_id,
        cwd: null,
      }));
      return permissionsHealth(
        { ...requestContext.permissions, folders: requestContext.scope.folders },
        { session_id, cwd: target.projectCwd ?? target.cwd },
      );
    }
    return {
      ...permissionsHealth({
        ...requestContext.permissions,
        folders: requestContext.scope.folders,
      }),
      ...(requestContext.restartRequired?.length
        ? { restart_required: requestContext.restartRequired }
        : {}),
      ...(this.events.storeError ? { events: this.events.health() } : {}),
    };
  }
  async search(input, options = {}) {
    const parsed = searchSchema.safeParse(input);
    if (!parsed.success) throw new Error('INVALID_SEARCH_ARGUMENTS');
    const { query, ...args } = parsed.data;
    return this.read(
      { ...args, detail: 'brief', ...(args.view !== 'runtime' ? { preset: 'full' } : {}) },
      { ...options, searchQuery: query },
    );
  }
  async read(args, { requestContext, resultBudget, readPins, searchQuery } = {}) {
    const parsed = readSchema.safeParse(args);
    if (!parsed.success) throw new Error('INVALID_READ_ARGUMENTS');
    args = parsed.data;
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    // Routing metadata only. Cached content is accessed after authorization and
    // today's canonical path/native identity check; a cursor is never a grant.
    const id =
      args.session_id ??
      (args.refs
        ? this.readCache.referenceIdentity(args.refs[0]).session_id
        : this.readCache.identity(args.cursor).session_id);
    let s = await this.session(id, requestContext);
    this.check('read', s, requestContext);
    const identity = {
      session_id: id,
      file: s.file,
      native_id: s.header.id,
      native_cwd: s.header.cwd,
    };
    if (args.refs) {
      const references = args.refs.map((ref) => this.readCache.reference(ref));
      if (references.some((r) => JSON.stringify(r.entry.identity) !== JSON.stringify(identity)))
        throw new Error('INVALID_READ_REFERENCE');
      if (references.some((r) => r.document.request)) {
        if (references.length !== 1) throw new Error('INVALID_READ_REFERENCE');
        return this.read(
          { ...references[0].document.request, max_bytes: args.max_bytes },
          { requestContext, resultBudget, readPins },
        );
      }
      const snapshot = this.readCache.expand(args.refs, identity);
      return this.readCache.render(
        snapshot,
        { max_bytes: args.max_bytes },
        { identity, resultBudget, readPins },
      );
    }
    if (args.cursor) {
      const captured = this.readCache.get(args, identity);
      return this.readCache.render(captured.snapshot, args, {
        ...captured,
        identity,
        resultBudget,
        readPins,
      });
    }
    args = { ...args, session_id: id, detail: args.detail ?? 'brief' };
    let runtime = await this.pool.forRead(s);
    while (runtime && this.handoffs.get(id)?.runtime === runtime) {
      await runtime.autoReleaseTask;
      this.assertOpen();
      s = await this.session(id, requestContext);
      this.check('read', s, requestContext);
      runtime = await this.pool.forRead(s);
    }
    diagnostics.emit('read.source', {
      kind: runtime ? (runtime.attached ? 'attached' : 'rpc') : 'saved',
    });
    let captured,
      retained = false;
    if (args.view === 'runtime') {
      captured =
        runtime?.attached || (runtime instanceof PiRpc && runtime.ownerRecord)
          ? await runtime.read(args)
          : runtime
            ? unavailableObservation(id, 'runtime_observer_unavailable')
            : this.pool.observations.get(s);
      retained = !runtime;
    } else {
      const nativeRead = ({ entry_ids } = {}) =>
        this.acquireNativeRead(s, runtime, {
          ...args,
          view: 'session',
          ...(entry_ids !== undefined ? { entry_ids } : {}),
          ...(searchQuery ? { search_query: searchQuery } : {}),
        });
      const acquire = async () => {
        // Only an explicit view selects a source. Modules assess session-local
        // evidence even without a live owner; reading never starts Pi.
        if (this.compatibilityServices.sessionReaders.readers.size && args.view !== 'session') {
          const context = {
            session: Object.freeze({
              id,
              file: s.file,
              native_id: s.header.id,
              cwd: s.header.cwd,
            }),
            owner: await ownerReadFeatures(runtime),
            request: args,
            nativeRead,
          };
          const reader = await this.compatibilityServices.sessionReaders.select(context);
          if (reader) {
            const result = await captureSessionRead(reader, context, args);
            // Recheck applicability, including an owner that appeared during
            // a saved read. Existing live endpoints also recheck their identity.
            const currentReader = await this.compatibilityServices.sessionReaders.select({
              ...context,
              owner: await ownerReadFeatures(runtime ?? (await this.pool.forRead(s))),
            });
            if (currentReader?.id !== reader.id) throw new Error('READ_SOURCE_CHANGED');
            return result;
          }
        }
        return nativeRead();
      };
      captured = runtime instanceof PiRpc ? await runtime.observeRead(acquire) : await acquire();
    }
    const runtimeObservation = runtime && captured.view === 'runtime' ? captured : null;
    let currentLeaf;
    if (runtimeObservation?.observation.reason === 'no_observation') {
      const previous = this.pool.observations.get(s);
      if (previous.observation.available) {
        currentLeaf = runtimeObservation.observation.current_leaf_id;
        captured = previous;
        retained = true;
      }
    }
    if (retained && captured.observation.available) {
      s = await loadSavedSession(s, { omitImageData: true, config: this.config });
      captured = checkObservation(captured, runtime ? { ...s, leafId: currentLeaf } : s, {
        ownerActive: false,
      });
    }
    const current = await this.session(id, requestContext);
    if (
      current.file !== identity.file ||
      current.header.id !== identity.native_id ||
      current.header.cwd !== identity.native_cwd
    )
      throw new Error('RUNTIME_SESSION_CHANGED');
    this.check('read', current, requestContext);
    if (
      runtimeObservation &&
      runtime?.alive &&
      !runtime.handoffPending &&
      this.pool.instances.get(id) === runtime
    )
      this.pool.observations.put(current, runtimeObservation, runtime);
    const live = searchQuery ? null : captured.live,
      snapshot = {
        session_id: id,
        view: captured.view,
        ...(captured.observation ? { observation: captured.observation } : {}),
        ...(captured.reader ? { reader: captured.reader } : {}),
        request: args,
        detail: args.detail,
        leaf_id: captured.leaf_id,
        selection: captured.selection,
        omissions: captured.omissions,
        ...(captured.history ? { history: captured.history } : {}),
        units: captured.units,
        source: retained
          ? 'retained'
          : runtime
            ? runtime.attached
              ? runtime.record.kind
              : 'rpc'
            : 'saved',
      };
    const events =
      !searchQuery &&
      (runtime?.runtimeEvents ?? this.pool.runtimeEvents.get(id))?.snapshot(
        Math.min(4096, Math.floor((args.max_bytes ?? 24000) / 4)),
      );
    const renderOptions = {
      identity,
      resultBudget,
      live,
      runtimeEvents: events,
      readPins,
    };
    return args.detail === 'brief'
      ? this.readCache.navigate(snapshot, args, renderOptions, searchQuery)
      : this.readCache.render(snapshot, args, renderOptions);
  }
  async acquireNativeRead(session, runtime, args) {
    if (runtime?.attached || (runtime instanceof PiRpc && runtime.ownerRecord))
      return runtime.read(args);
    if (runtime) {
      const active = await runtime.entries();
      if (
        !active.entries.every((entry) => typeof entry.id === 'string' && entry.id.length <= 128) ||
        !(
          active.leafId === null ||
          (typeof active.leafId === 'string' && active.leafId.length <= 128)
        )
      )
        throw new Error('INVALID_RUNTIME_ENTRIES');
      session = { ...session, entries: active.entries, leafId: active.leafId, live: active.live };
    } else session = await loadSavedSession(session, { omitImageData: true, config: this.config });
    return prepareContextRead(session, args, {
      ...(await nativeSdk(this.config, launchProfile(this.config).env)),
      readAdapters: this.compatibilityServices.readInputs.snapshot(),
    });
  }
  async #setModel(args, { requestContext, markForAutoRelease } = {}) {
    requestContext = await (requestContext ?? this.captureRequestContext());
    const target = await this.session(args.session_id, requestContext);
    this.check('send', target, requestContext);
    return this.locked(target.id, async () => {
      let runtime;
      const authorized = async () => {
        this.assertOpen();
        if (this.handoffs.has(target.id) && this.handoffs.get(target.id).kind !== 'auto_release')
          throw new Error('HANDOFF_PENDING');
        const current = await this.session(target.id, requestContext);
        if (
          current.file !== target.file ||
          current.header.id !== target.header.id ||
          current.header.cwd !== target.header.cwd
        )
          throw new Error('RUNTIME_SESSION_CHANGED');
        this.check('send', current, requestContext);
      };
      await authorized();
      runtime = await this.pool.forRead(target);
      if (!runtime) {
        await validateExecutionCwd(target.cwd);
        await loadSavedSession(target, { config: this.config });
        await authorized();
        runtime = await this.pool.resolve(target);
        markForAutoRelease(runtime);
      }
      await authorized();
      const actual = await runtime.selectModel(args.model, {
        thinkingLevel: args.thinking_level,
        nativeThinking: true,
        beforeDispatch: authorized,
      });
      await authorized();
      return modelSettings(actual);
    });
  }
  async #send(args, { requestContext, markForAutoRelease, pendingInput } = {}) {
    if (!SEND_MODES.includes(args.mode ?? 'default')) throw new Error('INVALID_ARGUMENTS');
    return this.withInput(args.session_id, pendingInput, async (beforeDispatch) => {
      requestContext = await (requestContext ?? this.captureRequestContext());
      this.assertOpen();
      const input = promptInput(args);
      const body = input === undefined ? undefined : { ...input, mode: args.mode ?? 'default' };
      let target;
      try {
        target = await this.session(args.session_id, requestContext);
      } catch {
        return {
          status: 'rejected',
          reason: 'NOT_FOUND_OR_DENIED',
        };
      }
      if (!permitted(requestContext.permissions, 'send', target))
        return {
          status: 'rejected',
          reason: 'NOT_FOUND_OR_DENIED',
        };
      return this.mutationLock(args.session_id, 'send', requestContext, async () => {
        const selection = {};
        const submissionId = this.submissions.start(target.id, 'send');
        const outcome = (receipt) => ({
          ...selection,
          ...(this.submissions.update(submissionId, receipt) ?? receipt),
          submission_id: submissionId,
        });
        let runtime;
        try {
          beforeDispatch();
          const s = await this.session(args.session_id, requestContext);
          this.check('send', s, requestContext);
          // Existing owners remain readable/controllable independently of whether
          // their original working directory still exists. Only a new execution
          // needs a validated directory and a valid saved transcript.
          runtime = await this.pool.forRead(s);
          if (!runtime) {
            await validateExecutionCwd(s.cwd);
            await loadSavedSession(s, { config: this.config });
            runtime = await this.pool.resolve(s);
            markForAutoRelease(runtime);
          }
          const authorized = beforeDispatch;
          await authorized();
          if (runtime.attached)
            return outcome(
              attachedPromptResult(
                await runtime.send({ ...args, ...body, beforeDispatch: authorized }),
              ),
            );
          if (hasPromptSettings(body) && body.mode === 'idle_only') {
            const idle = await runtime.idleSnapshot();
            if (idle.status === 'busy')
              return outcome({ ...selection, status: 'skipped', reason: 'busy' });
            if (idle.status !== 'idle') throw new Error('MODEL_SELECTION_IDLE_UNCONFIRMED');
          }
          if (hasPromptSettings(body)) {
            const actual = await runtime.selectModel(body.model, {
              thinkingLevel: body.thinking_level,
              idle: true,
              beforeDispatch: authorized,
            });
            selection.model_selection = {
              model: actual.model,
              thinking_level: actual.thinking_level,
            };
            await authorized();
          }
          if (body.mode === 'idle_only') {
            const state = await runtime.state();
            if (
              runtime.promptAdmission ||
              state.isStreaming ||
              state.isCompacting ||
              state.isIdle === false ||
              state.pendingMessageCount > 0
            )
              return outcome({ ...selection, status: 'skipped', reason: 'busy' });
          }
          await authorized();
          const command = {
            id: submissionId,
            type: 'prompt',
            message: body.text,
            ...(body.images ? { images: body.images } : {}),
            // Native admission must also refuse a hook that turns busy after selection.
            ...promptOptions(hasPromptSettings(body) ? 'idle_only' : body.mode),
          };
          const late = (result) => this.submissions.update(submissionId, promptResult(result));
          if (!runtime.modelMutation && !runtime.compactionMutation && !runtime.promptAdmission)
            markForAutoRelease(runtime);
          const result = await runtime.command(command, undefined, late, () =>
            beforePromptDispatch(runtime, body, selection, authorized),
          );
          return outcome({ ...selection, ...promptResult({ ok: true, data: result }) });
        } catch (e) {
          return outcome({
            ...selection,
            ...promptResult({
              ok: false,
              code: safeReason(e),
              uncertain: e.uncertain,
            }),
          });
        }
      });
    });
  }
  async #command(args, { requestContext, resultBudget, markForAutoRelease, pendingInput } = {}) {
    return this.withInput(args.session_id, pendingInput, async (checkInput) => {
      requestContext = await (requestContext ?? this.captureRequestContext());
      this.assertOpen();
      const session = await this.session(args.session_id, requestContext);
      this.check('command', session, requestContext);
      let output;
      const receipt = await (async () => {
        if (this.locks.has(`bash:${session.id}`))
          return { status: 'rejected', reason: 'BASH_IN_PROGRESS' };
        return this.locked(`bash:${session.id}`, async () => {
          let generation;
          try {
            if (this.handoffs.get(session.id)?.kind === 'auto_release')
              await this.pool.instances.get(session.id)?.autoReleaseTask;
            const beforeDispatch = async () => {
              checkInput();
              if (this.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
            };
            await beforeDispatch();
            let runtime = await this.pool.forRead(session);
            if (!runtime) {
              await validateExecutionCwd(session.cwd);
              await loadSavedSession(session, { config: this.config });
              runtime = await this.pool.resolve(session);
            }
            markForAutoRelease(runtime);
            await beforeDispatch();
            if (typeof runtime.executeBash !== 'function') throw new Error('BASH_UNSUPPORTED');
            generation = runtime.generation ?? runtime.record?.generation ?? null;
            output = inlineBashResult(await runtime.executeBash({ ...args, beforeDispatch }));
            return { status: 'accepted', generation };
          } catch (error) {
            if (error.result) output = inlineBashResult(error.result);
            return {
              status: error.uncertain ? 'unknown' : 'rejected',
              reason: safeReason(error),
              ...(generation ? { generation } : {}),
            };
          }
        });
      })();
      return output
        ? bashOutput(receipt, output, args, resultBudget)
        : { ...receipt, output_available: false };
    });
  }
  async #stop(args, { requestContext, resultBudget, retainedInputs } = {}) {
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const session = await this.session(args.session_id, requestContext);
    this.check('stop', session, requestContext);
    let withdrawn;
    const receipt = await this.mutationLock(
      session.id,
      'stop',
      requestContext,
      async () => {
        let generation;
        try {
          this.assertOpen();
          for (const input of this.inputs)
            if (input.sessionId === session.id && !retainedInputs?.has(input)) input.stopped = true;
          if (this.handoffs.get(session.id)?.kind === 'auto_release')
            return { status: 'skipped', reason: 'not_running' };
          const runtime = await this.pool.forRead(session);
          this.assertOpen();
          if (!runtime) return { status: 'skipped', reason: 'not_running' };
          if (typeof runtime.stopExecution !== 'function') throw new Error('STOP_UNSUPPORTED');
          generation = runtime.generation ?? runtime.record?.generation ?? null;
          if (this.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
          const result = await runtime.stopExecution(args);
          withdrawn = inlineWithdrawal(result.withdrawal);
          return { ...stopReceipt(result), generation };
        } catch (error) {
          if (error.result?.withdrawal) withdrawn = inlineWithdrawal(error.result.withdrawal);
          return {
            status: error.uncertain ? 'unknown' : 'rejected',
            reason: safeReason(error),
            ...(generation ? { generation } : {}),
          };
        }
      },
      `stop:${session.id}`,
    );
    if (receipt.status === 'skipped')
      withdrawn = { text: '', includesEditorDraft: false, complete: true };
    return withdrawn
      ? withdrawalOutput(receipt, withdrawn, args, resultBudget)
      : { ...receipt, withdrawn_available: false };
  }
  async #create(args, { requestContext, markForAutoRelease } = {}) {
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const folder = requestContext.scope.folders.find((folder) => folder.path === args.project);
    if (!folder || !permitted(requestContext.permissions, 'create', { cwd: folder.path }))
      return {
        status: 'rejected',
        reason: 'NOT_FOUND_OR_DENIED',
      };
    const input = promptInput(args);
    let child,
      submissionId,
      created = false;
    const selection = {};
    const outcome = (send) => {
      if (submissionId) send = this.submissions.update(submissionId, send) ?? send;
      return {
        status: send.status,
        created,
        session_id: child?.id,
        ...(submissionId ? { submission_id: submissionId } : {}),
        send: { ...selection, ...send },
      };
    };
    try {
      await validateExecutionCwd(folder.path);
      let parent, snapshot;
      if (args.fork_from) {
        parent = await this.session(args.fork_from, requestContext);
        this.check('read', parent, requestContext);
        let runtime = await this.pool.forRead(parent);
        while (runtime && this.handoffs.get(parent.id)?.runtime === runtime) {
          await runtime.autoReleaseTask;
          this.assertOpen();
          parent = await this.session(args.fork_from, requestContext);
          this.check('read', parent, requestContext);
          runtime = await this.pool.forRead(parent);
        }
        if (runtime?.attached) {
          if (typeof runtime.snapshot !== 'function') throw new Error('SNAPSHOT_UNSUPPORTED');
          snapshot = await runtime.snapshot();
        } else
          snapshot = runtime
            ? await runtime.entries()
            : await loadSavedSession(parent, { config: this.config });
      }
      child = await prepareSession({ ...this.config, ...requestContext.scope }, folder.path, {
        name: args.name,
        parent,
        snapshot,
      });
      // Keep the chosen child identity in partial failure responses.

      this.assertOpen();
      return await this.locked(child.id, () =>
        this.withInput(child.id, this.registerInput(child.id), async (checkInput) => {
          const beforeDispatch = async () => {
            checkInput();
            if (this.handoffs.has(child.id)) throw new Error('HANDOFF_PENDING');
          };
          await beforeDispatch();
          await persistSession(child);
          created = true;
          submissionId = this.submissions.start(child.id, 'create');

          const runtime = await this.pool.resolve(child);
          markForAutoRelease(runtime);
          await beforeDispatch();
          if (runtime.attached) throw new Error('RUNTIME_SESSION_CHANGED');
          if (hasPromptSettings(input)) {
            const actual = await runtime.selectModel(input.model, {
              thinkingLevel: input.thinking_level,
              idle: true,
              beforeDispatch,
            });
            selection.model_selection = {
              model: actual.model,
              thinking_level: actual.thinking_level,
            };
            await beforeDispatch();
          }
          const onLate = (result) => this.submissions.update(submissionId, promptResult(result));
          const result = await runtime.command(
            {
              id: submissionId,
              type: 'prompt',
              message: input.text,
              ...(input.images ? { images: input.images } : {}),
              ...promptOptions(hasPromptSettings(input) ? 'idle_only' : 'default'),
            },
            undefined,
            onLate,
            () => beforePromptDispatch(runtime, input, selection, beforeDispatch),
          );
          return outcome(promptResult({ ok: true, data: result }));
        }),
      );
    } catch (error) {
      if (error.sessionPublished) created = true;
      const result = promptResult({
        ok: false,
        code: safeReason(error),
        uncertain: error.uncertain,
      });
      return child ? outcome(result) : result;
    }
  }
  async #delete(args, { requestContext, resultBudget } = {}) {
    requestContext = await (requestContext ?? this.captureRequestContext());
    this.assertOpen();
    const target = await this.session(args.session_id, requestContext).catch(() => null);
    if (
      !permitted(
        requestContext.permissions,
        'delete',
        target ?? {
          id: args.session_id,
          cwd: null,
        },
      )
    )
      return {
        status: 'rejected',
        reason: 'NOT_FOUND_OR_DENIED',
      };
    // Delete has its own serialization lane: a normal EOF/handoff may hold
    // the session lane indefinitely. Fence new work before interrupting that
    // lifecycle, then drain the session lane before moving the saved history.
    return this.locked(`delete:${args.session_id}`, async () => {
      let trash, release, failure;
      const marker = { kind: 'delete' };
      try {
        const s = await this.session(args.session_id, requestContext);
        this.check('delete', s, requestContext);
        trash = await prepareTrash(this.config, s);
        const prior = this.handoffs.get(s.id);
        this.handoffs.set(s.id, marker);
        prior?.controller?.abort();
        // One session-wide deletion gate covers termination, lane drain and
        // the trash move. Do not reselect a writer in a second termination pass.
        release = await this.pool.stopForDelete(s);
        await this.locked(s.id, async () => {
          const current = await this.session(s.id, requestContext);
          if (current.file !== s.file || current.header.cwd !== s.header.cwd)
            throw new Error('RUNTIME_SESSION_CHANGED');
          await trash.move();
        });
      } catch (error) {
        failure = error;
      } finally {
        try {
          await trash?.cancel().catch(() => {});
          await release?.(trash?.moved === true);
        } catch (error) {
          failure ??= error;
        } finally {
          if (this.handoffs.get(args.session_id) === marker) this.handoffs.delete(args.session_id);
        }
      }
      return optionalResultFields(
        {
          status: failure ? (trash?.moved ? 'unknown' : 'rejected') : 'deleted',
          ...(failure ? { reason: safeReason(failure) } : {}),
          ...(trash?.moved ? { recoverable: true, restore_token: trash.token } : {}),
        },
        { project: target?.projectCwd ?? target?.cwd ?? null },
        resultBudget,
      );
    });
  }
  settledForLocal(request) {
    this.assertOpen();
    const runtime = this.pool.instances.get(request.session_id);
    if (
      !(runtime instanceof PiRpc) ||
      !runtime.alive ||
      request.generation !== runtime.ownerRecord?.generation ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence <= (runtime.completionSequence ?? 0) ||
      !(
        request.leafId === null ||
        (typeof request.leafId === 'string' &&
          request.leafId.length > 0 &&
          request.leafId.length <= 128)
      ) ||
      typeof request.aborted !== 'boolean' ||
      !settledResultSchema.safeParse(request.result).success ||
      typeof request.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(request.timestamp))
    )
      throw new Error('INVALID_OWNER_COMMAND');
    runtime.completionSequence = request.sequence;
    this.events.observe(runtime.session, request);
    return {};
  }
  handoffForLocal(request, options) {
    return idleHandoff(this, request, options);
  }
  cancelHandoff(request) {
    return cancelHandoff(this, request);
  }
  inputActivityForLocal(request) {
    this.assertOpen();
    const runtime =
      this.pool.instances.get(request.session_id) ??
      this.pool.starting.get(request.session_id)?.runtime;
    if (
      !(runtime instanceof PiRpc) ||
      !runtime.alive ||
      request.generation !== runtime.ownerRecord?.generation
    )
      throw new Error('INVALID_OWNER_COMMAND');
    runtime.observeInputActivity(request);
    return {};
  }
  async releaseForLocal({ session_id, interrupt = false }) {
    this.assertOpen();
    if (typeof interrupt !== 'boolean') throw new Error('INVALID_OWNER_COMMAND');
    if (this.handoffs.get(session_id)?.kind === 'delete') throw new Error('HANDOFF_PENDING');
    // EOF can be held indefinitely by a native shutdown hook. Interrupt must
    // reach that exact closing child without waiting behind its session lane.
    const closing = this.pool.instances.get(session_id);
    if (interrupt && closing instanceof PiRpc && closing.gracefulExitPromise && !closing.exited) {
      await closing.assertProcessIdentity();
      await updateOwner(this.pool.attachmentDir, closing.session, closing.ownerRecord, {
        noColdReacquire: true,
      });
      await closing.stop();
      return { session_id, status: 'released', no_cold_reacquire: true };
    }
    if (this.handoffs.get(session_id)?.kind === 'auto_release') await closing?.autoReleaseTask;
    if (this.handoffs.has(session_id)) throw new Error('HANDOFF_PENDING');
    const priorStop = this.locks.get(`stop:${session_id}`),
      release = { kind: 'release', controller: new AbortController() };
    this.handoffs.set(session_id, release);
    try {
      return await this.locked(session_id, async () => {
        // An admitted stop finishes its receipt capture before owner shutdown.
        await priorStop?.catch(() => {});
        this.assertOpen();
        release.controller.signal.throwIfAborted();
        const owned = this.pool.instances.get(session_id);
        let session;
        // Missing history must not strand a child we already own. Existing
        // replacement or unsafe files still require normal identity discovery.
        if (
          owned instanceof PiRpc &&
          owned.alive &&
          (await assertSingleSessionFile(owned.session.file, { allowMissing: true })) === null
        ) {
          await owned.assertProcessIdentity();
          session = owned.session;
        } else session = await this.session(session_id);
        const dir = this.pool.attachmentDir;
        if (this.pool.starting.has(session_id)) throw new Error('RUNTIME_IDLE_UNCONFIRMED');
        const runtime = await this.pool.forRead(session);
        if (runtime?.attached) throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
        let exitDetails = {};
        if (runtime) {
          if (!(runtime instanceof PiRpc)) throw new Error('BRIDGE_OWNED_RUNTIME_REQUIRED');
          runtime.handoffPending = true;
          const previousNoCold = runtime.ownerRecord?.noColdReacquire === true;
          try {
            if (interrupt) {
              await runtime.state();
              await runtime.assertProcessIdentity();
            } else await runtime.assertReleasable();
            await runtime.drainAcks();
            release.controller.signal.throwIfAborted();
            await updateOwner(dir, session, runtime.ownerRecord, { noColdReacquire: true });
            if (interrupt) await this.pool.stop(session_id);
            else {
              exitDetails = await runtime.gracefulExit(release.controller.signal);
              this.pool.instances.delete(session_id);
            }
          } catch (error) {
            if (
              error.code === 'RUNTIME_BUSY' &&
              !runtime.gracefulExitPromise &&
              runtime.ownerRecord &&
              (runtime.ownerRecord.noColdReacquire === true) !== previousNoCold
            )
              await updateOwner(dir, session, runtime.ownerRecord, {
                noColdReacquire: previousNoCold,
              });
            throw error;
          } finally {
            if (!runtime.gracefulExitPromise && !runtime.stopPromise)
              runtime.handoffPending = false;
          }
        } else
          await registryTransaction(dir, async () => {
            const current = await readClaim(dir, session);
            if (current && (await ownerAlive(current.owner)))
              throw new Error('LIVE_OWNER_UNREACHABLE');
            release.controller.signal.throwIfAborted();
            await atomicJson(claimFile(dir, session), {
              kind: 'rpc',
              file: session.file,
              sessionId: session.header.id,
              generation: current?.generation ?? randomUUID(),
              owner: null,
              phase: 'released',
              noColdReacquire: true,
            });
          });
        return { session_id, status: 'released', no_cold_reacquire: true, ...exitDetails };
      });
    } finally {
      if (this.handoffs.get(session_id) === release) this.handoffs.delete(session_id);
    }
  }
  async resetColdResume({ session_id, confirm_local_closed }) {
    this.assertOpen();
    if (confirm_local_closed !== true) throw new Error('LOCAL_CLOSE_CONFIRMATION_REQUIRED');
    return this.locked(session_id, async () => {
      this.assertOpen();
      const session = await this.session(session_id),
        dir = this.pool.attachmentDir;
      await registryTransaction(dir, async () => {
        const current = await readClaim(dir, session);
        if (current && (await ownerAlive(current.owner))) throw new Error('OWNER_STILL_ALIVE');
        // This confirms cooperative owners only; caller must close unregistered Pi too.
        if (current?.noColdReacquire) await fs.unlink(claimFile(dir, session));
      });
      return { session_id, status: 'reset', no_cold_reacquire: false };
    });
  }
  assertOpen() {
    if (this.closing) throw new Error('BRIDGE_CLOSING');
  }
  prepareClose() {
    // Freeze business admission before transport drain: already-dispatched
    // work finishes, queued mutations cannot start another writer.
    this.closing = true;
    return (this.closePreparation ??= Promise.all([
      this.pool.prepareClose?.(),
      this.ownerControl?.close(),
      this.events.close(),
    ]));
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.readCache.clear();
    this.closePromise = (async () => {
      await this.prepareClose();
      while (this.pendingMutations.size) await Promise.allSettled([...this.pendingMutations]);
      await this.pool.drainAcks?.();
      await this.pool.close();
      await Promise.allSettled([...this.autoReleases]);
      // Modules remain active until writers, ACKs and release captures drain.
      try {
        await this.compatibility.stop();
      } finally {
        if (this.lock) {
          await this.lock.close();
          this.lock = null;
        }
      }
    })();
    return this.closePromise;
  }
}
async function beforePromptDispatch(runtime, input, selection, authorize) {
  if (hasPromptSettings(input)) {
    const current = await runtime.state();
    assertPromptSelection(input, current);
    selection.model_selection = modelSettings({
      model: current.model,
      thinking_level: current.thinkingLevel,
    });
  }
  // Native selection can change locally while observations are awaited. Check
  // Stop/handoff admission last; never restore a model to make preflight pass.
  await authorize();
}
function safeReason(error) {
  const code = publicError(error);
  diagnostics.emit('operation.failure', { code, uncertain: error.uncertain === true });
  return code;
}
