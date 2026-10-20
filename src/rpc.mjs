import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readLfLines } from './lf-lines.mjs';
import { LiveMessageObserver } from './live-message.mjs';
import { modelPage, sameModel, assertThinkingLevel, modelSetting } from './models.mjs';
import { assertImageModel } from './prompt-input.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSingleSessionFile, validateExecutionCwd } from './data.mjs';
import { rpcActivity } from './activity.mjs';
import { diagnostics } from './diagnostics.mjs';
import { bashCapture, nativeBashResult } from './bash-execution.mjs';
import { requestRpcStop, withdrawalCapture } from './stop-execution.mjs';
import { validatePiRuntime } from './owner-config.mjs';
import {
  reserveOwner,
  updateOwner,
  releaseOwner,
  processIdentity,
  readClaim,
  ownerAlive,
  AttachedRuntime,
  AttachmentFailure,
} from './attachments.mjs';
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
export function piCommand(config) {
  if (config.piExecutable !== undefined) {
    if (
      typeof config.piExecutable !== 'string' ||
      !path.isAbsolute(config.piExecutable) ||
      config.piExecutable.includes('\0')
    )
      throw new Error('INVALID_PI_EXECUTABLE');
    return { command: config.piExecutable, args: [] };
  }
  return {
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
          import.meta.url,
        ),
      ),
    ],
  };
}
const recoveryStorageCodes = new Set(['EIO', 'ENOSPC', 'EACCES', 'EROFS', 'EDQUOT']);
function recoveryPersistenceFailure(error) {
  const seen = new Set();
  for (
    let current = error;
    current && typeof current === 'object' && !seen.has(current);
    current = current.cause
  ) {
    if (
      current.code === 'RECEIPT_PERSIST_FAILED' ||
      current.message === 'RECEIPT_PERSIST_FAILED' ||
      recoveryStorageCodes.has(current.code)
    )
      return true;
    seen.add(current);
  }
  return false;
}
function recoveryError(failures) {
  if (!failures.size) return null;
  const error = new AggregateError([...failures], 'RECOVERY_PERSIST_FAILED');
  error.code = 'RECOVERY_PERSIST_FAILED';
  error.uncertain = true;
  return error;
}
export class PiRpc {
  constructor(config, session) {
    this.config = config;
    this.session = session;
    this.pending = new Map();
    this.recoveryTasks = new Set();
    this.recoveryFailures = new Set();
    this.liveMessage = new LiveMessageObserver('rpc_message_events');
    this.alive = false;
    this.exited = false;
    this.generation = randomUUID();
    this.promptAdmission = null;
    this.modelMutation = null;
    this.compactionMutation = null;
    this.settlement = {
      generation: this.generation,
      sequence: 0,
      observed_at: null,
      aborted: null,
    };
    this.handoffSettlement = 0;
  }
  async start() {
    await assertSingleSessionFile(this.session.file);
    const { env, toolArgs } = launchProfile(this.config);
    if (this.config.piRuntime?.agentDir)
      await fs.mkdir(this.config.piRuntime.agentDir, { recursive: true, mode: 0o700 });
    const executable = piCommand(this.config);
    try {
      if (this.config.attachmentDir) {
        this.ownerRecord = await reserveOwner(this.config.attachmentDir, this.session, 'rpc');
        await updateOwner(this.config.attachmentDir, this.session, this.ownerRecord, {
          socket: path.join(
            this.config.attachmentDir,
            `${process.pid}-${this.ownerRecord.generation.slice(0, 8)}.sock`,
          ),
        });
        env.PI_MCP_RPC_OBSERVER = JSON.stringify({
          socket: this.ownerRecord.socket,
          generation: this.ownerRecord.generation,
        });
      }
      // Recheck at the actual launch boundary: content preflight and owner
      // reservation may have taken time since discovery verified this path.
      await validateExecutionCwd(this.session.cwd);
      // Native environment/settings by default; only owner-selected overrides apply.
      this.child = spawn(
        executable.command,
        [
          ...executable.args,
          '--mode',
          'rpc',
          '--session',
          this.session.file,
          ...toolArgs,
          ...(this.config.piArgs ?? []),
          ...(this.ownerRecord
            ? ['-e', fileURLToPath(new URL('./rpc-observer.mjs', import.meta.url))]
            : []),
        ],
        { cwd: this.session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      if (this.ownerRecord)
        await releaseOwner(this.config.attachmentDir, this.session, this.ownerRecord);
      throw error;
    }
    this.alive = true;
    const runtimeLog = diagnostics.capture();
    this.child.once('spawn', () =>
      runtimeLog('runtime.spawned', { kind: 'rpc', generation: this.generation }),
    );
    this.child.stderr.resume(); // Drain diagnostics without retaining provider output.
    const fail = () => {
      this.alive = false;
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new RpcFailure('RUNTIME_DISCONNECTED', req.written));
      }
      this.pending.clear();
    };
    this.child.once('error', () => {
      if (!this.child.pid) this.exited = true;
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
      if (this.ownerRecord) {
        const owner = await processIdentity(this.child.pid);
        if (!owner) throw new RpcFailure('RUNTIME_START_FAILED');
        await updateOwner(this.config.attachmentDir, this.session, this.ownerRecord, {
          owner,
          phase: 'ready',
        });
      }
      await this.state(15000);
      return this;
    } catch {
      await this.stop();
      throw new RpcFailure('RUNTIME_START_FAILED');
    }
  }
  receiveResponse(event, generation) {
    if (generation !== this.generation || !event) return;
    this.liveMessage.update(event);
    if (event.type === 'agent_start') this.handoffSettlement = this.settlement.sequence + 1;
    if (event.type === 'agent_settled' && typeof event.aborted === 'boolean') {
      this.settlement = {
        generation,
        sequence: this.settlement.sequence + 1,
        observed_at: new Date().toISOString(),
        aborted: event.aborted,
      };
      return; // Session observation only; never release an unresolved prompt ACK fence.
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
      this.handoffSettlement = this.settlement.sequence + 1;
    if (
      this.compactionMutation?.id === event.id &&
      this.compactionMutation.generation === generation
    )
      this.compactionMutation = null;
    if (this.modelMutation?.id === event.id && this.modelMutation.generation === generation)
      this.modelMutation = null;
    if (this.promptAdmission?.id === event.id && this.promptAdmission.generation === generation)
      this.promptAdmission = null;
    const result = event.success
      ? { ok: true, data: event.data }
      : { ok: false, code: 'PI_REJECTED' };
    if (req.timedOut) {
      req.log?.('rpc.late_ack', {
        op: req.commandType,
        generation,
        late: true,
        status: result.ok ? 'ok' : 'error',
      });
      if (req.onLate) this.trackRecovery(() => req.onLate(result));
      return;
    }
    if (result.ok) req.resolve(result.data);
    else req.reject(new RpcFailure(result.code));
  }
  trackRecovery(work) {
    let task;
    try {
      task = Promise.resolve(work());
    } catch (error) {
      task = Promise.reject(error);
    }
    this.recoveryTasks.add(task);
    task.then(
      () => this.recoveryTasks.delete(task),
      (error) => {
        this.recoveryTasks.delete(task);
        if (recoveryPersistenceFailure(error)) {
          this.recoveryFailures.add(error);
          this.onRecoveryPersistenceFailure?.(error);
        }
        diagnostics.emit('operation.failure', {
          code: error.code ?? 'RECOVERY_FAILED',
          uncertain: true,
        });
      },
    );
    return task;
  }
  recoveryError() {
    return recoveryError(this.recoveryFailures);
  }
  async drainRecovery() {
    // Only ACKs already received create work here. Missing ACKs must not turn
    // normal shutdown into an unlimited wait for a disconnected runtime.
    while (this.recoveryTasks.size) await Promise.allSettled([...this.recoveryTasks]);
  }
  async command(command, timeout = 5000, onLate, beforeDispatch) {
    if (command.type === 'get_state') return this.state(timeout);
    await this.state();
    const late =
      onLate &&
      (async (result) => {
        const state = await this.dispatch({ type: 'get_state' });
        if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id)
          throw new RpcFailure('RUNTIME_SESSION_CHANGED');
        await onLate(result);
      });
    await beforeDispatch?.();
    let result, rejection;
    try {
      result = await this.dispatch(command, timeout, late);
    } catch (error) {
      if (error.code !== 'PI_REJECTED') throw error;
      rejection = error;
    }
    let checkedState;
    try {
      checkedState = await this.state();
    } catch (error) {
      if (['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type))
        error.uncertain = true;
      throw error;
    }
    if (rejection) throw rejection;
    if (command.type === 'get_entries')
      return {
        ...result,
        activity: rpcActivity(checkedState, Boolean(this.promptAdmission), this.settlement),
        live: this.liveMessage.snapshot(),
      };
    return result;
  }
  dispatch(command, timeout = 5000, onLate) {
    return diagnostics.measure(
      'rpc.command',
      { op: command.type, generation: this.generation },
      () => this.dispatchRequest(command, timeout, onLate),
    );
  }
  dispatchRequest(command, timeout = 5000, onLate) {
    if (!this.alive) return Promise.reject(new RpcFailure('RUNTIME_DISCONNECTED'));
    if (this.handoffPending && !['get_state', 'get_entries'].includes(command.type))
      return Promise.reject(new RpcFailure('HANDOFF_PENDING'));
    if (this.gracefulExitPromise) return Promise.reject(new RpcFailure('RUNTIME_SHUTTING_DOWN'));
    if (
      ['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type) &&
      this.compactionMutation
    )
      return Promise.reject(new RpcFailure('COMPACTION_PENDING'));
    if (
      ['prompt', 'set_model', 'set_thinking_level', 'compact'].includes(command.type) &&
      this.modelMutation
    )
      return Promise.reject(new RpcFailure('MODEL_SELECTION_PENDING'));
    if (['prompt', 'compact'].includes(command.type) && this.promptAdmission)
      return Promise.reject(new RpcFailure('PROMPT_ADMISSION_PENDING'));
    const id = randomUUID(),
      generation = this.generation;
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
        written: false,
        timedOut: false,
        log: diagnostics.capture(),
      };
      const discardRead = () => {
        if (
          [
            'get_state',
            'get_entries',
            'get_available_models',
            'get_available_thinking_levels',
          ].includes(command.type)
        )
          this.pending.delete(id);
      };
      req.timer = setTimeout(() => {
        req.timedOut = true;
        discardRead();
        reject(new RpcFailure('ACK_TIMEOUT', req.written));
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
        reject(new RpcFailure('WRITE_UNKNOWN', true));
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
  async state(timeout = 5000) {
    const state = await this.dispatch({ type: 'get_state' }, timeout);
    if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id) {
      await this.stop();
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    }
    return state;
  }
  entries() {
    return this.command({ type: 'get_entries' });
  }
  async models(args = {}) {
    const result = await this.command({ type: 'get_available_models' });
    const state = await this.state();
    return modelPage(result.models, state.model, state.thinkingLevel, args);
  }
  async checkedState() {
    // Idle checks and owner maintenance must never stop a mismatched session.
    const state = await this.dispatch({ type: 'get_state' });
    if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id)
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    return state;
  }
  async idleSnapshot() {
    const state = await this.checkedState();
    const pendingWork = () =>
      this.promptAdmission ||
      this.modelMutation ||
      this.compactionMutation ||
      this.settlement.sequence < this.handoffSettlement ||
      [...this.pending.values()].some(
        (r) =>
          ![
            'get_state',
            'get_entries',
            'get_available_models',
            'get_available_thinking_levels',
          ].includes(r.commandType),
      );
    if (
      pendingWork() ||
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
    if (observed.isIdle === false || observed.hasPendingMessages === true || pendingWork())
      return { state, status: 'busy' };
    // Pi 1.1 cannot correlate independent extension preflight with an RPC ACK.
    // Historical RPC input counts are not evidence of unfinished work.
    if (
      observed.nonRpcInputSeen !== false ||
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
    { images, thinkingLevel, idle = false, timeout = 5000, beforeDispatch, report, onLate } = {},
  ) {
    if (this.modelMutation) throw new RpcFailure('MODEL_SELECTION_PENDING');
    if (this.promptAdmission) throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    if (idle) await this.assertIdle();
    const { models } = await this.command({ type: 'get_available_models' });
    const initial = await this.state();
    const target = models?.find((m) => sameModel(m, model ?? initial.model));
    if (!target) throw new RpcFailure('MODEL_UNAVAILABLE');
    assertImageModel(images, target);
    assertThinkingLevel(target, thinkingLevel);
    const state = idle ? await this.assertIdle() : await this.state();
    await beforeDispatch?.();
    if (!sameModel(state.model, target)) {
      report?.('unknown');
      // A timed-out set_model keeps subsequent input fenced until its exact ACK.
      // Never submit the prompt from a late selection ACK.
      const changed = await this.command(
        { type: 'set_model', provider: target.provider, modelId: target.id },
        timeout,
        (result) =>
          onLate?.({
            ...result,
            phase: 'model',
            selected_model: { provider: target.provider, id: target.id },
          }),
        beforeDispatch,
      );
      if (!sameModel(changed, target)) throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
      report?.('selected');
    }
    let selected = idle ? await this.assertIdle() : await this.state();
    if (!sameModel(selected.model, target)) throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
    if (thinkingLevel !== undefined && selected.thinkingLevel !== thinkingLevel) {
      await this.command(
        { type: 'set_thinking_level', level: thinkingLevel },
        timeout,
        (result) =>
          onLate?.({
            ...result,
            phase: 'thinking',
            selected_model: { provider: target.provider, id: target.id },
          }),
        beforeDispatch,
      );
      selected = await this.state();
      if (!sameModel(selected.model, target)) throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
    }
    report?.('selected');
    return modelSetting(selected.model, selected.thinkingLevel, state.thinkingLevel, thinkingLevel);
  }
  async executeBash({ command, timeout_ms = 5000, recovery_id, beforeDispatch, onLate }) {
    const check = async () => {
      const state = await this.dispatch({ type: 'get_state' });
      if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id)
        throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    };
    try {
      await check();
    } catch (error) {
      error.uncertain = false;
      throw error;
    }
    await beforeDispatch?.();
    const capture = bashCapture(
      this.config.attachmentDir,
      this.session,
      this.generation,
      recovery_id,
    );
    const keep = async (result) => {
      await check();
      await capture(nativeBashResult(result));
    };
    let acknowledged = false;
    try {
      const result = await this.dispatch({ type: 'bash', command }, timeout_ms, (response) => {
        if (response.ok) return keep(response.data).then(() => onLate?.());
      });
      acknowledged = true;
      await keep(result);
    } catch (error) {
      if (acknowledged || error.code === 'PI_REJECTED') error.uncertain = true;
      throw error;
    }
  }
  async stopExecution({ timeout_ms = 5000, recovery_id } = {}) {
    // Cancellation identity failures must not use state()'s process teardown.
    const check = async () => {
      const state = await this.dispatch({ type: 'get_state' });
      if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id)
        throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    };
    try {
      await check();
    } catch (error) {
      error.uncertain = false;
      throw error;
    }
    try {
      const capture = withdrawalCapture(
        this.config.attachmentDir,
        this.session,
        this.generation,
        recovery_id,
      );
      const result = await requestRpcStop(
        {
          clearQueue: () =>
            this.dispatch({ type: 'clear_queue' }, timeout_ms, (result) => {
              // Existing late-ACK recovery must not discard withdrawn text.
              if (result.ok) return check().then(() => capture(result.data));
            }),
          abort: () => this.dispatch({ type: 'abort' }, timeout_ms),
          abortBash: () => this.dispatch({ type: 'abort_bash' }, timeout_ms),
        },
        async (value) => {
          await check();
          await capture(value);
        },
      );
      await check();
      return result;
    } catch (error) {
      error.uncertain = true;
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
  async gracefulExit() {
    if (this.gracefulExitPromise) return this.gracefulExitPromise;
    if (!this.child || this.exited || !this.alive) throw new RpcFailure('RUNTIME_DISCONNECTED');
    const child = this.child,
      record = this.ownerRecord;
    if (!record || record.owner?.pid !== child.pid || !(await ownerAlive(record.owner)))
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    await this.drainRecovery();
    this.gracefulExitPromise = (async () => {
      await new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => {
          if (code !== 0 || signal) reject(new RpcFailure('RUNTIME_EXIT_ABNORMAL'));
          else resolve();
        });
        // Native RPC EOF awaits session_shutdown. No signal, abort, clear_queue,
        // timeout escalation, or shutdown acknowledgment substitutes for exit.
        child.stdin.end();
      });
      if (await ownerAlive(record.owner)) throw new RpcFailure('OWNER_STILL_ALIVE');
      this.lines?.close();
      await releaseOwner(this.config.attachmentDir, this.session, record);
      this.ownerRecord = null;
    })();
    return this.gracefulExitPromise;
  }
  async stop() {
    await this.drainRecovery();
    if (this.gracefulExitPromise && !this.exited) {
      await this.gracefulExitPromise;
      return;
    }
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
    this.stopPromise = (async () => {
      let observeExit;
      const exited = new Promise((resolve) => {
        observeExit = resolve;
        this.child.once('exit', observeExit);
      });
      try {
        if (this.child.kill('SIGTERM') === false) throw new RpcFailure('RUNTIME_STOP_FAILED');
        // Explicit shutdown may interrupt work; elapsed time never authorizes
        // force-kill. Keep ownership until this child exits.
        await exited;
      } finally {
        this.child.off('exit', observeExit);
      }
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
  constructor(config, factory) {
    this.config = config;
    this.attachmentDir =
      config.attachmentDir ?? (config.stateDir ? path.join(config.stateDir, 'ipc') : undefined);
    this.factory =
      factory ??
      ((session) => new PiRpc({ ...config, attachmentDir: this.attachmentDir }, session).start());
    this.instances = new Map();
    this.starting = new Map();
    this.recoveryFailures = new Set();
  }
  rememberRecovery(runtime) {
    for (const error of runtime?.recoveryFailures ?? []) this.recoveryFailures.add(error);
  }
  watchRecovery(runtime) {
    this.rememberRecovery(runtime);
    if (runtime instanceof PiRpc)
      runtime.onRecoveryPersistenceFailure = (error) => this.recoveryFailures.add(error);
    return runtime;
  }
  recoveryError() {
    for (const runtime of this.instances.values()) this.rememberRecovery(runtime);
    return recoveryError(this.recoveryFailures);
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
    if (this.starting.has(session.id)) return this.starting.get(session.id);
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
      if (
        claim?.noColdReacquire &&
        !(
          claim.kind === 'tui' &&
          claim.phase === 'transitioning' &&
          claim.coldReacquireAfterExit === true &&
          claim.owner !== null &&
          !(await ownerAlive(claim.owner))
        )
      )
        throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    }
    const existing = this.instances.get(session.id);
    if (existing?.alive) return existing;
    if (existing) await existing.stop();
    if (this.starting.has(session.id)) return this.starting.get(session.id);
    const start = diagnostics
      .measure('runtime.start', { kind: 'rpc' }, () => this.factory(session))
      .then((runtime) => {
        this.watchRecovery(runtime);
        this.instances.set(session.id, runtime);
        return runtime;
      })
      .finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, start);
    return start;
  }
  get(id) {
    const r = this.instances.get(id);
    return r?.alive ? r : null;
  }
  async stopForDelete(session) {
    const pending = this.starting.get(session.id);
    if (pending) await pending.catch(() => {});
    const runtime = await this.forRead(session);
    if (runtime?.attached) {
      await runtime.stopForDelete();
      this.instances.delete(session.id);
    } else await this.stop(session.id);
    if (this.attachmentDir) {
      // Keep a cooperative owner claim across the filesystem move, including saved-session deletes.
      const deletion = await reserveOwner(this.attachmentDir, session, 'delete');
      return () => releaseOwner(this.attachmentDir, session, deletion);
    }
  }
  async stop(id) {
    const pending = this.starting.get(id);
    if (pending) await pending.catch(() => {});
    const runtime = this.instances.get(id);
    try {
      await runtime?.stop();
    } finally {
      this.rememberRecovery(runtime);
    }
    this.instances.delete(id);
  }
  async drainRecovery() {
    await Promise.all([...this.starting.values()].map((p) => p.catch(() => {})));
    await Promise.all(
      [...this.instances.values()].map(async (runtime) => {
        try {
          await runtime.drainRecovery?.();
        } finally {
          this.rememberRecovery(runtime);
        }
      }),
    );
  }
  async close() {
    await this.drainRecovery();
    await Promise.all(
      [...new Set([...this.instances.keys(), ...this.starting.keys()])].map((id) => this.stop(id)),
    );
  }
}
