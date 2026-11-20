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
import { discover, readSessionIdentity, sameSessionIdentity } from './data.mjs';
import { assertPrivateDirectory, assertNativeDirectory } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import { RuntimePool } from '../runtime/runtime-pool.mjs';
import { privateDirectory, readOwnerRecord } from '../runtime/attachments.mjs';
import { serveOwnerControl } from '../owner-runtime.mjs';
import { readOwnerConfig, validateOwnerConfig } from './owner-config.mjs';
import { diagnostics } from './diagnostics.mjs';
import { inputOperations } from '../mcp/tool-schemas.mjs';
import {
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
  idleHandoff,
  cancelHandoff,
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

const queries = {
  list: listSessions,
  read: readSession,
  search: searchSession,
  models: listModels,
  health: getHealth,
  submission: getSubmission,
};
const mutations = {
  send: [sendPrompt, 'send'],
  command: [runCommand, 'command'],
  compact: [compactSession, 'send'],
  reload: [reloadSession, 'send'],
  set_model: [setSessionModel, 'send'],
  stop: [stopSession, 'stop'],
  create: [createSession],
  delete: [deleteSession, 'delete'],
};
const ownerOperations = {
  settledForLocal,
  handoffForLocal: idleHandoff,
  cancelHandoff,
  idleCandidateForLocal,
  releaseForLocal,
  resetColdResume,
};

export class Bridge {
  #jobs = new Map();
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
    // A batch can register an input before its job has a work promise.
    this.mutations = new Set();
    this.sessionFiles = new Map();
    this.titleCache = new Map();
    this.readCache = new ContextReadCache();
    this.events = new EventSubscriptions(this);
    this.completionSequences = new Map();
    this.submissions = new Submissions();
    this.pool.onIdleCandidate = (runtime) => this.scheduleAutoRelease(runtime);
    for (const [name, query] of Object.entries(queries))
      this[name] = async (args, options) => query(this, args, await this.#requestOptions(options));
    for (const name of Object.keys(mutations)) this[name] = this.#mutation.bind(this, name);
    for (const [name, operation] of Object.entries(ownerOperations))
      this[name] = operation.bind(null, this);
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
  lane(id, name = 'work') {
    return this.#jobs.get(id)?.[name];
  }
  async #occupy(id, name, value, fn) {
    let job = this.#jobs.get(id);
    if (!job) this.#jobs.set(id, (job = {}));
    job[name] = value;
    try {
      return await fn();
    } finally {
      if (job[name] === value) delete job[name];
      if (!Object.keys(job).length && this.#jobs.get(id) === job) this.#jobs.delete(id);
    }
  }
  locked(id, fn, lane = 'work') {
    const next = Promise.resolve(this.lane(id, lane))
      .catch(() => {})
      .then(fn);
    return this.#occupy(id, lane, next, () => next);
  }
  registerInput(sessionId, mutation = {}) {
    mutation.sessionId = sessionId;
    mutation.stopped = Boolean(this.lane(sessionId, 'stop'));
    this.mutations.add(mutation);
    return mutation;
  }
  assertInput({ sessionId, stopped }) {
    // Keep cancellation across batch lanes, permission and state I/O.
    // A completed stop must not revive input that has not reached Pi yet.
    this.assertOpen();
    if (stopped || this.lane(sessionId, 'stop')) throw new Error('STOP_IN_PROGRESS');
    if (this.handoff(sessionId)?.kind === 'delete') throw new Error('HANDOFF_PENDING');
  }
  handoff(id) {
    return this.lane(id, 'handoff');
  }
  withHandoff(id, marker, fn) {
    return this.#occupy(id, 'handoff', marker, fn);
  }
  autoReleaseInProgress(id) {
    const handoff = this.handoff(id);
    return handoff?.kind === 'auto_release' ? handoff.runtime.autoReleaseTask : undefined;
  }
  scheduleAutoRelease(runtime) {
    if (!runtime.autoReleaseWanted || this.closing || !runtime.alive) return;
    if (runtime.autoReleaseTask) {
      runtime.autoReleaseAgain = true;
      return runtime.autoReleaseTask;
    }
    if (runtime.exitSeal) return;

    const { id } = runtime.session;
    const eligible = () =>
      !this.closing &&
      runtime.alive &&
      !runtime.exitSeal &&
      this.pool.instances.get(id) === runtime &&
      !this.handoff(id) &&
      !this.lane(id, 'stop') &&
      !this.lane(id, 'bash') &&
      !runtime.activeReads &&
      !runtime.hasUnsettledWork();

    runtime.autoReleaseTask = this.locked(id, async () => {
      runtime.autoReleaseAgain = false;
      if (!eligible()) return;
      const { status } = await runtime.idleSnapshot();
      if (status !== 'idle' || !eligible()) return;
      const marker = { kind: 'auto_release', runtime, controller: new AbortController() };
      try {
        await this.withHandoff(id, marker, () =>
          this.pool.shutdown(runtime, marker.controller.signal, { mode: 'proven_idle' }),
        );
        diagnostics.emit('runtime.auto_released', { kind: 'rpc', generation: runtime.generation });
      } catch (error) {
        if (!marker.controller.signal.aborted && error.code !== 'RUNTIME_BUSY') throw error;
      }
    })
      .catch((error) => {
        diagnostics.emit('runtime.auto_release_failed', {
          code: error.code ?? error.message,
          generation: runtime.generation,
          uncertain: error.uncertain === true,
        });
      })
      .finally(() => {
        runtime.autoReleaseTask = null;
        // A fresh idle signal can precede a definite busy refusal.
        if (runtime.autoReleaseAgain) this.scheduleAutoRelease(runtime);
      });
    return runtime.autoReleaseTask;
  }
  async localHandoff(id, marker, fn) {
    const release = this.autoReleaseInProgress(id);
    if (release) await release;
    if (this.handoff(id)) throw new Error('HANDOFF_PENDING');
    const priorStop = this.lane(id, 'stop');
    return this.withHandoff(id, marker, () =>
      this.locked(id, async () => {
        // Fence new stops before draining the one already admitted.
        await priorStop?.catch(() => {});
        this.assertOpen();
        marker.controller.signal.throwIfAborted();
        return fn();
      }),
    );
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
  async mutationLock(id, action, requestContext, fn, lane) {
    const blockedReason = () =>
      this.handoff(id) && this.handoff(id).kind !== 'auto_release'
        ? 'HANDOFF_PENDING'
        : action === 'send' && this.lane(id, 'stop')
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
    // The caller just authorized the target before entering this lane.
    const reason = blockedReason();
    if (reason) return { status: 'rejected', reason };
    return this.locked(
      id,
      () => {
        const reason = blockedReason();
        return reason ? blocked(reason) : fn();
      },
      lane,
    );
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
  async revalidateSession(session, requestContext) {
    const current = await this.session(session.id, requestContext);
    if (!sameSessionIdentity(current, session)) throw new Error('RUNTIME_SESSION_CHANGED');
    return current;
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
  async #requestOptions(options) {
    const requestContext = await (options?.requestContext ?? this.captureRequestContext());
    this.assertOpen();
    return { ...options, requestContext };
  }
  async #mutation(name, args, options) {
    this.assertOpen();
    const mutation = options?.pendingInput ?? {};
    if (inputOperations.has(name) && !options?.pendingInput)
      this.registerInput(args.session_id, mutation);
    else this.mutations.add(mutation);
    let releaseCandidate;
    mutation.work = this.#requestOptions(options).then(async (request) => {
      const [action, right] = mutations[name];
      let target;
      if (right) {
        try {
          target = await this.session(args.session_id, request.requestContext);
          this.check(right, target, request.requestContext);
        } catch (error) {
          if (name !== 'send' && name !== 'delete') throw error;
          return { status: 'rejected', reason: 'NOT_FOUND_OR_DENIED' };
        }
      }
      return action(this, args, {
        ...request,
        target,
        mutation,
        checkInput: () => this.assertInput(mutation),
        markForAutoRelease: (runtime) => {
          if (runtime instanceof PiRpc) releaseCandidate = runtime;
        },
      });
    });
    try {
      return await mutation.work;
    } finally {
      this.mutations.delete(mutation);
      if (releaseCandidate) {
        releaseCandidate.autoReleaseWanted = true;
        releaseCandidate.onIdleCandidate?.();
      }
    }
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
      // Closing has fenced every new mutation. The pool drains received ACKs
      // before stopping its runtimes.
      await Promise.allSettled(this.mutations.values().map((mutation) => mutation.work));
      await this.pool.close();
      await Promise.allSettled(
        this.#jobs.values().flatMap(({ handoff, ...lanes }) => Object.values(lanes)),
      );
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
