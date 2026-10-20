import fs from 'node:fs/promises';
import path from 'node:path';
import { compactSchema, compactReceipt } from './compact.mjs';
import { reloadSchema, reopenOwned } from './reload.mjs';
import { setModelSchema, sameModel } from './models.mjs';
import { randomUUID } from 'node:crypto';
import { readSchema } from './read-schema.mjs';
import { stopSchema, bashSchema } from './tool-schemas.mjs';
import { isDeepStrictEqual } from 'node:util';
import { permitted, permissionWarnings } from './permissions.mjs';
import { sessionMetadata, runtimeStatus } from './session-metadata.mjs';
import { prepareSession, persistSession } from './create-session.mjs';
import { SEND_MODES, promptInput, assertImageModel } from './prompt-input.mjs';
import { renderContextRead } from './context-read.mjs';
import { discover, readSessionIdentity, loadSavedSession, validateExecutionCwd } from './data.mjs';
import { hash, atomicJson } from './storage.mjs';
import { stopReceipt, recoveredWithdrawal, withdrawalPage } from './stop-execution.mjs';
import { bashOutputPage, recoveredBash } from './bash-execution.mjs';
import { PiRpc, RuntimePool } from './rpc.mjs';
import { Journal } from './journal.mjs';
import {
  privateDirectory,
  readClaim,
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
export class Bridge {
  constructor(config, factory, { configFile } = {}) {
    this.config = config;
    this.configFile = configFile;
    const { grants, defaults, ...settings } = config;
    this.ownerSettings = structuredClone(settings);
    this.pool = new RuntimePool(config, factory);
    this.journal = new Journal(config);
    this.locks = new Map();
    this.handoffs = new Map();
    this.inputs = new Set();
    this.sessionFiles = new Map();
    this.titleCache = new Map();
  }
  async init() {
    validateOwnerConfig(this.config);
    await privateDirectory(this.pool.attachmentDir);
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(this.config.stateDir)) !== path.resolve(this.config.stateDir))
      throw new Error('SYMLINK_STATE_NOT_ALLOWED');
    for (const root of this.config.sessionRoots) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(root)) !== path.resolve(root))
        throw new Error('SYMLINK_ROOT_NOT_ALLOWED');
    }
    // Configured execution directories may be offline while saved history is
    // still accessible. Create and cold resume validate their cwd on demand.
    // One bridge process per state directory. Do not automatically steal stale locks.
    this.lockPath = path.join(this.config.stateDir, 'bridge.lock');
    this.lock = await fs.open(this.lockPath, 'wx', 0o600);
    await this.lock.writeFile(`${process.pid}\n`);
    try {
      this.ownerControl = await serveOwnerControl(this);
    } catch (error) {
      await this.lock.close();
      await fs.unlink(this.lockPath);
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
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async withInput(sessionId, fn) {
    // Keep cancellation on this request across permission, receipt and state I/O.
    // A completed stop must not revive input that has not reached Pi yet.
    const input = { sessionId, stopped: this.locks.has(`stop:${sessionId}`) };
    this.inputs.add(input);
    const beforeDispatch = () => {
      this.assertOpen();
      if (input.stopped || this.locks.has(`stop:${sessionId}`)) throw new Error('STOP_IN_PROGRESS');
    };
    try {
      return await fn(beforeDispatch);
    } finally {
      this.inputs.delete(input);
    }
  }
  async sessions() {
    const sessions = await diagnostics.measure('session.discover', {}, () => discover(this.config));
    this.sessionFiles = new Map(sessions.map((s) => [s.id, s.file]));
    return sessions;
  }
  async mutationLock(id, action, save, fn, lockId = id) {
    const blockedReason = () =>
      this.handoffs.has(id)
        ? 'HANDOFF_PENDING'
        : action === 'send' && this.locks.has(`stop:${id}`)
          ? 'STOP_IN_PROGRESS'
          : null;
    const blocked = async (reason) => {
      try {
        this.check(action, await this.session(id));
        return save({ status: 'rejected', reason });
      } catch (error) {
        return save({ status: 'rejected', reason: safeReason(error) });
      }
    };
    const reason = blockedReason();
    if (reason) return blocked(reason);
    return this.locked(lockId, () => {
      const reason = blockedReason();
      return reason ? blocked(reason) : fn();
    });
  }
  async refreshPermissions() {
    if (!this.configFile) return;
    const task = diagnostics.measure('permission.reload', {}, () =>
      (this.permissionsReload ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const { config } = await readOwnerConfig(this.configFile);
          const { grants, defaults, ...settings } = config;
          if (!isDeepStrictEqual(settings, this.ownerSettings))
            throw new Error('CONFIG_RESTART_REQUIRED');
          this.config.grants = grants ?? [];
          this.config.defaults = defaults ?? {};
        }),
    );
    this.permissionsReload = task;
    try {
      await task;
    } finally {
      if (this.permissionsReload === task) this.permissionsReload = null;
    }
  }
  async session(id) {
    const file = this.sessionFiles.get(id);
    if (file) {
      const current = await readSessionIdentity(file).catch(() => null);
      if (current?.id === id) return current;
      this.sessionFiles.delete(id);
    }
    const s = (await this.sessions()).find((s) => s.id === id);
    if (!s) throw new Error('NOT_FOUND_OR_DENIED');
    return s;
  }
  check(action, s) {
    const allowed = permitted(this.config, action, s);
    diagnostics.emit('permission.check', { op: action, allowed });
    if (!allowed) throw new Error('NOT_FOUND_OR_DENIED');
  }
  async models(args) {
    this.assertOpen();
    if (this.configFile) await this.refreshPermissions();
    const session = await this.session(args.session_id);
    this.check('send', session);
    const inspect = async () => {
      if (this.configFile) await this.refreshPermissions();
      this.check('send', session);
      if (args.start && this.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
      let runtime = await this.pool.forRead(session);
      if (!runtime && args.start) {
        await validateExecutionCwd(session.cwd);
        await loadSavedSession(session);
        runtime = await this.pool.resolve(session);
      }
      const page = runtime
        ? await runtime.models(args)
        : {
            source: 'inactive',
            availability: 'unknown',
            current: null,
            models: null,
            total: null,
            next_offset: null,
          };
      if (this.configFile) await this.refreshPermissions();
      this.check('send', session);
      return {
        session_id: session.id,
        ...page,
        model_selection: !runtime
          ? 'unknown'
          : !runtime.attached || runtime.record.modelSelectionSupported === true
            ? 'session'
            : 'unsupported',
        prompt_model_selection: !runtime
          ? 'unknown'
          : !runtime.attached
            ? 'idle_only_session'
            : 'unsupported',
      };
    };
    return args.start ? this.locked(session.id, inspect) : inspect();
  }
  async set_model(args) {
    if (!setModelSchema.safeParse(args).success) throw new Error('INVALID_MODEL_ARGUMENTS');
    return this.withInput(args.session_id, async (checkInput) => {
      this.assertOpen();
      if (this.configFile) await this.refreshPermissions();
      const session = await this.session(args.session_id);
      this.check('send', session);
      const body =
        args.model !== undefined || args.thinking_level !== undefined
          ? { model: args.model, thinking_level: args.thinking_level }
          : undefined;
      return this.journal.run(args.request_id, 'set_model', session.id, body, (save) =>
        this.mutationLock(session.id, 'send', save, async () => {
          try {
            let runtime = await this.pool.forRead(session);
            if (!runtime) {
              await validateExecutionCwd(session.cwd);
              await loadSavedSession(session);
              checkInput();
              runtime = await this.pool.resolve(session);
            }
            if (this.configFile) await this.refreshPermissions();
            const authorized = async () => {
              if (this.configFile) await this.refreshPermissions();
              checkInput();
              this.check('send', session);
            };
            await authorized();
            if (runtime.attached)
              return await save(await runtime.set_model({ ...args, beforeDispatch: authorized }));
            const configured = await runtime.selectModel(args.model, {
              thinkingLevel: args.thinking_level,
              timeout: args.timeout_ms ?? 5000,
              beforeDispatch: authorized,
              onLate: async (result) => {
                if (!result.ok) return save({ status: 'rejected', reason: result.code });
                const current = await runtime.state();
                if (!sameModel(current.model, result.selected_model))
                  return save({ status: 'unknown', reason: 'MODEL_SELECTION_CHANGED' });
                if (result.phase === 'model' && args.thinking_level !== undefined)
                  return save({
                    status: 'rejected',
                    reason: 'MODEL_SELECTED_THINKING_NOT_SET',
                    model: result.selected_model,
                    thinking_level: current.thinkingLevel ?? null,
                    thinking_adjustment: 'unknown',
                    scope: 'session',
                  });
                return save({
                  status: 'accepted',
                  model: result.selected_model,
                  thinking_level: current.thinkingLevel ?? null,
                  thinking_adjustment: 'unknown',
                  scope: 'session',
                });
              },
            });
            return await save({ status: 'accepted', ...configured, scope: 'session' });
          } catch (error) {
            return save({
              status: error.uncertain ? 'unknown' : 'rejected',
              reason: safeReason(error),
            });
          }
        }),
      );
    });
  }
  async reload(args) {
    if (!reloadSchema.safeParse(args).success) throw new Error('INVALID_RELOAD_ARGUMENTS');
    return this.withInput(args.session_id, async (checkInput) => {
      const session = await this.session(args.session_id);
      const authorize = async () => {
        if (this.configFile) await this.refreshPermissions();
        checkInput();
        this.check('send', session);
      };
      await authorize();
      // A lookup of an in-progress request observes its durable phase immediately.
      // It does not enqueue another reopen, even after a caller's timeout.
      if (await this.journal.get(args.request_id))
        return this.journal.execute(args.request_id, 'reload', session.id, {}, undefined);
      const work = this.journal.run(args.request_id, 'reload', session.id, {}, (save) =>
        this.mutationLock(session.id, 'send', save, async () => {
          try {
            return await reopenOwned(this, session, save, authorize);
          } catch (error) {
            return save({
              status: error.uncertain ? 'unknown' : 'rejected',
              ...error.reload_details,
              reason: safeReason(error),
            });
          }
        }),
      );
      let timer;
      try {
        return await Promise.race([
          work,
          new Promise((resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  request_id: args.request_id,
                  operation: 'reload',
                  status: 'unknown',
                  method: 'rpc_reopen',
                  session_id: session.id,
                  reason: 'ACK_TIMEOUT',
                }),
              args.timeout_ms ?? 5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
  }
  async compact(args) {
    if (
      !compactSchema.safeParse(args).success ||
      (args.recover && (args.instructions !== undefined || args.interrupt !== undefined))
    )
      throw new Error('INVALID_COMPACT_ARGUMENTS');
    return this.withInput(args.session_id, async (checkInput) => {
      this.assertOpen();
      if (this.configFile) await this.refreshPermissions();
      const session = await this.session(args.session_id);
      this.check('send', session);
      // Recovery of an interrupting call still requires its original grant.
      const prior = await this.journal.get(args.request_id);
      if (args.interrupt || prior?.receipt.interrupt_requested) this.check('stop', session);
      const body = args.recover
        ? undefined
        : { instructions: args.instructions ?? '', interrupt: args.interrupt ?? false };
      return this.journal.run(args.request_id, 'compact', session.id, body, (persist) => {
        const save = (result) => persist({ interrupt_requested: body.interrupt, ...result });
        return this.mutationLock(session.id, 'send', save, async () => {
          try {
            await save({ status: 'unknown' });
            let runtime = await this.pool.forRead(session);
            if (runtime?.attached) throw new Error('COMPACT_UNSUPPORTED');
            if (!runtime) {
              await validateExecutionCwd(session.cwd);
              await loadSavedSession(session);
              checkInput();
              runtime = await this.pool.resolve(session);
            }
            if (!body.interrupt)
              await runtime.assertIdle({
                busy: 'COMPACT_BUSY',
                unconfirmed: 'COMPACT_IDLE_UNCONFIRMED',
              });
            if (this.configFile) await this.refreshPermissions();
            const authorized = async () => {
              if (this.configFile) await this.refreshPermissions();
              checkInput();
              this.check('send', session);
              if (body.interrupt) this.check('stop', session);
            };
            await authorized();
            const late = (result) =>
              save(
                result.ok
                  ? compactReceipt(result.data)
                  : {
                      status: 'rejected',
                      reason: result.code,
                      native_effects: 'native_compact_attempted',
                    },
              );
            const result = await runtime.command(
              { type: 'compact', customInstructions: body.instructions },
              args.timeout_ms ?? 5000,
              late,
              authorized,
            );
            return await save(compactReceipt(result));
          } catch (error) {
            return save({
              status: error.uncertain ? 'unknown' : 'rejected',
              reason: safeReason(error),
              native_effects:
                error.code === 'PI_REJECTED' || error.uncertain
                  ? 'native_compact_attempted'
                  : 'none',
            });
          }
        });
      });
    });
  }
  async list(args = {}) {
    this.assertOpen();
    if (this.configFile) await this.refreshPermissions();
    const sessions = args.session_id
      ? await this.session(args.session_id).then(
          (s) => [s],
          (error) => {
            if (error.message === 'NOT_FOUND_OR_DENIED') return [];
            throw error;
          },
        )
      : await this.sessions();
    if (args.session_id && sessions[0]?.header.parentSession) {
      const parentId = [...this.sessionFiles].find(
        ([, file]) => file === sessions[0].header.parentSession,
      )?.[0];
      const parent = parentId && (await this.session(parentId).catch(() => null));
      if (parent) sessions.push(parent);
    }
    const matches = (value, query) =>
      !query || (value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
    const candidates = [];
    for (const session of sessions) {
      if (!permitted(this.config, 'list', session)) continue;
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
    for (const candidate of candidates) {
      // With no title filter, earlier pages need no transcript scan at all.
      if (!args.name && matching++ < offset) continue;
      if (!args.name && selected.length === limit) {
        hasMore = true;
        break;
      }
      const session = candidate.session;
      let metadata;
      try {
        metadata = await sessionMetadata(session, this.titleCache);
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
        project: session.header.cwd,
        name: metadata.name,
        parent_session_id: parent && permitted(this.config, 'list', parent) ? parent.id : null,
        last_activity: candidate.last_activity,
        session,
      });
    }
    const page = await Promise.all(
      selected.map(async ({ session, ...row }) => ({
        ...row,
        status: await runtimeStatus(this.pool, session),
      })),
    );
    if (this.configFile) await this.refreshPermissions();
    this.assertOpen();
    return {
      sessions: page
        .filter((row) =>
          permitted(
            this.config,
            'list',
            selected.find((item) => item.session_id === row.session_id).session,
          ),
        )
        .map((row) => {
          const parent = sessions.find((session) => session.id === row.parent_session_id);
          return {
            ...row,
            parent_session_id: parent && permitted(this.config, 'list', parent) ? parent.id : null,
          };
        }),
      next_offset: hasMore ? offset + limit : null,
      projects: this.config.folders
        .filter((folder) => permitted(this.config, 'create', { cwd: folder.path }))
        .map((folder) => folder.path),
    };
  }
  async health({ domain = 'permissions', session_id } = {}) {
    this.assertOpen();
    if (domain !== 'permissions') throw new Error('UNSUPPORTED_HEALTH_DOMAIN');
    if (this.configFile) await this.refreshPermissions();
    // A supplied known ID can be diagnosed without disclosing its metadata or
    // enumerating hidden sessions. Sources name the tier, never a hidden path.
    let session;
    if (session_id) {
      const target = await this.session(session_id).catch(() => ({ id: session_id, cwd: null }));
      const report = permissionWarnings(this.config, { session_id, cwd: target.cwd });
      session = {
        session_id,
        ...report,
        effective: Object.fromEntries(
          Object.entries(report.effective)
            .filter(([action]) => action !== 'create')
            .map(([action, value]) => [
              action,
              {
                allowed: value.allowed,
                explicit: value.explicit,
                source: value.sourceScope?.session_id
                  ? 'session'
                  : value.sourceScope?.folder
                    ? 'project'
                    : 'default',
              },
            ]),
        ),
      };
    }
    return {
      domain,
      status: 'ok',
      ...(session ? { session } : {}),
      defaults: permissionWarnings(this.config),
      projects: this.config.folders.map((folder) => ({
        project: folder.path,
        ...permissionWarnings(this.config, { folder: folder.path }),
      })),
      session_override_count: new Set(
        (this.config.grants ?? []).filter((rule) => rule.session_id).map((rule) => rule.session_id),
      ).size,
      note: 'Warnings are advisory. Permissions remain independent. Supply session_id to diagnose one known session; create is evaluated at project/default scope.',
    };
  }
  async read(args) {
    this.assertOpen();
    if (this.configFile) {
      await this.refreshPermissions();
      this.assertOpen();
    }
    let s = await this.session(args.session_id);
    this.check('read', s);
    if (!readSchema.safeParse(args).success) throw new Error('INVALID_READ_ARGUMENTS');
    const runtime = await this.pool.forRead(s);
    diagnostics.emit('read.source', {
      kind: runtime ? (runtime.attached ? 'attached' : 'rpc') : 'saved',
    });
    if (runtime?.attached) {
      const result = await runtime.read(args);
      if (this.configFile) await this.refreshPermissions();
      this.check('read', s);
      return result;
    }
    if (runtime) {
      const active = await runtime.entries();
      if (
        active.entries.some((e) => typeof e.id !== 'string' || e.id.length > 128) ||
        (active.leafId !== null &&
          (typeof active.leafId !== 'string' || active.leafId.length > 128))
      )
        throw new Error('INVALID_RUNTIME_ENTRIES');
      s.entries = active.entries;
      s.leafId = active.leafId;
      s.activity = active.activity;
      s.live = active.live;
    }
    if (!runtime) s = await loadSavedSession(s);
    const result = renderContextRead(s, args);
    if (this.configFile) await this.refreshPermissions();
    this.check('read', s);
    return result;
  }
  async send(args) {
    if (!SEND_MODES.includes(args.mode ?? 'default')) throw new Error('INVALID_ARGUMENTS');
    return this.withInput(args.session_id, async (beforeDispatch) => {
      this.assertOpen();
      if (this.configFile) {
        await this.refreshPermissions();
        this.assertOpen();
      }
      const input = promptInput(args);
      const body = input === undefined ? undefined : { ...input, mode: args.mode ?? 'default' };
      let target;
      try {
        target = await this.session(args.session_id);
      } catch {
        return {
          request_id: args.request_id,
          operation: 'send',
          status: 'rejected',
          reason: 'NOT_FOUND_OR_DENIED',
        };
      }
      if (!permitted(this.config, 'send', target))
        return {
          request_id: args.request_id,
          operation: 'send',
          status: 'rejected',
          reason: 'NOT_FOUND_OR_DENIED',
        };
      return this.journal.run(args.request_id, 'send', args.session_id, body, (save) =>
        this.mutationLock(args.session_id, 'send', save, async () => {
          const selection = body.model
            ? {
                model_selection: { requested: body.model, scope: 'session', status: 'not_changed' },
              }
            : {};
          try {
            beforeDispatch();
            const s = await this.session(args.session_id);
            this.check('send', s);
            // Existing owners remain readable/controllable independently of whether
            // their original working directory still exists. Only a new execution
            // needs a validated directory and a valid saved transcript.
            let runtime = await this.pool.forRead(s);
            if (!runtime) {
              await validateExecutionCwd(s.cwd);
              await loadSavedSession(s);
              runtime = await this.pool.resolve(s);
            }
            const authorized = async () => {
              if (this.configFile) await this.refreshPermissions();
              beforeDispatch();
              this.check('send', s);
            };
            await authorized();
            if (runtime.attached)
              return save(await runtime.send({ ...args, ...body, beforeDispatch: authorized }));
            if (body.model && body.mode === 'idle_only') {
              const state = await runtime.state();
              if (
                runtime.promptAdmission ||
                state.isStreaming ||
                state.isCompacting ||
                state.pendingMessageCount > 0
              )
                return save({ ...selection, status: 'skipped', reason: 'busy' });
            }
            if (body.model) {
              await runtime.selectModel(body.model, {
                images: body.images,
                idle: true,
                timeout: args.timeout_ms ?? 5000,
                beforeDispatch: authorized,
                report: (status) => {
                  selection.model_selection.status = status;
                },
                onLate: (result) => save(modelSelectedWithoutPrompt(result, selection, body.model)),
              });
              await authorized();
            }
            if (body.mode === 'idle_only' || body.images) {
              const state = await runtime.state();
              assertImageModel(body.images, state.model);
              if (
                body.mode === 'idle_only' &&
                (runtime.promptAdmission ||
                  state.isStreaming ||
                  state.isCompacting ||
                  state.isIdle === false ||
                  state.pendingMessageCount > 0)
              )
                return save({ status: 'skipped', reason: 'busy' });
            }
            await authorized();
            const command = {
              type: 'prompt',
              message: body.text,
              ...(body.images ? { images: body.images } : {}),
            };
            command.streamingBehavior = body.mode === 'follow_up' ? 'followUp' : 'steer';
            const late = (result) =>
              save(
                result.ok
                  ? {
                      ...selection,
                      status: 'accepted',
                      disposition: result.data.disposition,
                      completion: 'not_tracked',
                    }
                  : { ...selection, status: 'rejected', reason: result.code },
              );
            const result = await runtime.command(
              command,
              args.timeout_ms ?? 5000,
              late,
              authorized,
            );
            return save({
              ...selection,
              status: 'accepted',
              disposition: result.disposition,
              completion: 'not_tracked',
            });
          } catch (e) {
            return save({
              ...selection,
              status: e.uncertain ? 'unknown' : 'rejected',
              reason: safeReason(e),
            });
          }
        }),
      );
    });
  }
  command(args) {
    return this.bash(args);
  }
  async bash(args) {
    return this.withInput(args.session_id, async (checkInput) => {
      this.assertOpen();
      if (!bashSchema.safeParse(args).success) throw new Error('INVALID_BASH_ARGS');
      if (this.configFile) await this.refreshPermissions();
      const session = await this.session(args.session_id);
      this.check('command', session);
      const recovery_id = hash({
        principal: this.config.principal,
        session: session.id,
        request: args.request_id,
      });
      const body = args.command === undefined ? undefined : { command: args.command };
      const receipt = await this.journal.run(
        args.request_id,
        'command',
        session.id,
        body,
        args.cursor !== undefined
          ? undefined
          : async (save) => {
              if (this.locks.has(`bash:${session.id}`))
                return save({ status: 'rejected', reason: 'BASH_IN_PROGRESS' });
              return this.locked(`bash:${session.id}`, async () => {
                let generation;
                try {
                  const beforeDispatch = async () => {
                    if (this.configFile) await this.refreshPermissions();
                    checkInput();
                    this.check('command', session);
                    if (this.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
                  };
                  await beforeDispatch();
                  let runtime = await this.pool.forRead(session);
                  if (!runtime) {
                    await validateExecutionCwd(session.cwd);
                    await loadSavedSession(session);
                    runtime = await this.pool.resolve(session);
                  }
                  await beforeDispatch();
                  if (typeof runtime.executeBash !== 'function')
                    throw new Error('BASH_UNSUPPORTED');
                  generation = runtime.generation ?? runtime.record?.generation ?? null;
                  await save({ status: 'unknown', generation });
                  await runtime.executeBash({
                    ...args,
                    recovery_id,
                    beforeDispatch,
                    onLate: () =>
                      save({ status: 'accepted', completion: 'native_bash_result', generation }),
                  });
                  return save({ status: 'accepted', completion: 'native_bash_result', generation });
                } catch (error) {
                  return save({
                    status: error.uncertain ? 'unknown' : 'rejected',
                    reason: safeReason(error),
                    ...(generation ? { generation } : {}),
                  });
                }
              });
            },
      );
      if (this.configFile) await this.refreshPermissions();
      this.assertOpen();
      this.check('command', session);
      const result = receipt.generation
        ? await recoveredBash(this.pool.attachmentDir, session, receipt.generation, recovery_id)
        : null;
      if (!result) {
        if (receipt.status === 'accepted') throw new Error('BASH_RECOVERY_MISSING');
        return { ...receipt, output_available: false };
      }
      return bashOutputPage(receipt, result, args);
    });
  }
  async stop(args) {
    this.assertOpen();
    if (!stopSchema.safeParse(args).success) throw new Error('INVALID_STOP_ARGS');
    if (this.configFile) await this.refreshPermissions();
    const session = await this.session(args.session_id);
    this.check('stop', session);
    const recovery_id = hash({
      principal: this.config.principal,
      session: session.id,
      request: args.request_id,
    });
    const receipt = await this.journal.run(
      args.request_id,
      'stop',
      session.id,
      args.cursor !== undefined ? undefined : {},
      (save) =>
        this.mutationLock(
          session.id,
          'stop',
          save,
          async () => {
            let generation;
            try {
              this.assertOpen();
              // Invalidate pending input without waiting behind its admission lock.
              for (const input of this.inputs)
                if (input.sessionId === session.id) input.stopped = true;
              // Independent of prompt admission's lock; never start a writer.
              const runtime = await this.pool.forRead(session);
              this.assertOpen();
              if (this.configFile) await this.refreshPermissions();
              this.check('stop', session);
              if (!runtime) return save({ status: 'skipped', reason: 'not_running' });
              if (typeof runtime.stopExecution !== 'function') throw new Error('STOP_UNSUPPORTED');
              generation = runtime.generation ?? runtime.record?.generation ?? null;
              await save({ status: 'unknown', generation });
              if (this.configFile) await this.refreshPermissions();
              this.assertOpen();
              this.check('stop', session);
              // A join may have begun during owner lookup, ACL reload or receipt I/O.
              // No stop command has been dispatched yet, so this is a definite refusal.
              if (this.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
              const result = stopReceipt(await runtime.stopExecution({ ...args, recovery_id }));
              return save({ ...result, generation });
            } catch (error) {
              return save({
                status: error.uncertain ? 'unknown' : 'rejected',
                reason: safeReason(error),
                ...(generation ? { generation } : {}),
              });
            }
          },
          `stop:${session.id}`,
        ),
    );
    // Returning/replaying withdrawn content always rechecks current ACLs.
    if (this.configFile) await this.refreshPermissions();
    this.assertOpen();
    this.check('stop', session);
    const withdrawn = receipt.generation
      ? await recoveredWithdrawal(this.pool.attachmentDir, session, receipt.generation, recovery_id)
      : null;
    if (withdrawn === null) {
      if (receipt.status === 'skipped')
        return withdrawalPage(
          receipt,
          { generation: null, text: '', includesEditorDraft: false },
          args,
        );
      if (receipt.status === 'accepted') throw new Error('WITHDRAWAL_RECOVERY_MISSING');
      return { ...receipt, withdrawn_available: false };
    }
    return withdrawalPage(receipt, withdrawn, args);
  }
  async create(args) {
    this.assertOpen();
    if (this.configFile) await this.refreshPermissions();
    const folder = this.config.folders.find((folder) => folder.path === args.project);
    if (!folder || !permitted(this.config, 'create', { cwd: folder.path }))
      return {
        request_id: args.request_id,
        operation: 'create',
        status: 'rejected',
        reason: 'NOT_FOUND_OR_DENIED',
      };
    const input = promptInput(args);
    const body =
      input === undefined ? undefined : { ...input, name: args.name, fork_from: args.fork_from };
    return this.journal.run(args.request_id, 'create', folder.path, body, (save) =>
      this.locked(`project:${folder.path}`, async () => {
        let child,
          created = false;
        const selection = input.model
          ? { model_selection: { requested: input.model, scope: 'session', status: 'not_changed' } }
          : {};
        const outcome = (send) => ({
          status: send.status,
          created,
          session_id: child?.id,
          send: { ...selection, ...send },
        });
        try {
          await validateExecutionCwd(folder.path);
          let parent, snapshot;
          if (args.fork_from) {
            parent = await this.session(args.fork_from);
            this.check('read', parent);
            const runtime = await this.pool.forRead(parent);
            if (runtime?.attached) {
              if (typeof runtime.snapshot !== 'function') throw new Error('SNAPSHOT_UNSUPPORTED');
              snapshot = await runtime.snapshot();
            } else snapshot = runtime ? await runtime.entries() : await loadSavedSession(parent);
          }
          child = prepareSession(this.config, folder.path, { name: args.name, parent, snapshot });
          // Persist the chosen child identity before creating a file. Retries never
          // create another child or replay an uncertain first prompt.
          await save(outcome({ status: 'unknown', phase: 'creating' }));
          if (this.configFile) await this.refreshPermissions();
          this.check('create', { cwd: folder.path });
          if (parent) this.check('read', parent);
          this.assertOpen();
          return await this.locked(child.id, () =>
            this.withInput(child.id, async (checkInput) => {
              const beforeDispatch = async () => {
                if (this.configFile) await this.refreshPermissions();
                this.check('create', { cwd: folder.path });
                if (parent) this.check('read', parent);
                checkInput();
                if (this.handoffs.has(child.id)) throw new Error('HANDOFF_PENDING');
              };
              await beforeDispatch();
              await persistSession(child);
              created = true;
              await save(outcome({ status: 'unknown', phase: 'starting' }));
              const runtime = await this.pool.resolve(child);
              await beforeDispatch();
              if (runtime.attached) throw new Error('RUNTIME_SESSION_CHANGED');
              if (input.model) {
                await runtime.selectModel(input.model, {
                  images: input.images,
                  idle: true,
                  timeout: args.timeout_ms ?? 5000,
                  beforeDispatch,
                  report: (status) => {
                    selection.model_selection.status = status;
                  },
                  onLate: (result) =>
                    save(outcome(modelSelectedWithoutPrompt(result, selection, input.model))),
                });
                await beforeDispatch();
              }
              if (input.images) {
                assertImageModel(input.images, (await runtime.state()).model);
                await beforeDispatch();
              }
              const onLate = (result) =>
                save(
                  outcome(
                    result.ok
                      ? {
                          status: 'accepted',
                          disposition: result.data.disposition,
                          completion: 'not_tracked',
                        }
                      : { status: 'rejected', reason: result.code },
                  ),
                );
              const result = await runtime.command(
                {
                  type: 'prompt',
                  message: input.text,
                  ...(input.images ? { images: input.images } : {}),
                  streamingBehavior: 'steer',
                },
                args.timeout_ms ?? 5000,
                onLate,
                beforeDispatch,
              );
              return save(
                outcome({
                  status: 'accepted',
                  disposition: result.disposition,
                  completion: 'not_tracked',
                }),
              );
            }),
          );
        } catch (error) {
          if (error.sessionPublished) created = true;
          const result = {
            status: error.uncertain ? 'unknown' : 'rejected',
            reason: safeReason(error),
          };
          return save(child ? outcome(result) : result);
        }
      }),
    );
  }
  async delete(args) {
    this.assertOpen();
    if (this.configFile) {
      await this.refreshPermissions();
      this.assertOpen();
    }
    const prior = await this.journal.get(args.request_id);
    const target = await this.session(args.session_id).catch(() => null);
    if (
      !permitted(
        this.config,
        'delete',
        target ?? {
          id: args.session_id,
          cwd: prior?.key === `delete:${args.session_id}` ? prior.receipt.project : null,
        },
      )
    )
      return {
        request_id: args.request_id,
        operation: 'delete',
        status: 'rejected',
        reason: 'NOT_FOUND_OR_DENIED',
      };
    return this.journal.run(args.request_id, 'delete', args.session_id, {}, (save) =>
      this.mutationLock(args.session_id, 'delete', save, async () => {
        let trash, release;
        try {
          const s = await this.session(args.session_id);
          this.check('delete', s);
          trash = await prepareTrash(this.config, s);
          if (this.configFile) await this.refreshPermissions();
          this.check('delete', s);
          release = await this.pool.stopForDelete(s); // Hold ownership through the move.
          if (this.configFile) await this.refreshPermissions();
          this.check('delete', s);
          await trash.move();
          return save({
            status: 'deleted',
            recoverable: true,
            restore_token: trash.token,
            project: s.cwd,
          });
        } catch (e) {
          return save({
            status: trash?.moved ? 'unknown' : 'rejected',
            reason: safeReason(e),
            project: target?.cwd ?? null,
          });
        } finally {
          await trash?.cancel().catch(() => {});
          await release?.();
        }
      }),
    );
  }
  handoffForLocal(request, options) {
    return idleHandoff(this, request, options);
  }
  cancelHandoff(request) {
    return cancelHandoff(this, request);
  }
  async releaseForLocal({ session_id, interrupt = false }) {
    this.assertOpen();
    if (typeof interrupt !== 'boolean') throw new Error('INVALID_OWNER_COMMAND');
    if (this.handoffs.has(session_id)) throw new Error('HANDOFF_PENDING');
    const priorStop = this.locks.get(`stop:${session_id}`),
      release = { kind: 'release' };
    this.handoffs.set(session_id, release);
    try {
      return await this.locked(session_id, async () => {
        // An admitted stop finishes its receipt capture before owner shutdown.
        await priorStop?.catch(() => {});
        this.assertOpen();
        const session = await this.session(session_id),
          dir = this.pool.attachmentDir;
        if (this.pool.starting.has(session_id)) throw new Error('RUNTIME_IDLE_UNCONFIRMED');
        const runtime = await this.pool.forRead(session);
        if (runtime?.attached) throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
        if (runtime) {
          if (!(runtime instanceof PiRpc)) throw new Error('BRIDGE_OWNED_RUNTIME_REQUIRED');
          runtime.handoffPending = true;
          try {
            if (interrupt) {
              await runtime.checkedState();
              const owner = runtime.ownerRecord?.owner;
              if (owner?.pid !== runtime.child?.pid || !(await ownerAlive(owner)))
                throw new Error('RUNTIME_SESSION_CHANGED');
            } else await runtime.assertReleasable();
            await runtime.drainRecovery();
            if (!interrupt && runtime.recoveryError()) throw runtime.recoveryError();
            await updateOwner(dir, session, runtime.ownerRecord, { noColdReacquire: true });
            if (interrupt) await this.pool.stop(session_id);
            else {
              await runtime.gracefulExit();
              this.pool.instances.delete(session_id);
            }
          } finally {
            if (!runtime.gracefulExitPromise && !runtime.stopPromise)
              runtime.handoffPending = false;
          }
        } else
          await registryTransaction(dir, async () => {
            const current = await readClaim(dir, session);
            if (current && (await ownerAlive(current.owner)))
              throw new Error('LIVE_OWNER_UNREACHABLE');
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
        return { session_id, status: 'released', no_cold_reacquire: true };
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
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.ownerControl?.close();
      await Promise.allSettled([...this.journal.running.values()]);
      await this.pool.drainRecovery?.();
      await this.pool.close();
      await Promise.allSettled([...this.journal.transitions.values()]);
      await Promise.allSettled([...this.journal.writes.values()]);
      if (this.lock) {
        await this.lock.close();
        await fs.unlink(this.lockPath);
        this.lock = null;
      }
      const recoveryError = this.pool.recoveryError?.();
      if (recoveryError) throw recoveryError;
      if (this.journal.writeFailures.size) {
        const error = new Error('RECEIPT_PERSIST_FAILED');
        error.uncertain = true;
        throw error;
      }
    })();
    return this.closePromise;
  }
}
function modelSelectedWithoutPrompt(result, selection, requested) {
  const selected = result.ok && sameModel(result.data, requested);
  return {
    status: 'rejected',
    reason: selected
      ? 'MODEL_SELECTED_PROMPT_NOT_SENT'
      : result.ok
        ? 'MODEL_SELECTION_CHANGED'
        : result.code,
    model_selection: { ...selection.model_selection, status: selected ? 'selected' : 'unknown' },
  };
}
function safeReason(error) {
  const code = error.code ?? error.message;
  diagnostics.emit('operation.failure', { code, uncertain: error.uncertain === true });
  return [
    'RECEIPT_PERSIST_FAILED',
    'IMAGE_INPUT_UNSUPPORTED',
    'MODEL_IMAGE_INPUT_UNSUPPORTED',
    'MODEL_SELECTION_UNSUPPORTED',
    'MODEL_SELECTION_PENDING',
    'MODEL_SELECTION_BUSY',
    'MODEL_SELECTION_IDLE_UNCONFIRMED',
    'MODEL_SELECTION_FAILED',
    'MODEL_SELECTION_CHANGED',
    'MODEL_UNAVAILABLE',
    'THINKING_LEVEL_UNSUPPORTED',
    'THINKING_SUPPORT_UNKNOWN',
    'MODEL_REQUIRES_PROMPT',
    'MODELS_UNSUPPORTED',
    'COMPACT_UNSUPPORTED',
    'COMPACTION_PENDING',
    'INVALID_COMPACT_RESULT',
    'COMPACT_BUSY',
    'COMPACT_IDLE_UNCONFIRMED',
    'RELOAD_BUSY',
    'RELOAD_IDLE_UNCONFIRMED',
    'RELOAD_NOT_RUNNING',
    'RELOAD_UNSUPPORTED',
    'RELOAD_OWNER_CHANGED',
    'RUNTIME_EXIT_ABNORMAL',
    'RECOVERY_PERSIST_FAILED',
    'BRIDGE_CLOSING',
    'INVALID_PROMPT_INPUT',
    'SNAPSHOT_UNSUPPORTED',
    'SESSION_TOO_LARGE',
    'INVALID_HOST_SNAPSHOT',
    'HANDOFF_PENDING',
    'BASH_IN_PROGRESS',
    'BASH_UNSUPPORTED',
    'INVALID_BASH_RESULT',
    'STOP_IN_PROGRESS',
    'STOP_UNSUPPORTED',
    'INVALID_STOP_RECEIPT',
    'ATTACHED_OPERATION_FAILED',
    'COLD_REACQUIRE_BLOCKED',
    'HOST_RELEASE_UNSUPPORTED',
    'HOST_RELEASE_FAILED',
    'HOST_NOT_READY',
    'HOST_SUBMIT_UNCERTAIN',
    'EXECUTION_CWD_UNAVAILABLE',
    'INVALID_SESSION',
    'INVALID_SESSION_TREE',
    'NOT_FOUND_OR_DENIED',
    'ATTACHMENT_REQUEST_TOO_LARGE',
    'PROMPT_ADMISSION_PENDING',
    'PI_REJECTED',
    'ACK_TIMEOUT',
    'WRITE_UNKNOWN',
    'RUNTIME_DISCONNECTED',
    'RUNTIME_START_FAILED',
    'PI_EXECUTABLE_NOT_FOUND',
    'PI_EXECUTABLE_NOT_EXECUTABLE',
    'RUNTIME_STOP_FAILED',
    'RUNTIME_SESSION_CHANGED',
    'LIVE_OWNER_UNREACHABLE',
    'OWNER_STILL_ALIVE',
    'ATTACHMENT_REGISTRY_BUSY',
    'PI_ACCEPTANCE_UNOBSERVABLE',
  ].includes(code)
    ? code
    : 'OPERATION_FAILED';
}
