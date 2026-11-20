import fs from 'node:fs/promises';
import {
  resolvePiInstallation,
  piLaunchEnvironment,
  loadPiSdk,
  loadPiAi,
} from './pi-installation.mjs';
import { spawn } from 'node:child_process';
import { findHerdr } from './herdr-control.mjs';
import { HerdrRpcTransport, prepareHerdr } from './herdr-rpc-transport.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readLfLines } from '../core/lf-lines.mjs';
import { nativeBusy, pendingMessages, ownerProtocol } from './attachment-protocol.mjs';
import { sameModel, assertThinkingLevel } from '../ops/models.mjs';
import {
  assertPromptSelection,
  hasPromptSettings,
  promptOptions,
  promptResult,
} from '../ops/prompt-input.mjs';
import { applyModelSettings, modelSettings } from '../ops/set-model.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadSavedSession,
  servesSession,
  traceSessionBranch,
  validateExecutionCwd,
} from '../core/data.mjs';
import { diagnostics } from '../core/diagnostics.mjs';
import { nativeCompactReason } from '../ops/compact.mjs';
import { uiFacts, uiSnapshot } from './rpc-ui.mjs';
import { RuntimeEvents } from '../read/runtime-events.mjs';
import { limitBashResult } from '../ops/bash-execution.mjs';
import { requestStop, withdrawalCollector } from '../ops/stop-execution.mjs';
import { validateLaunchArgs, registryDirectory } from '../core/owner-config.mjs';
import {
  reserveOwner,
  updateOwner,
  releaseOwner,
  processIdentity,
  sameOwner,
  readClaim,
  ownerAlive,
  AttachedRuntime,
} from './attachments.mjs';
const READ_COMMANDS = new Set(['get_state', 'get_entries', 'get_available_models']);
const MODEL_COMMANDS = new Set(['set_model', 'set_thinking_level']);
const ADMISSION_COMMANDS = new Set(['prompt', 'compact', ...MODEL_COMMANDS]);
export class RpcFailure extends Error {
  constructor(code, uncertain = false) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
  }
}
export function launchProfile(config, hostEnv = process.env) {
  // Validated with the owner configuration.
  const { inheritEnv, tools, agentDir } = config.piRuntime ?? {};
  const env =
    inheritEnv === undefined
      ? { ...hostEnv }
      : Object.fromEntries(
          inheritEnv
            .filter((name) => hostEnv[name] !== undefined)
            .map((name) => [name, hostEnv[name]]),
        );
  if (inheritEnv !== undefined) env.PATH ??= hostEnv.PATH ?? '/usr/bin:/bin';
  if (agentDir !== undefined) env.PI_CODING_AGENT_DIR = agentDir;
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
    this.alive = false;
    this.exited = false;
    this.generation = randomUUID();
    this.runtimeEvents = new RuntimeEvents(this.generation);
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
    const { env: baseEnv, toolArgs } = launchProfile(this.config);
    const executable = await resolvePiInstallation(this.config, baseEnv);
    this.installation = executable;
    await validateLaunchArgs(executable, this.config.piArgs, 'rpc');
    this.config = { ...this.config, attachmentDir: registryDirectory(this.config) };
    if (this.config.piRuntime?.agentDir)
      await fs.mkdir(this.config.piRuntime.agentDir, { recursive: true, mode: 0o700 });
    const env = await piLaunchEnvironment(executable, baseEnv, this.session.cwd);
    signal?.throwIfAborted();
    try {
      this.ownerRecord = await reserveOwner(this.config.attachmentDir, this.session, 'rpc');
      // Capture the committed leaf before native startup can append its defaults.
      const { entries, leafId, byId } = await loadSavedSession(this.session, {
        omitImageData: true,
        sdk: await loadPiSdk(executable),
      });
      traceSessionBranch(entries, leafId, byId);
      // An installed daily companion must use this writer's actual registry,
      // not an unrelated default owner profile, then defer to the RPC claim.
      env.PI_MCP_ATTACH_DIR = this.config.attachmentDir;
      env.PI_MCP_RPC_OBSERVER = JSON.stringify({
        socket: this.ownerRecord.socket,
        generation: this.ownerRecord.generation,
        ownerControl: this.completionControl,
        resume: { file: this.session.file, sessionId: this.session.header.id, leafId },
      });
      // Recheck at the actual launch boundary: content preflight and owner
      // reservation may have taken time since the operation was admitted.
      await validateExecutionCwd(this.session.cwd);
      // Native environment/settings by default; only owner-selected overrides apply.
      const launch = {
        command: executable.command,
        args: [
          '-e',
          fileURLToPath(new URL('./rpc-observer.mjs', import.meta.url)),
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
      let herdrControl = null;
      if (herdr) {
        try {
          herdrControl = await prepareHerdr(herdr, {
            signal,
            daemonEnvironment: this.compatibility?.daemonEnvironment.apply(process.env),
          });
        } catch (error) {
          signal?.throwIfAborted();
          // Herdr placement failed before any pane or Pi worker was created;
          // silently fall back to direct spawn so core Pi sessions keep working.
          diagnostics.emit('runtime.herdr_fallback', { code: error.code ?? error.message });
        }
      }
      signal?.throwIfAborted();
      this.child = herdrControl
        ? new HerdrRpcTransport(herdrControl, launch, { signal })
        : spawn(launch.command, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch (error) {
      await this.#releaseClaim();
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
      this.clearPending();
    };
    this.child.once('error', () => {
      if (!this.child.pid && !this.child.ready) this.exited = true;
      fail();
    });
    this.child.once('exit', () => {
      runtimeLog('runtime.exited', { kind: 'rpc', generation: this.generation });
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
      const owner = this.childIdentity;
      if (!owner) throw new RpcFailure('RUNTIME_START_FAILED');
      await updateOwner(this.config.attachmentDir, this.session, this.ownerRecord, {
        owner,
        phase: 'ready',
        ...ownerProtocol,
      });
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
  clearPending() {
    for (const req of this.pending.values()) {
      if (req.ack) continue; // Already received. Let the receipt finish.
      this.#forget(req);
      req.controller?.abort();
      req.waiter?.reject(
        this.startFailure ?? this.#failure(req, 'RUNTIME_DISCONNECTED', req.written),
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
        if (request.type !== 'prompt' || request.ack) continue;
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
        this.clearPending();
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
    if (
      !req ||
      req.controller ||
      req.ack ||
      event.command !== req.type ||
      typeof event.success !== 'boolean'
    )
      return;
    // Only the matching prompt ACK is evidence of completed admission. State,
    // timers, unrelated events and malformed responses cannot clear uncertainty.
    if (
      req.type === 'prompt' &&
      event.success &&
      !['started', 'queued', 'handled'].includes(event.data?.disposition)
    )
      return;
    const ui = uiSnapshot(req.uiFacts);
    const result = event.success
      ? { ok: true, data: ui.ui ? { ...event.data, ...ui } : event.data }
      : {
          ok: false,
          code: 'PI_REJECTED',
          ...(req.type === 'compact' ? { native_reason: nativeCompactReason(event.error) } : {}),
          ...ui,
        };
    this.#receive(req, result);
  }
  #forget(req) {
    this.pending.delete(req.id);
    clearTimeout(req.timer);
  }
  #failure(req, code, written = false, native_reason) {
    return Object.assign(new RpcFailure(code, written && !req.read), uiSnapshot(req.uiFacts), {
      native_reason,
    });
  }
  #loseResponse(req, code) {
    if (this.pending.get(req.id) !== req || !req.waiter) return;
    const { reject } = req.waiter;
    clearTimeout(req.timer);
    req.waiter = null;
    if (req.read || !req.written) {
      this.pending.delete(req.id);
      req.controller?.abort();
    }
    reject(this.#failure(req, code, req.written));
    if (!req.read && !req.written) this.onIdleCandidate?.();
  }
  #receive(req, result) {
    if (this.pending.get(req.id) !== req || req.ack) return;
    clearTimeout(req.timer);
    // A started/queued ACK is admission, never completion. In the supported
    // owned RPC path its run must subsequently settle, including queued work.
    if (
      req.type === 'prompt' &&
      result.ok &&
      ['started', 'queued'].includes(result.data?.disposition)
    )
      this.requiredSettlementSequence = Math.max(
        this.requiredSettlementSequence,
        req.settlementSequence + 1,
      );
    if (req.waiter) {
      this.#forget(req);
      if (result.ok) req.waiter.resolve(result.data);
      else req.waiter.reject(this.#failure(req, result.code, false, result.native_reason));
    } else {
      req.log('rpc.late_ack', {
        op: req.type,
        generation: this.generation,
        late: true,
        status: result.ok ? 'ok' : 'error',
      });
      if (!req.onLate) this.#forget(req);
      else {
        const done = Promise.withResolvers();
        req.ack = done.promise;
        void (async () => {
          try {
            await req.onLate(result);
          } catch (error) {
            diagnostics.emit('operation.failure', {
              code: error.code ?? 'OTHER_ERROR',
              uncertain: true,
            });
          } finally {
            this.#forget(req);
            done.resolve();
            this.onIdleCandidate?.();
          }
        })();
        return;
      }
    }
    if (!req.read) this.onIdleCandidate?.();
  }
  async drainAcks() {
    for (;;) {
      const received = this.pending
        .values()
        .map(({ ack }) => ack)
        .filter(Boolean)
        .toArray();
      if (!received.length) return;
      await Promise.all(received);
    }
  }
  async command(command, { onLate, beforeDispatch, ...options } = {}) {
    await this.state();
    const bash = command.type === 'bash';
    const recheck = bash || ADMISSION_COMMANDS.has(command.type);
    const late =
      (recheck || onLate) &&
      (async (result) => {
        await this.state();
        await onLate?.(result);
      });
    await beforeDispatch?.();
    let result, rejection;
    try {
      result = await this.dispatch(command, { ...options, onLate: late, beforeDispatch });
    } catch (error) {
      if (bash && error.code === 'PI_REJECTED') error.uncertain = true;
      if (bash) throw error;
      if (error.code !== 'PI_REJECTED') throw error;
      rejection = error;
    }
    try {
      await this.state();
    } catch (error) {
      if (recheck) error.uncertain = true;
      const observedUI = result?.ui ?? rejection?.ui;
      if (observedUI && !error.ui) error.ui = observedUI;
      throw error;
    }
    if (rejection) throw rejection;
    return result;
  }
  // Write one native RPC command and await its matching ACK. A timed-out
  // mutation keeps its fence for a late matching ACK. allowBusySelection lets
  // a standalone model setter proceed during compaction.
  dispatch(command, options = {}) {
    return diagnostics.measure(
      'rpc.command',
      { op: command.type, generation: this.generation },
      () => this.#write(command, options),
    );
  }
  async #write(
    { id: requestId, type, idleOnly, ...body },
    { timeout = 5000, onLate, beforeDispatch, allowBusySelection = false },
  ) {
    if (this.startFailure) throw this.startFailure;
    if (!this.alive) throw new RpcFailure('RUNTIME_DISCONNECTED');
    if (this.handoffPending && type !== 'get_state' && type !== 'get_entries')
      throw new RpcFailure('HANDOFF_PENDING');
    if (this.gracefulExitPromise) throw new RpcFailure('RUNTIME_SHUTTING_DOWN');
    if (ADMISSION_COMMANDS.has(type)) {
      if (this.hasPendingCommand('compact') && !(allowBusySelection && MODEL_COMMANDS.has(type)))
        throw new RpcFailure('COMPACTION_PENDING');
      if (this.hasPendingModelSelection()) throw new RpcFailure('MODEL_SELECTION_PENDING');
      if ((type === 'prompt' || type === 'compact') && this.hasPendingCommand('prompt'))
        throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    }
    const id = requestId ?? randomUUID();
    if (typeof id !== 'string' || !id.length || id.length > 128 || this.pending.has(id))
      throw new RpcFailure('INVALID_ARGUMENTS');
    const guardedCompact = type === 'compact' && idleOnly === true;
    if (guardedCompact && !this.ownerRecord)
      throw new RpcFailure('OWNER_COMPONENT_UPDATE_REQUIRED');
    const frame = guardedCompact ? null : `${JSON.stringify({ type, ...body, id })}\n`;
    const waiter = Promise.withResolvers();
    const req = {
      id,
      type,
      waiter,
      read: READ_COMMANDS.has(type),
      settlementSequence: this.settlementSequence,
      onLate: onLate && diagnostics.bind(onLate),
      log: diagnostics.capture(),
      written: false,
      controller: guardedCompact ? new AbortController() : undefined,
    };
    this.pending.set(id, req);
    req.timer = setTimeout(() => this.#loseResponse(req, 'ACK_TIMEOUT'), timeout);
    if (guardedCompact) void this.#writeCompact(req, body.customInstructions ?? '', beforeDispatch);
    else {
      try {
        req.written = true;
        this.child.stdin.write(frame, (error) => {
          if (error) this.#loseResponse(req, 'WRITE_UNKNOWN');
        });
      } catch {
        this.#loseResponse(req, 'WRITE_UNKNOWN');
      }
    }
    return waiter.promise;
  }
  async #writeCompact(req, instructions, beforeDispatch) {
    const transport = new AttachedRuntime(this.config, this.session, this.ownerRecord);
    try {
      const data = await transport.request(
        'compact',
        { instructions },
        {
          timeout: null,
          signal: req.controller.signal,
          onWrite: () => {
            // No await between Bridge's final Stop/lifecycle fence and socket write.
            beforeDispatch?.();
            if (!this.alive || this.handoffPending || this.gracefulExitPromise)
              throw new RpcFailure('RUNTIME_SHUTTING_DOWN');
            req.written = true;
          },
        },
      );
      this.#receive(req, { ok: true, data });
    } catch (error) {
      if (error.uncertain) this.#loseResponse(req, error.code ?? 'WRITE_UNKNOWN');
      else
        this.#receive(req, {
          ok: false,
          code: error.code ?? error.message,
          native_reason: error.native_reason,
        });
    }
  }
  assertSessionIdentity(state) {
    if (!servesSession(state, this.session)) {
      this.runtimeEvents.invalidate();
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    }
  }
  async state(timeout = 5000) {
    const state = await this.dispatch({ type: 'get_state' }, { timeout });
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
  hasPendingCommand(type) {
    return this.pending.values().some((req) => !req.ack && req.type === type);
  }
  hasPendingModelSelection() {
    return this.pending.values().some((req) => !req.ack && MODEL_COMMANDS.has(req.type));
  }
  hasPendingAdmission() {
    return this.pending.values().some((req) => !req.ack && ADMISSION_COMMANDS.has(req.type));
  }
  hasUnsettledWork() {
    return Boolean(
      this.activeBashes > 0 ||
      this.settlementSequence < this.requiredSettlementSequence ||
      this.pending.values().some((req) => !req.read),
    );
  }
  async idleSnapshot() {
    const state = await this.state();
    const pending = pendingMessages(state);
    const result = (status) => ({ state, status, pending });
    if (this.hasUnsettledWork() || nativeBusy(state)) return result('busy');
    if (
      state.isStreaming !== false ||
      state.isCompacting !== false ||
      pending !== 0 ||
      !this.ownerRecord?.socket
    )
      return result('unknown');
    const observed = await new AttachedRuntime(this.config, this.session, this.ownerRecord).state();
    if (nativeBusy(observed) || this.hasUnsettledWork()) return result('busy');
    if (observed.isIdle !== true || observed.hasPendingMessages !== false) return result('unknown');
    return result('idle');
  }
  async assertIdle({
    busy = 'MODEL_SELECTION_BUSY',
    unconfirmed = 'MODEL_SELECTION_IDLE_UNCONFIRMED',
  } = {}) {
    if (this.hasPendingModelSelection()) throw new RpcFailure('MODEL_SELECTION_PENDING');
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
    { thinkingLevel, idle = false, nativeThinking = false, beforeDispatch } = {},
  ) {
    if (this.hasPendingModelSelection()) throw new RpcFailure('MODEL_SELECTION_PENDING');
    if (idle && this.hasPendingCommand('prompt')) throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    const models = model ? (await this.command({ type: 'get_available_models' })).models : null;
    const requested = models?.find((entry) => sameModel(entry, model));
    if (model && !requested) throw new RpcFailure('MODEL_UNAVAILABLE');
    const ai =
      !nativeThinking && thinkingLevel !== undefined ? await loadPiAi(this.installation) : null;
    if (requested) assertThinkingLevel(requested, thinkingLevel, ai);
    const selected = () => (idle ? this.assertIdle() : this.state());
    const first = await selected();
    if (!requested && !first.model) throw new RpcFailure('MODEL_UNAVAILABLE');
    await beforeDispatch?.();
    if (!requested) assertThinkingLevel(first.model, thinkingLevel, ai);
    const options = { beforeDispatch, allowBusySelection: !idle };
    try {
      return await applyModelSettings(first, requested, thinkingLevel, {
        refresh: selected,
        validate: (actual) => assertThinkingLevel(actual, thinkingLevel, ai),
        setModel: async (target) => {
          const changed = await this.command(
            { type: 'set_model', provider: target.provider, modelId: target.id },
            options,
          );
          if (!sameModel(changed, target)) throw new Error('MODEL_SELECTION_CHANGED');
          return selected();
        },
        setThinkingLevel: async (level) => {
          await this.command({ type: 'set_thinking_level', level }, options);
          const actual = await this.state();
          if (ai && actual.thinkingLevel !== thinkingLevel)
            throw new Error('MODEL_SELECTION_CHANGED');
          return actual;
        },
      });
    } catch (error) {
      if (error.message === 'MODEL_SELECTION_CHANGED')
        throw new RpcFailure('MODEL_SELECTION_CHANGED', true);
      throw error;
    }
  }
  async submitPrompt(input, { submissionId, onLate, authorize, selection, onAdmitted }) {
    const settings = hasPromptSettings(input);
    const checkIdle = async (code) => {
      const { status } = await this.idleSnapshot();
      if (status === 'busy') return false;
      if (status !== 'idle') throw new RpcFailure(code);
      return true;
    };
    if (settings) {
      if (input.mode === 'idle_only' && !(await checkIdle('MODEL_SELECTION_IDLE_UNCONFIRMED')))
        return { status: 'skipped', reason: 'busy' };
      selection.model_selection = await this.selectModel(input.model, {
        thinkingLevel: input.thinking_level,
        idle: true,
        beforeDispatch: authorize,
      });
      await authorize();
    }
    if (input.mode === 'idle_only' && !(await checkIdle('RUNTIME_IDLE_UNCONFIRMED')))
      return { status: 'skipped', reason: 'busy' };
    await authorize();
    if (!this.hasPendingAdmission()) onAdmitted?.();
    const result = await this.command(
      {
        id: submissionId,
        type: 'prompt',
        message: input.text,
        ...(input.images ? { images: input.images } : {}),
        ...promptOptions(settings ? 'idle_only' : input.mode),
      },
      {
        onLate: onLate && ((result) => onLate(promptResult(result))),
        beforeDispatch: async () => {
          if (settings) {
            const state = await this.state();
            assertPromptSelection(input, state);
            selection.model_selection = modelSettings({
              model: state.model,
              thinking_level: state.thinkingLevel,
            });
          }
          await authorize();
        },
      },
    );
    return promptResult({ ok: true, data: result });
  }
  async compact({ instructions, interrupt }, beforeDispatch) {
    if (!interrupt)
      await this.assertIdle({ busy: 'COMPACT_BUSY', unconfirmed: 'COMPACT_IDLE_UNCONFIRMED' });
    return this.command(
      { type: 'compact', customInstructions: instructions, idleOnly: !interrupt },
      { beforeDispatch },
    );
  }
  async executeBash({ command, max_chars, beforeDispatch }) {
    this.activeBashes++;
    try {
      const result = await this.command({ type: 'bash', command }, { beforeDispatch });
      try {
        return limitBashResult(result, max_chars);
      } catch (error) {
        error.uncertain = true;
        throw error;
      }
    } finally {
      this.activeBashes--;
      this.onIdleCandidate?.();
    }
  }
  async stopExecution({ max_chars } = {}) {
    await this.state();
    const withdrawn = withdrawalCollector(max_chars);
    try {
      const receipt = await requestStop(
        {
          clearQueue: () => this.dispatch({ type: 'clear_queue' }, { onLate: () => this.state() }),
          abort: () => this.dispatch({ type: 'abort' }),
          abortBash: () => this.dispatch({ type: 'abort_bash' }),
        },
        async (value) => {
          await this.state();
          withdrawn.add(value);
        },
      );
      await this.state();
      return { ...receipt, withdrawal: withdrawn.value };
    } catch (error) {
      error.uncertain = true;
      if (withdrawn.value) error.result = { withdrawal: { ...withdrawn.value, complete: false } };
      throw error;
    }
  }
  // The one release path for auto-release, local release, handoff and owned
  // reload. Fence dispatch, then establish idle: assert it, wait for it, or use
  // the caller's proof under the session lane. A retry after an unknown seal
  // skips that step; the child's atomic seal decides. `interrupt` skips the seal
  // and terminates. Dispatch reopens only while closure is still reversible.
  async shutdown(signal, { mode = 'idle', beforeExit } = {}) {
    this.handoffPending = true;
    try {
      if (mode === 'interrupt') {
        await this.assertProcessIdentity();
        await beforeExit?.();
        await this.stop();
        return {};
      }
      if (!this.exitSeal && mode === 'wait_idle') await this.waitForHandoff(signal);
      else if (!this.exitSeal && mode === 'idle') {
        if (this.hasPendingCommand('prompt')) throw new RpcFailure('PROMPT_ADMISSION_PENDING');
        await this.assertIdle({ busy: 'RUNTIME_BUSY', unconfirmed: 'RUNTIME_IDLE_UNCONFIRMED' });
      }
      await beforeExit?.();
      return await this.gracefulExit(signal);
    } finally {
      if (!this.gracefulExitPromise && !this.exitSeal && !this.stopPromise)
        this.handoffPending = false;
    }
  }
  async waitForHandoff(signal) {
    for (;;) {
      signal?.throwIfAborted();
      if (!this.alive) throw new RpcFailure('RUNTIME_DISCONNECTED');
      if (!this.hasUnsettledWork()) {
        const { status } = await this.idleSnapshot();
        if (status === 'unknown') throw new RpcFailure('RUNTIME_IDLE_UNCONFIRMED');
        if (status === 'idle') {
          signal?.throwIfAborted();
          return;
        }
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
      // Parent observations reject known work early. The child's atomic seal
      // also excludes native work started since the last idle observation.
      if (this.hasUnsettledWork() || this.activeReads) throw new RpcFailure('RUNTIME_BUSY');
      const sealed = await new AttachedRuntime(this.config, this.session, record).seal(() => {
        signal?.throwIfAborted();
        if (this.hasUnsettledWork() || this.activeReads) throw new RpcFailure('RUNTIME_BUSY');
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
        await this.#releaseClaim(record);
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
    if (record) {
      const current = await readClaim(this.config.attachmentDir, this.session);
      if (current?.generation !== record.generation || !sameOwner(current.owner, identity))
        throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    }
    if (!identity || identity.pid !== child.pid || !(await ownerAlive(identity)))
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
  }
  async #releaseClaim(record = this.ownerRecord) {
    if (!record) return;
    await releaseOwner(this.config.attachmentDir, this.session, record);
    if (this.ownerRecord === record) this.ownerRecord = null;
  }
  async stop() {
    await this.drainAcks();
    if (!this.child || this.exited) {
      this.clearPending();
      await this.#releaseClaim();
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
      this.clearPending();
      this.lines?.close();
      if (this.ownerRecord?.socket)
        await fs.unlink(this.ownerRecord.socket).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      await this.#releaseClaim();
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
