import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EventSubscriptions } from '../events/events.mjs';
import { Submissions } from './submissions.mjs';
import { publicError } from './errors.mjs';
import { inside, permitted } from './permissions.mjs';
import { ContextReadCache } from '../read/read-cache.mjs';
import { CompatibilityModules } from '../compat/compatibility.mjs';
import { CompatibilityServices } from '../compat/compatibility-services.mjs';
import { discover, readSessionIdentity } from './data.mjs';
import { assertPrivateDirectory, assertNativeDirectory } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
import { PiRpc, RuntimePool } from '../runtime/rpc.mjs';
import { privateDirectory, readOwnerRecord } from '../runtime/attachments.mjs';
import { serveOwnerControl } from '../owner-runtime.mjs';
import { readOwnerConfig, validateOwnerConfig } from './owner-config.mjs';
import { diagnostics } from './diagnostics.mjs';
import { idleHandoff, cancelHandoff } from '../runtime/idle-handoff.mjs';
import { scheduleAutoRelease } from '../runtime/auto-release.mjs';
import {
  acquireNativeRead,
  getHealth,
  getSubmission,
  listModels,
  listSessions,
  readSession,
  searchSession,
} from './bridge-read.mjs';
import {
  compactSession,
  createSession,
  deleteSession,
  reloadSession,
  runCommand,
  sendPrompt,
  setSessionModel,
  stopSession,
} from './bridge-mutations.mjs';
import {
  idleCandidateForLocal,
  releaseForLocal,
  resetColdResume,
  settledForLocal,
} from './bridge-local.mjs';

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
    this.cachedRequestPolicy = null;
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
    this.completionSequences = new Map();
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
      if (this.locks.get(id) === next) this.locks.delete(id);
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
  // Lifecycle markers fence admission for one session; only the owner removes its own.
  async withHandoff(id, marker, fn) {
    this.handoffs.set(id, marker);
    try {
      return await fn();
    } finally {
      if (this.handoffs.get(id) === marker) this.handoffs.delete(id);
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
        return { status: 'rejected', reason: this.safeReason(error) };
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
      let raw;
      if (this.configFile) {
        const loaded = await readOwnerConfig(this.configFile, {
          cached: this.cachedRequestPolicy,
        });
        if (loaded.unchanged) return this.cachedRequestPolicy.context;
        raw = loaded.raw;
        const { config } = loaded;
        const { grants, defaults, folders, sessionRoots, herdr, ...settings } = config;
        restartRequired = [
          ...new Set([...Object.keys(this.ownerSettings), ...Object.keys(settings)]),
        ].filter((key) => !isDeepStrictEqual(settings[key], this.ownerSettings[key]));
        // The file was already validated. Only a pending stateDir change
        // requires checking the new roots against another directory.
        const active = this.config.stateDir;
        if (
          config.stateDir !== active &&
          sessionRoots.some((root) => inside(root, active) || inside(active, root))
        )
          throw new Error('OVERLAPPING_STORAGE');
        policy = config;
      }
      const defaults = Object.freeze({ ...policy.defaults });
      const grants = Object.freeze((policy.grants ?? []).map((rule) => Object.freeze({ ...rule })));
      const scope = scopeSnapshot(policy);
      const context = Object.freeze({
        permissions: Object.freeze({ defaults, grants }),
        scope,
        restartRequired: Object.freeze(restartRequired),
      });
      if (this.configFile) this.cachedRequestPolicy = { raw, config: policy, context };
      return context;
    });
  }
  async session(id, requestContext) {
    let file = this.sessionFiles.get(id) ?? this.pool.instances.get(id)?.session?.file;
    // Owner-local cleanup may outlive both scope membership and the discovery cache.
    // Reuse the existing claim's identity, never a previous permission policy.
    if (!requestContext && !file && /^ps_[a-f0-9]{32}$/.test(id)) {
      await privateDirectory(this.pool.attachmentDir);
      file = (await readOwnerRecord(path.join(this.pool.attachmentDir, `${id}.owner.json`)))?.file;
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
  safeReason(error) {
    const code = publicError(error);
    diagnostics.emit('operation.failure', { code, uncertain: error.uncertain === true });
    return code;
  }
  acquireNativeRead(session, runtime, args) {
    return acquireNativeRead(this, session, runtime, args);
  }
  list(args, options) {
    return listSessions(this, args, options);
  }
  read(args, options) {
    return readSession(this, args, options);
  }
  search(args, options) {
    return searchSession(this, args, options);
  }
  models(args, options) {
    return listModels(this, args, options);
  }
  health(args, options) {
    return getHealth(this, args, options);
  }
  submission(args, options) {
    return getSubmission(this, args, options);
  }
  set_model(args, options) {
    return this.#mutation(args, options, setSessionModel);
  }
  send(args, options) {
    return this.#mutation(args, options, sendPrompt, true);
  }
  create(args, options) {
    return this.#mutation(args, options, createSession);
  }
  command(args, options) {
    return this.#mutation(args, options, runCommand, true);
  }
  stop(args, options) {
    return this.#mutation(args, options, stopSession);
  }
  reload(args, options) {
    return this.#mutation(args, options, reloadSession, true);
  }
  compact(args, options) {
    return this.#mutation(args, options, compactSession, true);
  }
  delete(args, options) {
    return this.#mutation(args, options, deleteSession);
  }
  async #mutation(args, options, action, tracksInput = false) {
    this.assertOpen();
    let releaseCandidate;
    const run = async (checkInput) => {
      const requestContext = await (options?.requestContext ?? this.captureRequestContext());
      this.assertOpen();
      return action(this, args, {
        ...options,
        requestContext,
        checkInput,
        markForAutoRelease: (runtime) => {
          if (runtime instanceof PiRpc) releaseCandidate = runtime;
        },
      });
    };
    const work = tracksInput ? this.withInput(args.session_id, options?.pendingInput, run) : run();
    this.pendingMutations.add(work);
    try {
      return await work;
    } finally {
      this.pendingMutations.delete(work);
      if (releaseCandidate) {
        releaseCandidate.autoReleaseWanted = true;
        releaseCandidate.onIdleCandidate?.();
      }
    }
  }
  settledForLocal(request) {
    return settledForLocal(this, request);
  }
  handoffForLocal(request, options) {
    return idleHandoff(this, request, options);
  }
  cancelHandoff(request) {
    return cancelHandoff(this, request);
  }
  idleCandidateForLocal(request) {
    return idleCandidateForLocal(this, request);
  }
  releaseForLocal(request) {
    return releaseForLocal(this, request);
  }
  resetColdResume(request) {
    return resetColdResume(this, request);
  }
  assertOpen() {
    if (this.closing) throw new Error('BRIDGE_CLOSING');
  }
  prepareClose() {
    // Freeze business admission before transport drain: already-dispatched
    // work finishes, queued mutations cannot start another writer.
    this.closing = true;
    return (this.closePreparation ??= Promise.all([
      this.pool.prepareClose(),
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
      this.completionSequences.clear();
      while (this.pendingMutations.size) await Promise.allSettled([...this.pendingMutations]);
      await this.pool.drainAcks();
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
