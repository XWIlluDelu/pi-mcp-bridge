import fs from 'node:fs/promises';
import { resolvePiInstallation } from './pi-installation.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findHerdr } from './herdr-control.mjs';
import { HerdrRpcTransport } from './herdr-rpc-transport.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readLfLines } from './lf-lines.mjs';
import { READ_CONTRACT } from './context-read.mjs';
import { RetainedObservations } from './context-observation.mjs';
import { sameModel, assertThinkingLevel, modelSetting } from './models.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSingleSessionFile, validateExecutionCwd } from './data.mjs';
import { diagnostics } from './diagnostics.mjs';
import { nativeCompactReason } from './compact.mjs';
import { uiFacts, uiSnapshot } from './rpc-ui.mjs';
import { RuntimeEvents } from './runtime-events.mjs';
import { limitBashResult } from './bash-execution.mjs';
import { requestRpcStop, withdrawalCollector } from './stop-execution.mjs';
import { validatePiRuntime, validateLaunchArgs, readOwnerConfig } from './owner-config.mjs';
import {
  reserveOwner,
  acquireDeletion,
  updateOwner,
  releaseOwner,
  processIdentity,
  readClaim,
  ownerAlive,
  AttachedRuntime,
  AttachmentFailure,
} from './attachments.mjs';
const READ_COMMANDS = new Set([
  'get_state',
  'get_entries',
  'get_available_models',
  'get_available_thinking_levels',
]);
export class RpcFailure extends Error {
  constructor(code, uncertain = false) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
  }
}
export function launchProfile(config, hostEnv = process.env) {
  const profile = config.piRuntime ?? {};
  validatePiRuntime(profile);
  const inheritEnv = profile.inheritEnv ?? undefined,
    tools = profile.tools ?? undefined;
  const env =
    inheritEnv === undefined
      ? { ...hostEnv }
      : Object.fromEntries(
          inheritEnv
            .filter((name) => hostEnv[name] !== undefined)
            .map((name) => [name, hostEnv[name]]),
        );
  if (inheritEnv !== undefined) env.PATH ??= hostEnv.PATH ?? '/usr/bin:/bin';
  if (profile.agentDir !== undefined) env.PI_CODING_AGENT_DIR = profile.agentDir;
  // Pi resolves HOME, its native agent directory and resource/settings defaults.
  return {
    env,
    toolArgs:
      tools === undefined ? [] : tools.length ? ['--tools', tools.join(',')] : ['--no-tools'],
  };
}
export class PiRpc {
  constructor(config, session, { completionControl, compatibility } = {}) {
    this.compatibility = compatibility;
    this.config = config;
    this.completionControl = completionControl;
    this.session = session;
    this.pending = new Map();
    this.activeBashes = 0;
    this.uiFacts = uiFacts();
    this.phase = 'startup';
    this.ackTasks = new Set();
    this.alive = false;
    this.exited = false;
    this.generation = randomUUID();
    this.runtimeEvents = new RuntimeEvents(this.generation);
    this.promptAdmission = null;
    this.pendingInputs = 0;
    this.inputActivitySequence = 0;
    this.modelMutation = null;
    this.compactionMutation = null;
    this.exitSeal = null;
    this.settlementSequence = 0;
    this.requiredSettlementSequence = 0;
    this.launchSettled = Promise.withResolvers();
  }
  async start(signal) {
    try {
      return await this.startRuntime(signal);
    } finally {
      this.launchSettled.resolve();
    }
  }
  async startRuntime(signal) {
    signal?.throwIfAborted();
    validateLaunchArgs(this.config.piArgs);
    await assertSingleSessionFile(this.session.file);
    const { env, toolArgs } = launchProfile(this.config);
    if (this.config.piRuntime?.agentDir)
      await fs.mkdir(this.config.piRuntime.agentDir, { recursive: true, mode: 0o700 });
    const executable = await resolvePiInstallation(this.config, env);
    signal?.throwIfAborted();
    try {
      if (this.config.attachmentDir) {
        this.ownerRecord = await reserveOwner(this.config.attachmentDir, this.session, 'rpc');
        await updateOwner(this.config.attachmentDir, this.session, this.ownerRecord, {
          socket: path.join(
            this.config.attachmentDir,
            `${process.pid}-${this.ownerRecord.generation.slice(0, 8)}.sock`,
          ),
        });
        // An installed daily companion must use this writer's actual registry,
        // not an unrelated default owner profile, then defer to the RPC claim.
        env.PI_MCP_ATTACH_DIR = this.config.attachmentDir;
        env.PI_MCP_RPC_OBSERVER = JSON.stringify({
          socket: this.ownerRecord.socket,
          generation: this.ownerRecord.generation,
          ownerControl: this.completionControl,
        });
      }
      // Recheck at the actual launch boundary: content preflight and owner
      // reservation may have taken time since discovery verified this path.
      await validateExecutionCwd(this.session.cwd);
      // Native environment/settings by default; only owner-selected overrides apply.
      const launch = {
        command: executable.command,
        args: [
          ...(this.ownerRecord
            ? ['-e', fileURLToPath(new URL('./rpc-observer.mjs', import.meta.url))]
            : []),
          '--mode',
          'rpc',
          '--session',
          this.session.file,
          ...toolArgs,
          ...(this.config.piArgs ?? []),
        ],
        cwd: this.session.cwd,
        env,
      };
      const herdr = this.config.herdr ? await findHerdr() : null;
      signal?.throwIfAborted();
      this.child = herdr
        ? new HerdrRpcTransport(herdr, launch, {
            signal,
            daemonEnvironment: this.compatibility?.daemonEnvironment.apply(process.env),
          })
        : spawn(launch.command, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch (error) {
      if (this.ownerRecord)
        await releaseOwner(this.config.attachmentDir, this.session, this.ownerRecord);
      throw error;
    }
    this.alive = true;
    this.observeExit(); // Install before the first asynchronous owner/readiness check.
    const runtimeLog = diagnostics.capture();
    this.child.once('spawn', () =>
      runtimeLog('runtime.spawned', { kind: 'rpc', generation: this.generation }),
    );
    this.child.stderr.resume(); // Drain diagnostics without retaining provider output.
    const fail = () => {
      this.alive = false;
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(
          Object.assign(
            new RpcFailure(this.startFailure?.code ?? 'RUNTIME_DISCONNECTED', req.written),
            uiSnapshot(req.uiFacts),
          ),
        );
      }
      this.pending.clear();
    };
    this.child.once('error', () => {
      if (!this.child.pid && !this.child.ready) this.exited = true;
      fail();
    });
    this.child.once('exit', () => {
      runtimeLog('runtime.exited', { kind: 'rpc', generation: this.generation });
      this.exited = true;
      this.promptAdmission = null;
      fail();
    });
    this.child.stdin.on('error', fail);
    const generation = this.generation;
    this.lines = readLfLines(this.child.stdout, (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      this.receiveResponse(event, generation);
    });
    try {
      await this.child.ready;
      this.childIdentity = await processIdentity(this.child.pid);
      if (this.ownerRecord) {
        const owner = this.childIdentity;
        if (!owner) throw new RpcFailure('RUNTIME_START_FAILED');
        await updateOwner(this.config.attachmentDir, this.session, this.ownerRecord, {
          owner,
          phase: 'ready',
          readContract: READ_CONTRACT,
        });
      }
      // Launch identity is now usable even if native readiness or its failure
      // cleanup never finishes. Delete need not wait for the ready promise.
      this.launchSettled.resolve();
      signal?.throwIfAborted();
      await this.state(15000);
      this.phase = 'running';
      return this;
    } catch (error) {
      this.launchSettled.resolve();
      if (this.child.abortStartup && !this.childIdentity) {
        await this.child.abortStartup();
        this.exited = true;
      }
      await this.stop();
      throw (
        this.startFailure ??
        new RpcFailure(error.message?.startsWith('HERDR_') ? error.message : 'RUNTIME_START_FAILED')
      );
    }
  }
  receiveResponse(event, generation) {
    if (generation !== this.generation || !event) return;
    if (this.runtimeEvents.observe(event)) return;
    if (event.type === 'extension_ui_request') {
      if (
        !['confirm', 'select', 'input', 'editor'].includes(event.method) ||
        typeof event.id !== 'string'
      )
        return;
      const phase =
        this.phase === 'startup'
          ? 'startup'
          : this.phase === 'shutdown' || this.child.stdin.writableEnded
            ? 'shutdown'
            : 'cancel_sent';
      this.uiFacts[phase].add(event.method);
      let log = diagnostics.capture();
      for (const request of this.pending.values()) {
        if (request.commandType !== 'prompt') continue;
        (request.uiFacts ??= uiFacts())[phase].add(event.method);
        log = request.log;
      }
      const code =
        phase === 'cancel_sent'
          ? 'EXTENSION_UI_CANCEL_SENT'
          : phase === 'startup'
            ? 'EXTENSION_UI_STARTUP_UNAVAILABLE'
            : 'EXTENSION_UI_SHUTDOWN_UNAVAILABLE';
      log('rpc.ui_request', { code, ui_method: event.method, generation });
      if (phase === 'cancel_sent') {
        // Written to a running reader; Pi does not ACK consumption/completion.
        this.child.stdin.write(
          JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n',
        );
      } else if (phase === 'startup') {
        this.startFailure = Object.assign(new RpcFailure(code), uiSnapshot(this.uiFacts));
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer);
          request.reject(this.startFailure);
          this.pending.delete(id);
        }
      }
      return;
    }
    if (event.type === 'agent_start') this.requiredSettlementSequence = this.settlementSequence + 1;
    if (event.type === 'agent_settled' && typeof event.aborted === 'boolean') {
      this.settlementSequence++;
      this.onIdleCandidate?.();
      return; // Settlement alone never clears an unresolved prompt ACK fence.
    }
    if (event.type !== 'response') return;
    const req = this.pending.get(event.id);
    if (!req || req.generation !== generation) return;
    // Only the matching prompt ACK is evidence of completed admission. State,
    // timers, unrelated events and malformed responses cannot clear uncertainty.
    if (
      req.commandType === 'prompt' &&
      (event.command !== 'prompt' ||
        (event.success !== false &&
          !(
            event.success === true &&
            ['started', 'queued', 'handled'].includes(event.data?.disposition)
          )))
    )
      return;
    if (
      [
        'set_model',
        'set_thinking_level',
        'compact',
        'bash',
        'clear_queue',
        'abort',
        'abort_bash',
      ].includes(req.commandType) &&
      (event.command !== req.commandType || typeof event.success !== 'boolean')
    )
      return;
    this.pending.delete(event.id);
    clearTimeout(req.timer);
    // A started/queued ACK is admission, never completion. In the supported
    // owned RPC path its run must subsequently settle, including queued work.
    if (
      req.commandType === 'prompt' &&
      event.success === true &&
      ['started', 'queued'].includes(event.data?.disposition)
    )
      this.requiredSettlementSequence = Math.max(
        this.requiredSettlementSequence,
        (req.settlementSequence ?? this.settlementSequence) + 1,
      );
    if (
      this.compactionMutation?.id === event.id &&
      this.compactionMutation.generation === generation
    )
      this.compactionMutation = null;
    if (this.modelMutation?.id === event.id && this.modelMutation.generation === generation)
      this.modelMutation = null;
    if (this.promptAdmission?.id === event.id && this.promptAdmission.generation === generation)
      this.promptAdmission = null;
    const notifyIdle = () => {
      if (!READ_COMMANDS.has(req.commandType)) this.onIdleCandidate?.();
    };
    const ui = uiSnapshot(req.uiFacts);
    const result = event.success
      ? { ok: true, data: ui.ui ? { ...event.data, ...ui } : event.data }
      : {
          ok: false,
          code: 'PI_REJECTED',
          ...(req.commandType === 'compact'
            ? { native_reason: nativeCompactReason(event.error) }
            : {}),
          ...ui,
        };
    if (req.timedOut) {
      req.log?.('rpc.late_ack', {
        op: req.commandType,
        generation,
        late: true,
        status: result.ok ? 'ok' : 'error',
      });
      if (req.onLate) this.trackAck(() => req.onLate(result));
      notifyIdle();
      return;
    }
    if (result.ok) req.resolve(result.data);
    else
      req.reject(
        Object.assign(new RpcFailure(result.code), ui, { native_reason: result.native_reason }),
      );
    notifyIdle();
  }
  trackAck(work) {
    let task;
    try {
      task = Promise.resolve(work());
    } catch (error) {
      task = Promise.reject(error);
    }
    this.ackTasks.add(task);
    task.then(
      () => this.ackTasks.delete(task),
      (error) => {
        this.ackTasks.delete(task);
        diagnostics.emit('operation.failure', {
          code: error.code ?? 'OTHER_ERROR',
          uncertain: true,
        });
      },
    );
    return task;
  }
  async drainAcks() {
    // Only ACKs already received create work here. Missing ACKs must not turn
    // normal shutdown into an unlimited wait for a disconnected runtime.
    while (this.ackTasks.size) await Promise.allSettled([...this.ackTasks]);
  }
  async command(command, timeout = 5000, onLate, beforeDispatch, allowBusySelection = false) {
    if (command.type === 'get_state') return this.state(timeout);
    await this.state();
    const late =
      onLate &&
      (async (result) => {
        const state = await this.dispatch({ type: 'get_state' });
        this.assertSessionIdentity(state);
        await onLate(result);
      });
    await beforeDispatch?.();
    let result, rejection;
    try {
      result = await this.dispatch(command, timeout, late, allowBusySelection);
    } catch (error) {
      if (error.code !== 'PI_REJECTED') throw error;
      rejection = error;
    }
    try {
      await this.state();
    } catch (error) {
      if (['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type))
        error.uncertain = true;
      const observedUI = result?.ui ?? rejection?.ui;
      if (observedUI && !error.ui) error.ui = observedUI;
      throw error;
    }
    if (rejection) throw rejection;
    return result;
  }
  dispatch(command, timeout = 5000, onLate, allowBusySelection = false) {
    return diagnostics.measure(
      'rpc.command',
      { op: command.type, generation: this.generation },
      () => this.dispatchRequest(command, timeout, onLate, allowBusySelection),
    );
  }
  dispatchRequest(command, timeout = 5000, onLate, allowBusySelection = false) {
    if (this.startFailure) return Promise.reject(this.startFailure);
    if (!this.alive) return Promise.reject(new RpcFailure('RUNTIME_DISCONNECTED'));
    if (this.handoffPending && !['get_state', 'get_entries'].includes(command.type))
      return Promise.reject(new RpcFailure('HANDOFF_PENDING'));
    if (this.gracefulExitPromise) return Promise.reject(new RpcFailure('RUNTIME_SHUTTING_DOWN'));
    if (
      ['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type) &&
      this.compactionMutation &&
      !(allowBusySelection && ['set_model', 'set_thinking_level'].includes(command.type))
    )
      return Promise.reject(new RpcFailure('COMPACTION_PENDING'));
    if (
      ['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type) &&
      this.modelMutation
    )
      return Promise.reject(new RpcFailure('MODEL_SELECTION_PENDING'));
    if (['prompt', 'compact'].includes(command.type) && this.promptAdmission)
      return Promise.reject(new RpcFailure('PROMPT_ADMISSION_PENDING'));
    const id = command.id ?? randomUUID(),
      generation = this.generation;
    if (typeof id !== 'string' || !id.length || id.length > 128 || this.pending.has(id))
      return Promise.reject(new RpcFailure('INVALID_ARGUMENTS'));
    const serialized = `${JSON.stringify({ ...command, id })}\n`;
    if (command.type === 'prompt') this.promptAdmission = { id, generation };
    if (['set_model', 'set_thinking_level'].includes(command.type))
      this.modelMutation = { id, generation };
    if (command.type === 'compact') this.compactionMutation = { id, generation };
    return new Promise((resolve, reject) => {
      const req = {
        resolve,
        reject,
        onLate: onLate && diagnostics.bind(onLate),
        generation,
        commandType: command.type,
        settlementSequence: this.settlementSequence,
        written: false,
        timedOut: false,
        log: diagnostics.capture(),
      };
      const discardRead = () => {
        if (READ_COMMANDS.has(command.type)) this.pending.delete(id);
      };
      req.timer = setTimeout(() => {
        req.timedOut = true;
        discardRead();
        reject(Object.assign(new RpcFailure('ACK_TIMEOUT', req.written), uiSnapshot(req.uiFacts)));
        // Reads have no durable side effect or useful late result. Prompts keep
        // their authoritative late-ACK recovery and admission fence.
      }, timeout);
      this.pending.set(id, req);
      req.written = true;
      const writeFailed = () => {
        clearTimeout(req.timer);
        req.timedOut = true;
        discardRead();
        // A write error does not prove that Pi failed to receive the command.
        // Keep matching ACK recovery possible and keep the admission fence.
        reject(Object.assign(new RpcFailure('WRITE_UNKNOWN', true), uiSnapshot(req.uiFacts)));
      };
      try {
        this.child.stdin.write(serialized, (err) => {
          if (err) writeFailed();
        });
      } catch {
        writeFailed();
      }
    });
  }
  assertSessionIdentity(state) {
    if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id) {
      this.runtimeEvents.invalidate();
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    }
  }
  async state(timeout = 5000) {
    const state = await this.dispatch({ type: 'get_state' }, timeout);
    this.assertSessionIdentity(state);
    return state;
  }
  async observeRead(read) {
    if (this.sealPending || this.gracefulExitPromise) throw new RpcFailure('RUNTIME_SHUTTING_DOWN');
    this.activeReads = (this.activeReads ?? 0) + 1;
    try {
      return await read();
    } finally {
      this.activeReads--;
      this.onIdleCandidate?.();
    }
  }
  readFeatures() {
    return this.observeRead(() =>
      new AttachedRuntime(this.config, this.session, this.ownerRecord).readFeatures(),
    );
  }
  read(args) {
    return this.observeRead(() =>
      new AttachedRuntime(this.config, this.session, this.ownerRecord, {
        compatibility: this.compatibility,
      }).read(args),
    );
  }
  entries() {
    return this.observeRead(() => this.command({ type: 'get_entries' }));
  }
  observeInputActivity({ pendingInputs, sequence }) {
    if (
      !Number.isSafeInteger(pendingInputs) ||
      pendingInputs < 0 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw new RpcFailure('OWNER_COMPONENT_UPDATE_REQUIRED');
    if (sequence > this.inputActivitySequence) {
      this.inputActivitySequence = sequence;
      this.pendingInputs = pendingInputs;
      if (!pendingInputs) this.onIdleCandidate?.();
    }
  }
  hasUnsettledWork({ includeInputs = true } = {}) {
    return Boolean(
      this.activeBashes > 0 ||
      (includeInputs && this.pendingInputs > 0) ||
      this.promptAdmission ||
      this.modelMutation ||
      this.compactionMutation ||
      this.settlementSequence < this.requiredSettlementSequence ||
      [...this.pending.values()].some((r) => !READ_COMMANDS.has(r.commandType)),
    );
  }
  async idleSnapshot() {
    const state = await this.state();
    if (
      this.hasUnsettledWork({ includeInputs: false }) ||
      state.isStreaming === true ||
      state.isCompacting === true ||
      state.pendingMessageCount > 0
    )
      return { state, status: 'busy' };
    if (
      state.isStreaming !== false ||
      state.isCompacting !== false ||
      state.pendingMessageCount !== 0 ||
      !this.ownerRecord?.socket
    )
      return { state, status: 'unconfirmed' };
    const observed = await new AttachedRuntime(this.config, this.session, this.ownerRecord).state();
    this.observeInputActivity(observed);
    if (
      observed.isIdle === false ||
      observed.hasPendingMessages === true ||
      observed.pendingInputs > 0 ||
      this.hasUnsettledWork()
    )
      return { state, status: 'busy' };
    if (
      observed.pendingInputs !== 0 ||
      observed.isIdle !== true ||
      observed.hasPendingMessages !== false
    )
      return { state, status: 'unconfirmed' };
    return { state, status: 'idle' };
  }
  async assertIdle({
    busy = 'MODEL_SELECTION_BUSY',
    unconfirmed = 'MODEL_SELECTION_IDLE_UNCONFIRMED',
  } = {}) {
    if (this.modelMutation) throw new RpcFailure('MODEL_SELECTION_PENDING');
    const result = await this.idleSnapshot();
    if (result.status !== 'idle')
      throw new RpcFailure(result.status === 'busy' ? busy : unconfirmed);
    return result.state;
  }
  // Native selection is persistent session state, NOT a per-prompt binding.
  // Active provider calls keep their captured model; later calls/queued inputs
  // consult the then-current selection. The Bridge lane orders our selection
  // and submission, not the complete run or unrelated native extension work.
  async selectModel(
    model,
    { thinkingLevel, idle = false, nativeThinking = false, timeout = 5000, beforeDispatch } = {},
  ) {
    if (this.modelMutation) throw new RpcFailure('MODEL_SELECTION_PENDING');
    if (idle && this.promptAdmission) throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    if (idle) await this.assertIdle();
    const models = model ? (await this.command({ type: 'get_available_models' })).models : null;
    const initial = await this.state();
    let target = model ? models?.find((m) => sameModel(m, model)) : initial.model;
    if (!target) throw new RpcFailure('MODEL_UNAVAILABLE');
    if (!nativeThinking) await assertThinkingLevel(target, thinkingLevel, this.config);
    const state = idle ? await this.assertIdle() : await this.state();
    await beforeDispatch?.();
    if (!model) {
      target = state.model;
      if (!nativeThinking) await assertThinkingLevel(target, thinkingLevel, this.config);
    }
    let level = thinkingLevel;
    if (model && !sameModel(state.model, target)) {
      // Keep current effort rather than model-switch defaults; Pi owns clamping.
      level ??= state.thinkingLevel;
      // A timed-out setter keeps input fenced until its matching native ACK.
      // command() verifies late identity but never submits a prompt from that ACK.
      const changed = await this.command(
        { type: 'set_model', provider: target.provider, modelId: target.id },
        timeout,
        () => {},
        beforeDispatch,
        !idle,
      );
      if (!sameModel(changed, target)) throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
    }
    let selected = idle ? await this.assertIdle() : await this.state();
    if (model && !sameModel(selected.model, target))
      throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
    if (!nativeThinking) await assertThinkingLevel(selected.model, thinkingLevel, this.config);
    if (level !== undefined && selected.thinkingLevel !== level) {
      await this.command(
        { type: 'set_thinking_level', level },
        timeout,
        () => {},
        beforeDispatch,
        !idle,
      );
      selected = await this.state();
      if (
        (model && !sameModel(selected.model, target)) ||
        (!nativeThinking && thinkingLevel !== undefined && selected.thinkingLevel !== thinkingLevel)
      )
        throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
    }
    return modelSetting(selected.model, selected.thinkingLevel);
  }
  async executeBash({ command, timeout_ms = 5000, max_chars, beforeDispatch }) {
    this.activeBashes++;
    const check = async () =>
      this.assertSessionIdentity(await this.dispatch({ type: 'get_state' }));
    try {
      try {
        await check();
      } catch (error) {
        error.uncertain = false;
        throw error;
      }
      await beforeDispatch?.();
      let acknowledged = false;
      try {
        const result = await this.dispatch({ type: 'bash', command }, timeout_ms, check);
        acknowledged = true;
        await check();
        return limitBashResult(result, max_chars);
      } catch (error) {
        if (acknowledged || error.code === 'PI_REJECTED') error.uncertain = true;
        throw error;
      }
    } finally {
      this.activeBashes--;
      this.onIdleCandidate?.();
    }
  }
  async stopExecution({ timeout_ms = 5000, max_chars } = {}) {
    const check = async () =>
      this.assertSessionIdentity(await this.dispatch({ type: 'get_state' }));
    try {
      await check();
    } catch (error) {
      error.uncertain = false;
      throw error;
    }
    const withdrawn = withdrawalCollector(max_chars);
    try {
      const receipt = await requestRpcStop(
        {
          clearQueue: () =>
            this.dispatch({ type: 'clear_queue' }, timeout_ms, async () => {
              await check(); // Validate received late ACKs, without retaining a result for lookup.
            }),
          abort: () => this.dispatch({ type: 'abort' }, timeout_ms),
          abortBash: () => this.dispatch({ type: 'abort_bash' }, timeout_ms),
        },
        async (value) => {
          await check();
          withdrawn.add(value);
        },
      );
      await check();
      return { ...receipt, withdrawal: withdrawn.value };
    } catch (error) {
      error.uncertain = true;
      if (withdrawn.value) error.result = { withdrawal: { ...withdrawn.value, complete: false } };
      throw error;
    }
  }
  async assertReleasable() {
    if (this.promptAdmission) throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    await this.assertIdle({ busy: 'RUNTIME_BUSY', unconfirmed: 'RUNTIME_IDLE_UNCONFIRMED' });
  }
  async waitForHandoff(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const result = await this.idleSnapshot();
      if (result.status === 'unconfirmed') throw new RpcFailure('RUNTIME_IDLE_UNCONFIRMED');
      if (result.status === 'idle') {
        signal?.throwIfAborted();
        return;
      }
      await delay(25, undefined, { signal });
    }
  }
  observeExit() {
    if (this.exitObservation?.child === this.child) return this.exitObservation;
    const observation = { child: this.child, result: null };
    observation.promise = new Promise((resolve, reject) => {
      this.child.once('exitError', reject);
      this.child.once('exit', (code, signal) => {
        observation.result = { code, signal };
        this.exited = true;
        this.alive = false;
        resolve(observation.result);
      });
    });
    observation.promise.catch(() => {});
    observation.closed = this.child.stdout
      ? new Promise((resolve, reject) => {
          this.child.once('close', resolve);
          this.child.once('exitError', reject);
        })
      : observation.promise;
    observation.closed.catch(() => {});
    this.exitObservation = observation;
    return observation;
  }
  async gracefulExit(signal) {
    if (this.gracefulExitPromise) return this.gracefulExitPromise;
    if (!this.child || this.exited || !this.alive) throw new RpcFailure('RUNTIME_DISCONNECTED');
    const child = this.child,
      record = this.ownerRecord,
      exit = this.observeExit();
    const previousSeal = this.exitSeal;
    try {
      await this.assertProcessIdentity(child, record);
      // Preserve the last cleaned request before the short-lived child exits.
      // This precedes the final drain/guard; capture cannot bypass in-flight work.
      await this.retainObservation?.();
      await this.drainAcks();
      signal?.throwIfAborted();
      if (exit.result || this.exited || !this.alive)
        throw new RpcFailure('RUNTIME_EXIT_BEFORE_EOF');
      // Parent observations reject known work early. Only the child's atomic
      // seal can authorize EOF; activity notifications may still be in flight.
      if (
        this.hasUnsettledWork({ includeInputs: !previousSeal }) ||
        this.activeReads ||
        this.ackTasks.size
      )
        throw new RpcFailure('RUNTIME_BUSY');
      const sealed = await new AttachedRuntime(this.config, this.session, record).seal(() => {
        signal?.throwIfAborted();
        if (
          this.hasUnsettledWork({ includeInputs: !previousSeal }) ||
          this.activeReads ||
          this.ackTasks.size
        )
          throw new RpcFailure('RUNTIME_BUSY');
        // Close read admission across the control request's await. A read
        // already admitted above keeps this attempt from sealing the writer.
        this.sealPending = true;
        // Once written, lost acknowledgment cannot prove that admission remains
        // open. Keep the exact generation fenced until explicit retry or exit.
        this.exitSeal = 'unknown';
      });
      if (!sealed.sealed) {
        if (!previousSeal) this.exitSeal = null;
        throw new RpcFailure('RUNTIME_BUSY', Boolean(previousSeal));
      }
      this.exitSeal = 'sealed';
      this.gracefulExitPromise = (async () => {
        // Seal is irreversible. A later cancellation suppresses a destination,
        // not this already committed close. EOF remains the sole shutdown trigger.
        this.phase = 'shutdown';
        child.stdin.end();
        if (this.interruptShutdown) await this.stop();
        const result = await exit.promise;
        await exit.closed; // Drain final UI diagnostics as well as observing exact death.
        if (await ownerAlive(record.owner)) throw new RpcFailure('OWNER_STILL_ALIVE');
        this.lines?.close();
        await releaseOwner(this.config.attachmentDir, this.session, record);
        this.ownerRecord = null;
        if (result.code !== 0 || result.signal) throw new RpcFailure('RUNTIME_EXIT_ABNORMAL');
        // UI availability is a shutdown diagnostic, not another writer claim.
        return this.uiFacts.shutdown.size ? uiSnapshot(this.uiFacts) : {};
      })();
      return this.gracefulExitPromise;
    } catch (error) {
      if (!previousSeal && !error.uncertain && this.exitSeal === 'unknown') this.exitSeal = null;
      if (this.exitSeal) error.uncertain = true;
      throw error;
    } finally {
      this.sealPending = false;
    }
  }
  async assertProcessIdentity(child = this.child, record = this.ownerRecord) {
    if (!child || this.exited) return;
    if (child !== this.child || record !== this.ownerRecord)
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    const identity = record?.owner ?? this.childIdentity;
    if (!identity || identity.pid !== child.pid || !(await ownerAlive(identity)))
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    if (!record) return;
    const current = await readClaim(this.config.attachmentDir, this.session);
    if (
      current?.generation !== record.generation ||
      current.owner?.pid !== child.pid ||
      current.owner.start !== record.owner?.start ||
      current.owner.boot !== record.owner?.boot ||
      !(await ownerAlive(current.owner))
    )
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
  }
  async stop() {
    await this.drainAcks();
    const release = async () => {
      if (this.ownerRecord) {
        await releaseOwner(this.config.attachmentDir, this.session, this.ownerRecord);
        this.ownerRecord = null;
      }
    };
    if (!this.child || this.exited) {
      this.promptAdmission = null;
      await release();
      return;
    }
    if (this.stopPromise) return this.stopPromise;
    const child = this.child,
      record = this.ownerRecord,
      exit = this.observeExit();
    this.stopPromise = (async () => {
      if (!exit.result) {
        try {
          await this.assertProcessIdentity(child, record);
        } catch (error) {
          const owner = record?.owner ?? this.childIdentity;
          // Natural EOF can finish during /proc/claim checks. Only exact death
          // makes that failure harmless; a live or unknown owner still fails.
          if (!exit.result && (!owner || (await ownerAlive(owner)))) throw error;
          await exit.promise;
        }
        if (!exit.result && child.terminate) await child.terminate();
        if (!exit.result && !child.terminate && child.kill('SIGTERM') === false) {
          const owner = record?.owner ?? this.childIdentity;
          if (!exit.result && (!owner || (await ownerAlive(owner))))
            throw new RpcFailure('RUNTIME_STOP_FAILED');
        }
        // Explicit shutdown may interrupt work; elapsed time never authorizes force-kill.
        await exit.promise;
      }
      await exit.closed;
      this.exited = true;
      this.promptAdmission = null;
      this.lines?.close();
      if (this.ownerRecord?.socket)
        await fs.unlink(this.ownerRecord.socket).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      await release();
    })();
    try {
      return await this.stopPromise;
    } finally {
      // A failed signal/cleanup is not a permanently pending exit. A later
      // explicit stop may retry; no automatic replay or claim release occurs.
      this.stopPromise = null;
    }
  }
}
export class RuntimePool {
  constructor(config, factory, { configFile, completionControl, compatibility } = {}) {
    this.compatibility = compatibility;
    this.config = config;
    this.attachmentDir =
      config.attachmentDir ?? (config.stateDir ? path.join(config.stateDir, 'ipc') : undefined);
    this.factory =
      factory ??
      (async (session) => {
        // Placement is sampled only after reuse has been ruled out. It does not
        // alter the receive-time authorization snapshot or a running writer.
        const desired = configFile ? (await readOwnerConfig(configFile)).config : config;
        const desiredRegistry =
          desired.attachmentDir ??
          (desired.stateDir ? path.join(desired.stateDir, 'ipc') : undefined);
        // A different namespace cannot prove this target has no writer. This
        // affects only acquisition, not reads or reuse of an existing owner.
        if (desiredRegistry !== this.attachmentDir) throw new RpcFailure('CONFIG_RESTART_REQUIRED');
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
    if (!this.attachmentDir) return existing?.alive ? existing : null;
    const claim = await readClaim(this.attachmentDir, session);
    if (claim && (await ownerAlive(claim.owner))) {
      if (claim.kind === 'rpc') {
        if (existing?.alive && existing.ownerRecord?.generation === claim.generation)
          return existing;
        throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      }
      if (claim.phase !== 'ready') throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      if (existing?.attached && existing.alive && existing.record.generation === claim.generation)
        return existing;
      if (existing) await existing.stop();
      const attached = await diagnostics.measure(
        'runtime.attach',
        { kind: 'attached', generation: claim.generation },
        () =>
          new AttachedRuntime(
            { ...this.config, attachmentDir: this.attachmentDir },
            session,
            claim,
            { compatibility: this.compatibility },
          ).start(),
      );
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
    return existing?.alive ? existing : null;
  }
  async resolve(session) {
    if (this.starting.has(session.id)) return this.starting.get(session.id).promise;
    const attached = await this.forRead(session);
    if (attached) {
      diagnostics.emit('runtime.reused', {
        kind: attached.attached ? 'attached' : 'rpc',
        generation: attached.generation ?? attached.record?.generation,
      });
      return attached;
    }
    if (this.attachmentDir) {
      const claim = await readClaim(this.attachmentDir, session);
      if (claim?.noColdReacquire) throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    }
    const existing = this.instances.get(session.id);
    if (existing?.alive) return existing;
    if (existing) await existing.stop();
    if (this.starting.has(session.id)) return this.starting.get(session.id).promise;
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
    const deletion = this.attachmentDir ? await acquireDeletion(this.attachmentDir, session) : null;
    try {
      const claim = await deletion?.writer(),
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
      return deletion?.finish;
    } catch (error) {
      await deletion?.finish();
      throw error;
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
