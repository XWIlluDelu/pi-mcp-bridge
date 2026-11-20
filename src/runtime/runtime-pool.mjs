import { HerdrRpcTransport } from './herdr-rpc-transport.mjs';
import { RetainedObservations } from '../read/context-observation.mjs';
import { sameSessionIdentity } from '../core/data.mjs';
import { diagnostics } from '../core/diagnostics.mjs';
import { readOwnerConfig, registryDirectory } from '../core/owner-config.mjs';
import {
  acquireDeletion,
  readClaim,
  ownerAlive,
  AttachedRuntime,
  AttachmentFailure,
} from './attachments.mjs';
import { PiRpc, RpcFailure } from './rpc.mjs';

export class RuntimePool {
  constructor(config, factory, { configFile, completionControl, compatibility } = {}) {
    this.compatibility = compatibility;
    this.config = config;
    this.attachmentDir = registryDirectory(config);
    this.factory =
      factory ??
      (async (session) => {
        // Placement is sampled only after reuse has been ruled out. It does not
        // alter the receive-time authorization snapshot or a running writer.
        const desired = configFile ? (await readOwnerConfig(configFile)).config : config;
        // A different namespace cannot prove this target has no writer. This
        // affects only acquisition, not reads or reuse of an existing owner.
        if (registryDirectory(desired) !== this.attachmentDir)
          throw new RpcFailure('CONFIG_RESTART_REQUIRED');
        const herdr = desired.herdr;
        const start = this.starting.get(session.id);
        start.controller.signal.throwIfAborted();
        start.runtime = new PiRpc(
          { ...config, herdr, attachmentDir: this.attachmentDir },
          session,
          {
            completionControl,
            compatibility,
          },
        );
        return start.runtime.start(start.controller.signal);
      });
    this.instances = new Map();
    // Keep the latest owned generation's bounded observations through normal
    // release, without persisting native notifications into session history.
    this.runtimeEvents = new Map();
    this.observations = new RetainedObservations();
    this.starting = new Map();
  }
  watchRuntime(runtime) {
    if (runtime instanceof PiRpc) {
      runtime.interruptShutdown = this.closing === true;
      this.runtimeEvents.delete(runtime.session.id);
      this.runtimeEvents.set(runtime.session.id, runtime.runtimeEvents);
      if (this.runtimeEvents.size > 16)
        this.runtimeEvents.delete(this.runtimeEvents.keys().next().value);
      runtime.onIdleCandidate = () => this.onIdleCandidate?.(runtime);
      runtime.retainObservation = async () => {
        let snapshot;
        try {
          // This close attempt already awaits its own capture. Do not report
          // it as a public read completion and schedule another close attempt.
          snapshot = await new AttachedRuntime(
            runtime.config,
            runtime.session,
            runtime.ownerRecord,
            {
              compatibility: runtime.compatibility,
            },
          ).read({ session_id: runtime.session.id, view: 'runtime' });
        } catch {
          // An unavailable observer does not erase a dated request snapshot.
          // Late public reads remain fenced by handoff and the runtime identity.
          return;
        }
        if (this.instances.get(runtime.session.id) === runtime)
          this.observations.put(runtime.session, snapshot, runtime);
      };
    }
    return runtime;
  }
  async forRead(session) {
    const existing = this.instances.get(session.id);
    const claim = await readClaim(this.attachmentDir, session);
    if (claim && (await ownerAlive(claim.owner))) {
      if (claim.kind === 'rpc') {
        if (existing?.alive && existing.ownerRecord?.generation === claim.generation)
          return this.boundRuntime(existing, session);
        throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      }
      if (claim.phase !== 'ready') throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      if (existing?.attached && existing.alive && existing.record.generation === claim.generation)
        return this.boundRuntime(existing, session);
      if (existing) await existing.stop();
      const attached = new AttachedRuntime(
        { ...this.config, attachmentDir: this.attachmentDir },
        session,
        claim,
        { compatibility: this.compatibility },
      );
      diagnostics.emit('runtime.attach', { kind: 'attached', generation: claim.generation });
      this.instances.set(session.id, attached);
      return attached;
    }
    if (existing?.attached) {
      diagnostics.emit('runtime.detached', {
        kind: 'attached',
        generation: existing.record.generation,
      });
      await existing.stop();
      this.instances.delete(session.id);
      return null;
    }
    return existing?.alive ? this.boundRuntime(existing, session) : null;
  }
  boundRuntime(runtime, session) {
    if (runtime.session && !sameSessionIdentity(runtime.session, session))
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    return runtime;
  }
  async resolve(session) {
    if (this.starting.has(session.id))
      return this.boundRuntime(await this.starting.get(session.id).promise, session);
    const attached = await this.forRead(session);
    if (attached) {
      diagnostics.emit('runtime.reused', {
        kind: attached.attached ? 'attached' : 'rpc',
        generation: attached.generation ?? attached.record?.generation,
      });
      return attached;
    }
    const claim = await readClaim(this.attachmentDir, session);
    if (claim?.noColdReacquire) throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    const existing = this.instances.get(session.id);
    if (existing?.alive) return this.boundRuntime(existing, session);
    if (existing) await existing.stop();
    if (this.starting.has(session.id))
      return this.boundRuntime(await this.starting.get(session.id).promise, session);
    const start = { controller: new AbortController() };
    this.starting.set(session.id, start);
    start.promise = diagnostics
      .measure('runtime.start', { kind: 'rpc' }, () => this.factory(session))
      .then((runtime) => {
        this.watchRuntime(runtime);
        this.instances.set(session.id, runtime);
        return runtime;
      })
      .finally(() => this.starting.delete(session.id));
    return start.promise;
  }
  get(id) {
    const r = this.instances.get(id);
    return r?.alive ? r : null;
  }
  async stopForDelete(session) {
    const pending = this.starting.get(session.id);
    pending?.controller.abort(new RpcFailure('RUNTIME_START_CANCELLED'));
    // Stop before launch, or obtain the actual launched process identity. Never
    // wait for native readiness/failure cleanup before exercising delete authority.
    await pending?.runtime?.launchSettled.promise;
    // Acquire once, before termination, not after the writer has released.
    // Any owner admitted before this point is the target of this deletion;
    // later acquisitions are blocked through the move and final cleanup.
    const deletion = await acquireDeletion(this.attachmentDir, session);
    try {
      const claim = await deletion.writer(),
        owned = this.instances.get(session.id) ?? pending?.runtime,
        herdr =
          owned instanceof PiRpc && owned.child instanceof HerdrRpcTransport ? owned.child : null;
      // Before Herdr reports Pi's identity, this launch's claim names Bridge,
      // not a writer to signal. A successor claim still belongs to this deletion.
      const startingOwner =
        herdr && !owned.childIdentity && claim?.generation === owned.ownerRecord?.generation;
      if (claim && !startingOwner && (await ownerAlive(claim.owner))) {
        const attached = new AttachedRuntime(
          { ...this.config, attachmentDir: this.attachmentDir },
          session,
          claim,
        );
        await attached.stopForDelete();
      }
      // Close the owned scope once: either startup never reported a Pi identity,
      // or the verified writer is now gone and only descendants may remain.
      if (herdr && (!owned.childIdentity || !(await ownerAlive(owned.childIdentity))))
        await herdr.terminateScope(this.config.attachmentExitTimeoutMs ?? 5000);
      await this.stop(session.id);
      this.observations.delete(session.id);
      return deletion.finish;
    } catch (error) {
      await deletion.finish();
      throw error;
    }
  }
  // An observed exit removes the runtime, including after an abnormal exit status.
  async shutdown(runtime, signal, options) {
    try {
      return await runtime.shutdown(signal, options);
    } finally {
      const id = runtime.session.id;
      if (runtime.exited && this.instances.get(id) === runtime) this.instances.delete(id);
    }
  }
  async stop(id) {
    const pending = this.starting.get(id);
    if (pending) await pending.promise.catch(() => {});
    const runtime = this.instances.get(id);
    await runtime?.stop();
    this.instances.delete(id);
  }
  async drainAcks() {
    await Promise.all([...this.starting.values()].map((start) => start.promise.catch(() => {})));
    await Promise.all([...this.instances.values()].map((runtime) => runtime.drainAcks?.()));
  }
  prepareClose() {
    this.closing = true;
    return Promise.all(
      [...this.instances.values()]
        .filter((runtime) => runtime instanceof PiRpc)
        .map((runtime) => {
          // Do not interrupt active commands/prompts: only a graceful exit which
          // has already started, or starts while admitted tools are draining.
          runtime.interruptShutdown = true;
          return runtime.gracefulExitPromise || runtime.exitSeal ? runtime.stop() : undefined;
        }),
    );
  }
  async close() {
    await this.prepareClose();
    await this.drainAcks();
    await Promise.all(
      [...new Set([...this.instances.keys(), ...this.starting.keys()])].map((id) => this.stop(id)),
    );
    this.observations.clear();
  }
}
