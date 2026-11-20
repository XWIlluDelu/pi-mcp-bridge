import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EventSubscriptions } from '../events/events.mjs';
import { Submissions } from './submissions.mjs';
import { publicError } from './errors.mjs';
import { inside, permitted } from './permissions.mjs';
import { ContextReadCache } from '../read/read-cache.mjs';
import { startCompatibilityModules } from '../compat/compatibility.mjs';
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
import { queries } from './bridge-read.mjs';
import { mutations } from './bridge-mutations.mjs';
import * as ownerOperations from './bridge-local.mjs';

export class Bridge {
  #jobs = new Map();
  constructor(config, factory, { configFile } = {}) {
    this.config = config;
    this.configFile = configFile;
    const { grants, defaults, folders, sessionRoots, herdr, ...settings } = config;
    this.ownerSettings = structuredClone(settings);
    this.cachedRequestPolicy = null;
    this.compatibilityServices = new CompatibilityServices();
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
      this.assertOpen();
      this.compatibility = startCompatibilityModules(
        this.config.compatibilityModules,
        this.compatibilityServices,
      );
      await this.compatibility.ready;
      await this.events.init();
      this.ownerControl = await serveOwnerControl(this);
    } catch (error) {
      await Promise.allSettled([this.compatibility?.stop(), this.events.close()]);
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
      if (job[name] === value) {
        delete job[name];
        if (!Object.keys(job).length) this.#jobs.delete(id);
        if (name === 'stop' || name === 'bash') this.pool.instances.get(id)?.onIdleCandidate?.();
      }
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
  assertInput({ name, sessionId, stopped }) {
    // Keep cancellation across batch lanes, permission and state I/O.
    // A completed stop must not revive input that has not reached Pi yet.
    this.assertOpen();
    if (stopped || this.lane(sessionId, 'stop')) throw new Error('STOP_IN_PROGRESS');
    const fence = this.handoff(sessionId);
    if (fence && (fence.kind === 'delete' || name === 'command' || name === 'create'))
      throw new Error('HANDOFF_PENDING');
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
  async sessions(requestContext) {
    // Owner-local identity lookup is not business admission and remains available
    // during cleanup. Unknown identities use current scope, not startup roots.
    const sessionRoots = requestContext?.scope.sessionRoots ?? [
      ...(this.configFile ? (await readOwnerConfig(this.configFile)).config : this.config)
        .sessionRoots,
    ];
    const sessions = await diagnostics.measure('session.discover', {}, () =>
      discover({ sessionRoots }),
    );
    this.sessionFiles = new Map(sessions.map((s) => [s.id, s.file]));
    return sessions;
  }
  #mutationBlock(id, lane) {
    const handoff = this.handoff(id);
    if (handoff && handoff.kind !== 'auto_release') return 'HANDOFF_PENDING';
    if (lane === 'work' && this.lane(id, 'stop')) return 'STOP_IN_PROGRESS';
  }
  #orderedMutation(name, id, right, requestContext, lane, run) {
    if (lane === 'bash' && this.lane(id, lane))
      return { status: 'rejected', reason: 'BASH_IN_PROGRESS', output_available: false };
    // These calls own distinct admission checks once their lane begins.
    if (lane === 'bash' || lane === 'delete' || name === 'set_model')
      return this.locked(id, run, lane);
    const reject = (reason) => ({
      status: 'rejected',
      reason,
      ...(lane === 'stop' ? { withdrawn_available: false } : {}),
    });
    const blocked = this.#mutationBlock(id, lane);
    if (blocked) return reject(blocked);
    return this.locked(
      id,
      async () => {
        const reason = this.#mutationBlock(id, lane);
        if (!reason) return run();
        try {
          await this.authorizedSession(right, id, requestContext);
          return reject(reason);
        } catch (error) {
          return reject(this.safeReason(error));
        }
      },
      lane,
    );
  }
  async captureRequestContext() {
    this.assertOpen();
    return diagnostics.measure('permission.snapshot', {}, async () => {
      const loaded =
        this.configFile &&
        (await readOwnerConfig(this.configFile, { cached: this.cachedRequestPolicy }));
      if (loaded?.unchanged) return this.cachedRequestPolicy.context;
      const config = loaded?.config ?? this.config;
      const { grants, defaults, folders, sessionRoots, herdr, ...settings } = config;
      // The file was already validated. A pending stateDir change also needs
      // to check the new roots against the active state directory.
      const active = this.config.stateDir;
      if (
        config.stateDir !== active &&
        sessionRoots.some((root) => inside(root, active) || inside(active, root))
      )
        throw new Error('OVERLAPPING_STORAGE');
      const context = Object.freeze({
        permissions: Object.freeze({
          defaults: Object.freeze({ ...defaults }),
          grants: Object.freeze((grants ?? []).map((rule) => Object.freeze({ ...rule }))),
        }),
        scope: Object.freeze({
          folders: Object.freeze(folders.map((folder) => Object.freeze({ ...folder }))),
          sessionRoots: Object.freeze([...sessionRoots]),
        }),
        restartRequired: Object.freeze(
          loaded
            ? [...new Set([...Object.keys(this.ownerSettings), ...Object.keys(settings)])].filter(
                (key) => !isDeepStrictEqual(settings[key], this.ownerSettings[key]),
              )
            : [],
        ),
      });
      if (loaded) this.cachedRequestPolicy = { raw: loaded.raw, config, context };
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
  async authorizedSession(action, id, requestContext = this.captureRequestContext()) {
    const context = await requestContext;
    const session = await this.session(id, context);
    this.check(action, session, context);
    return session;
  }
  // An identity check preserves admission under the same immutable policy.
  // A fresh target must be authorized before returning any of its details.
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
    mutation.name = name;
    if (inputOperations.has(name) && !options?.pendingInput)
      this.registerInput(args.session_id, mutation);
    else this.mutations.add(mutation);
    let releaseCandidate;
    mutation.work = this.#requestOptions(options).then(async (request) => {
      const [action, right, lane] = mutations[name];
      let target;
      if (right) {
        try {
          target = await this.authorizedSession(right, args.session_id, request.requestContext);
        } catch (error) {
          if (name !== 'send' && name !== 'delete') throw error;
          return { status: 'rejected', reason: 'NOT_FOUND_OR_DENIED' };
        }
      }
      if (name === 'compact' && args.interrupt) this.check('stop', target, request.requestContext);
      const run = () =>
        action(this, args, {
          ...request,
          target,
          mutation,
          checkInput: () => this.assertInput(mutation),
          markForAutoRelease: (runtime) => {
            if (runtime instanceof PiRpc) releaseCandidate = runtime;
          },
        });
      return lane
        ? this.#orderedMutation(name, target.id, right, request.requestContext, lane, run)
        : run();
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
        await this.compatibility?.stop();
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
