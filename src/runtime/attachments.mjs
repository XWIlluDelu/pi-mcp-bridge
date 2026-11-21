import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_ATTACHMENT_SNAPSHOT_BYTES,
  ownerEnvelope,
  validNativeSnapshot,
  nativeBusy,
  pendingMessages,
} from './attachment-protocol.mjs';
import { readLfLines } from '../core/lf-lines.mjs';
import { assertReadSnapshot, READ_CONTRACT } from '../read/context-read.mjs';
import { stopReceipt, inlineWithdrawal } from '../ops/stop-execution.mjs';
import { inlineBashResult } from '../ops/bash-execution.mjs';
import { compactMetadata, nativeCompactReason } from '../ops/compact.mjs';
import { hasPromptSettings, attachedPromptResult } from '../ops/prompt-input.mjs';
import { diagnostics } from '../core/diagnostics.mjs';
import {
  OwnerFailure,
  isDefiniteOwnerRefusal,
  isOwnerMutation,
  knownErrorCode,
} from '../core/errors.mjs';
// Cooperative, owner-private Linux/macOS Unix-socket attachment transport. No credentials.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelSettings } from '../ops/set-model.mjs';
import path from 'node:path';
import net from 'node:net';
import { assertReadFeatures } from '../read/read-features.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertSingleSessionFile,
  readSessionIdentity,
  sameSessionIdentity,
  servesSession,
} from '../core/data.mjs';
import {
  ifMissing,
  atomicJson,
  sessionKey,
  assertPrivateDirectory,
  readPrivateInode,
} from '../core/storage.mjs';
import { kernelLock } from '../core/kernel-lock.mjs';

const execFileAsync = promisify(execFile);
let darwinBootId;

async function getDarwinBootId() {
  if (darwinBootId) return darwinBootId;
  const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.boottime'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  const match = stdout.match(/sec\s*=\s*(\d+)/);
  if (!match) throw new Error('INVALID_PROCESS_IDENTITY');
  return (darwinBootId = `darwin-boot-${match[1]}`);
}

export function parseDarwinProcessIdentity(stdout, boot, pid) {
  const line = stdout.trim();
  if (!line) return null;
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match || !boot) throw new Error('INVALID_PROCESS_IDENTITY');
  return { pid, start: match[2].trim(), boot, state: match[1] };
}

export async function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE');
  if (process.platform === 'linux') {
    try {
      let stat;
      try {
        stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        // Linux can open stat while the task exists, then return ESRCH from
        // read after it exits. Only errors from this PID's stat prove absence.
        if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
        throw error;
      }
      const boot = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (!/^\d+$/.test(fields[19] ?? '') || !fields[0] || !boot.trim())
        throw new Error('INVALID_PROCESS_IDENTITY');
      return { pid, start: fields[19], boot: boot.trim(), state: fields[0] };
    } catch (cause) {
      throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE', false, { cause });
    }
  }
  if (process.platform === 'darwin') {
    try {
      const boot = await getDarwinBootId();
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'state=,lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          timeout: 3000,
        });
        return parseDarwinProcessIdentity(stdout, boot, pid);
      } catch (error) {
        if (error.code === 1 && !error.killed) return null;
        throw error;
      }
    } catch (cause) {
      throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE', false, { cause });
    }
  }
  throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE');
}
export function isReleasedOwner(record) {
  return record?.owner === null && record.phase === 'released' && record.noColdReacquire === true;
}
export const sameOwner = (a, b) =>
  Boolean(a && b && a.pid === b.pid && a.start === b.start && a.boot === b.boot);

export async function ownerAlive(owner) {
  if (owner === null) return false;
  const current = await processIdentity(owner.pid);
  return sameOwner(current, owner) && !['Z', 'X'].includes(current.state?.[0]);
}
export async function privateDirectory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir))
    throw new OwnerFailure('INVALID_ATTACHMENT_DIRECTORY');
  // Validate identically for bridge and extension, before either can treat a missing claim as safe.
  if (Buffer.byteLength(path.join(dir, '2147483647-12345678.sock')) > 100)
    throw new OwnerFailure('ATTACHMENT_SOCKET_PATH_TOO_LONG');
  const canonical = path.resolve(dir);
  try {
    await assertPrivateDirectory(canonical, { code: 'INVALID_ATTACHMENT_DIRECTORY' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(canonical, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(canonical, { code: 'INVALID_ATTACHMENT_DIRECTORY' });
  }
}
export function claimFile(dir, session) {
  return path.join(dir, `${sessionKey(session.file, session.header.id)}.owner.json`);
}
async function claimFiles(dir) {
  return (await fs.readdir(dir))
    .filter((name) => /^ps_[a-f0-9]{32}\.owner\.json$/.test(name))
    .map((name) => path.join(dir, name));
}
// Linux abstract sockets provide one process-owned short mutex. The canonical
// private directory is the namespace; this is NOT the long-lived writer claim.
export async function registryTransaction(dir, action) {
  await privateDirectory(dir);
  const mutex = await kernelLock('registry:' + path.resolve(dir), {
    attempts: 100,
    busy: 'ATTACHMENT_REGISTRY_BUSY',
  });
  try {
    return await action();
  } finally {
    await mutex.close();
  }
}
export async function readClaim(dir, session) {
  await privateDirectory(dir);
  return readOwnerRecord(claimFile(dir, session), { expectedFile: session.file });
}
export async function readOwnerRecord(file, { expectedFile, target, owner } = {}) {
  try {
    const { text } = await readPrivateInode(file, 8192);
    const record = JSON.parse(text);
    const identified =
      Number.isSafeInteger(record?.owner?.pid) &&
      record.owner.pid > 0 &&
      typeof record.owner.start === 'string' &&
      typeof record.owner.boot === 'string';
    // A known other process is irrelevant to an exact-PID scan. An unidentified
    // possible writer still prevents using such a scan as signal authority.
    if (owner && (identified || isReleasedOwner(record)) && !sameOwner(record.owner, owner))
      return null;
    if (
      typeof record?.file !== 'string' ||
      !path.isAbsolute(record.file) ||
      path.resolve(record.file) !== record.file ||
      record.file.includes('\0')
    )
      throw new Error();
    // A known different path cannot own this target, even if its owner data is
    // damaged. Unsafe storage or an ambiguous target path still rejects access.
    if (target !== undefined && record.file !== target) return null;
    if (!isReleasedOwner(record) && !identified) throw new Error();
    if (expectedFile && record.file !== expectedFile) throw new Error();
    if (record.noColdReacquire !== undefined && typeof record.noColdReacquire !== 'boolean')
      throw new Error();
    // Ownership evidence is independent of endpoint metadata, even for a live
    // process. A native replacement can register fresh control without using or
    // translating the previous endpoint. request() validates live control.
    return record;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new OwnerFailure('INVALID_ATTACHMENT_RECORD');
  }
}
// Call while holding registryTransaction: a changed header must not bypass
// an existing path owner merely because its claim has a different filename.
// Without a header, check every claim on the path before native open. Only a
// caller with native-context evidence may replace its own claim; PID equality alone
// does not prove replacement. This read does not reserve the target.
async function scanPathOwners(dir, session, { replacing, completeHandoff = false } = {}) {
  const exact = session.header && claimFile(dir, session);
  const replaced = replacing && claimFile(dir, replacing.session);
  let current = null,
    opening = false;
  for (const file of await claimFiles(dir)) {
    const other = await readOwnerRecord(
      file,
      file === exact ? { expectedFile: session.file } : { target: session.file },
    );
    if (!other) continue;
    if (file === exact) current = other;
    const completing =
      completeHandoff &&
      other.kind === 'handoff' &&
      other.phase === 'opening' &&
      other.owner.pid === process.pid &&
      (!session.header || other.sessionId === session.header.id) &&
      (await ownerAlive(other.owner));
    if (completing) opening = true;
    if (
      (file !== exact || other.sessionId !== session.header.id) &&
      !completing &&
      !(file === replaced && sameOwner(other.owner, replacing.record.owner)) &&
      (await ownerAlive(other.owner))
    )
      throw new OwnerFailure('LIVE_OWNER_UNREACHABLE');
  }
  return { current, opening };
}
export async function assertNoOtherLiveOwner(dir, session, options) {
  const { current, opening } = await scanPathOwners(dir, session, options);
  // Deletion blocks new admission, not completion of this process's already
  // admitted native switch. It waits for that real writer before terminating.
  if (!opening) {
    const gate = await deletionGate(dir, session);
    await gate.close();
  }
  return current;
}
export async function vacantClaim(dir, session) {
  const current = await assertNoOtherLiveOwner(dir, session);
  if (current && (await ownerAlive(current.owner)))
    throw new OwnerFailure('LIVE_OWNER_UNREACHABLE');
  return current;
}
export function newOwnerRecord(dir, session, kind, owner, handoff) {
  if (!owner) throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE');
  const generation = randomUUID();
  return {
    kind,
    file: session.file,
    sessionId: session.header.id,
    generation,
    owner,
    ...(handoff
      ? { phase: 'reserved', handoffId: handoff.id }
      : {
          phase: 'starting',
          socket: path.join(dir, `${process.pid}-${generation.slice(0, 8)}.sock`),
        }),
  };
}
export async function reserveOwner(dir, session, kind, owner = undefined, handoff) {
  return registryTransaction(dir, async () => {
    if (!handoff) await assertSingleSessionFile(session.file);
    const old = await vacantClaim(dir, session);
    if (kind === 'rpc' && old?.noColdReacquire) throw new OwnerFailure('COLD_REACQUIRE_BLOCKED');
    if (handoff && !(await ownerAlive(owner))) throw new OwnerFailure('HANDOFF_REQUESTER_GONE');
    const record = newOwnerRecord(dir, session, kind, owner ?? (await processIdentity()), handoff);
    if (old?.noColdReacquire) record.noColdReacquire = true;
    handoff?.signal.throwIfAborted();
    await atomicJson(claimFile(dir, session), record);
    return record;
  });
}
export async function updateOwner(dir, session, record, changes) {
  return registryTransaction(dir, async () => {
    const current = await readClaim(dir, session);
    if (current?.generation !== record.generation)
      throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    if (isReleasedOwner(current)) {
      // Late teardown is idempotent; never republish its cached live owner.
      if (changes.phase === 'transitioning' && Object.keys(changes).length === 1) return current;
      throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    }
    Object.assign(record, current.noColdReacquire ? { noColdReacquire: true } : {}, changes);
    await atomicJson(claimFile(dir, session), record);
    return record;
  });
}
// Call under the registry mutex after identifying the exact claim to retire.
export async function retireClaim(dir, session, current) {
  const file = claimFile(dir, session);
  if (current.noColdReacquire)
    await atomicJson(file, { ...current, phase: 'released', owner: null });
  else await fs.unlink(file);
}
export async function releaseOwner(dir, session, record) {
  return registryTransaction(dir, async () => {
    const current = await readClaim(dir, session);
    if (current?.generation === record.generation) await retireClaim(dir, session, current);
  });
}
async function deletionGate(dir, session) {
  try {
    return await kernelLock('delete:' + path.resolve(dir) + '\0' + session.file, {
      busy: 'LIVE_OWNER_UNREACHABLE',
    });
  } catch (error) {
    if (error.message === 'LIVE_OWNER_UNREACHABLE')
      throw new OwnerFailure('LIVE_OWNER_UNREACHABLE');
    throw error;
  }
}
// Session-wide authority, separate from the writer claim. Keeping the claim
// intact lets an existing owner finish/release normally without reopening
// admission. The kernel drops the gate on Bridge death; no persistent lease.
export async function acquireDeletion(dir, session) {
  return registryTransaction(dir, async () => {
    await assertSingleSessionFile(session.file);
    let { current: record } = await scanPathOwners(dir, session);
    const gate = await deletionGate(dir, session);
    if (record?.kind === 'handoff' && record.phase === 'reserved') {
      // Revoke an unopened reservation without signalling its requester.
      try {
        await retireClaim(dir, session, record);
      } catch (error) {
        await gate.close();
        throw error;
      }
      record = null;
    }
    return {
      async writer() {
        // Pi cannot cancel an in-progress switch atomically. Keep the deletion
        // gate while that one admitted switch registers its writer, cancels,
        // or its requester exits. Do not turn it into a user retry requirement.
        while (record?.kind === 'handoff' && (await ownerAlive(record.owner))) {
          await delay(25);
          record = await readClaim(dir, session);
        }
        return record?.kind === 'handoff' ? null : record;
      },
      async finish(moved = false) {
        try {
          if (moved)
            await registryTransaction(dir, async () => {
              const current = await readClaim(dir, session);
              if (current && (await ownerAlive(current.owner)))
                throw new OwnerFailure('OWNER_STILL_ALIVE');
              if (current) await fs.unlink(claimFile(dir, session));
            });
          // On failure leave the prior cold-resume pause untouched.
        } finally {
          await gate.close();
        }
      },
    };
  });
}
export async function waitOwnerExit(owner, timeout = 5000) {
  const until = Date.now() + timeout;
  while (await ownerAlive(owner)) {
    if (Date.now() >= until) throw new OwnerFailure('OWNER_STILL_ALIVE');
    await delay(25);
  }
}
// Delete is explicit authority to interrupt the writer, not an idle handoff.
// Recheck the native binding and exact process before EACH signal. Never signal
// a process group, parent host, or a process that also owns another session.
async function terminateOwnerForDelete(config, session, record) {
  const signal = (name) =>
    registryTransaction(config.attachmentDir, async () => {
      const current = await readClaim(config.attachmentDir, session);
      // Release can finish even when its ACK is lost, or while waiting to
      // escalate. The target is closed; a shared host PID may remain alive.
      if (!current || (current.generation === record.generation && isReleasedOwner(current)))
        return true;
      if (!(await ownerAlive(record.owner))) return false;
      if (
        current?.generation !== record.generation ||
        !sameOwner(current.owner, record.owner) ||
        !sameSessionIdentity(await readSessionIdentity(session.file), session)
      )
        throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
      if (record.owner.pid === process.pid) throw new OwnerFailure('DELETE_SHARED_OWNER');
      for (const file of await claimFiles(config.attachmentDir)) {
        const other = await readOwnerRecord(file, { owner: record.owner });
        if (
          other &&
          other.kind !== 'handoff' &&
          (other.file !== session.file || other.sessionId !== session.header.id)
        )
          throw new OwnerFailure('DELETE_SHARED_OWNER');
      }
      if (!(await ownerAlive(record.owner))) return;
      try {
        process.kill(record.owner.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
  if (await signal('SIGTERM')) return;
  try {
    await waitOwnerExit(record.owner, config.attachmentExitTimeoutMs ?? 5000);
  } catch (error) {
    if (error.code !== 'OWNER_STILL_ALIVE') throw error;
    if (await signal('SIGKILL')) return;
    await waitOwnerExit(record.owner, config.attachmentExitTimeoutMs ?? 5000);
  }
  await registryTransaction(config.attachmentDir, async () => {
    const current = await readClaim(config.attachmentDir, session);
    if (current?.generation !== record.generation) return;
    // Raw ownership metadata is not authority to unlink an arbitrary endpoint.
    // Only clean a current-generation Unix socket in this registry.
    if (
      typeof record.socket === 'string' &&
      path.dirname(record.socket) === config.attachmentDir &&
      typeof record.generation === 'string' &&
      path.basename(record.socket).endsWith(`-${record.generation.slice(0, 8)}.sock`)
    ) {
      const stat = await fs.lstat(record.socket).catch(ifMissing);
      if (stat?.isSocket()) await fs.unlink(record.socket).catch(ifMissing);
    }
    await retireClaim(config.attachmentDir, session, current);
  });
}
export class AttachedRuntime {
  constructor(config, session, record, { compatibility } = {}) {
    this.compatibility = compatibility;
    this.config = config;
    this.session = session;
    this.record = record;
    this.attached = true;
  }
  // One owner exchange. A null timeout leaves the wait to the caller's signal.
  request(op, body = {}, options = {}) {
    return diagnostics.measure('attached.request', { op, generation: this.record.generation }, () =>
      this.#exchange(op, body, options),
    );
  }
  async #exchange(op, body, { timeout = 5000, beforeDispatch, signal, onWrite }) {
    signal?.throwIfAborted();
    if (op === 'seal' && this.record.kind !== 'rpc')
      throw new OwnerFailure('OWNER_COMPONENT_UPDATE_REQUIRED');
    const current = await readClaim(this.config.attachmentDir, this.session);
    if (!current || current.generation !== this.record.generation)
      throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    if (
      !['tui', 'rpc', 'extension', 'host'].includes(current.kind) ||
      typeof current.generation !== 'string' ||
      typeof current.sessionId !== 'string' ||
      typeof current.socket !== 'string' ||
      path.dirname(current.socket) !== this.config.attachmentDir
    )
      throw new OwnerFailure('ATTACHMENT_PROTOCOL_MISMATCH');
    if (current.sessionId !== this.session.header.id)
      throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    const closingHost =
      op === 'release' && current.kind === 'host' && current.phase === 'transitioning';
    if ((current.phase !== 'ready' && !closingHost) || !(await ownerAlive(current.owner)))
      throw new OwnerFailure('LIVE_OWNER_UNREACHABLE');
    if (
      op === 'send' &&
      body.mode === 'idle_only' &&
      current.kind === 'host' &&
      current.idleOnlySupported !== true
    )
      throw new OwnerFailure('HOST_ADMISSION_UNSUPPORTED');
    const serialized = ownerEnvelope(current, {
      op,
      body,
      ...(op === 'read' && body.view !== 'runtime'
        ? { readAdapters: this.compatibility?.readInputs.snapshot() ?? [] }
        : {}),
    });
    if (Buffer.byteLength(serialized) > MAX_ATTACHMENT_REQUEST_BYTES)
      throw new OwnerFailure('ATTACHMENT_REQUEST_TOO_LARGE');
    const ownedCompact = op === 'compact' && current.kind === 'rpc';
    const mutating = isOwnerMutation(op);
    signal?.throwIfAborted();
    // The owned compact ACK ledger supplies its own deadline. A written
    // request keeps this connection until its matching reply or exact exit.
    const deadline = timeout === null ? undefined : AbortSignal.timeout(timeout);
    const lifetime =
      signal && deadline ? AbortSignal.any([signal, deadline]) : (signal ?? deadline);
    const socket = net.createConnection({ path: current.socket, signal: lifetime });
    const reply = Promise.withResolvers();
    let bytes = 0,
      written = false,
      partial;
    const failure = (code, definite = false) =>
      new OwnerFailure(code, written && mutating && !definite);
    const finish = (error, data) => {
      lines.close();
      socket.destroy();
      if (error && partial !== undefined) error.result = partial;
      if (error) reply.reject(error);
      else reply.resolve(data);
    };
    const disconnect = () =>
      finish(
        failure(
          deadline?.aborted && lifetime.reason === deadline.reason
            ? 'ACK_TIMEOUT'
            : 'LIVE_OWNER_UNREACHABLE',
        ),
      );
    socket.on('error', disconnect);
    socket.once('end', disconnect);
    socket.once('close', disconnect);
    socket.once('connect', async () => {
      try {
        await beforeDispatch?.();
        if (socket.destroyed || socket.readableEnded || lifetime?.aborted) return;
        onWrite?.();
        written = true;
        socket.write(serialized);
      } catch (error) {
        if (socket.destroyed) return;
        if (written) disconnect();
        else finish(error);
      }
    });
    const maxBytes = ['snapshot', 'read'].includes(op)
      ? MAX_ATTACHMENT_SNAPSHOT_BYTES + 2048
      : ['bash', 'stop'].includes(op)
        ? MAX_ATTACHMENT_REQUEST_BYTES
        : 256 * 1024 + 2048;
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes)
        finish(failure(op === 'snapshot' ? 'SESSION_TOO_LARGE' : 'INVALID_ATTACHMENT_RESPONSE'));
    });
    const lines = readLfLines(socket, (line) => {
      try {
        const response = JSON.parse(line);
        if (typeof response?.version !== 'string') throw new Error('INVALID_ATTACHMENT_RESPONSE');
        if (
          response.generation !== current.generation ||
          response.file !== this.session.file ||
          response.sessionId !== this.session.header.id
        )
          return finish(failure('RUNTIME_SESSION_CHANGED'));
        const failed = Object.hasOwn(response, 'error');
        const partialReply = response.partial === true;
        if (
          failed === Object.hasOwn(response, 'data') ||
          (failed && typeof response.error !== 'string') ||
          (response.partial !== undefined &&
            (!partialReply || failed || (op !== 'bash' && op !== 'stop')))
        )
          throw new Error('INVALID_ATTACHMENT_RESPONSE');
        const { error, data } = response;
        if (error === 'OWNER_COMPONENT_UPDATE_REQUIRED') return finish(failure(error, true));
        if (failed) {
          const definite = isDefiniteOwnerRefusal(op, error, ownedCompact);
          const rejected = failure(knownErrorCode(error, 'ATTACHED_OPERATION_FAILED'), definite);
          if (ownedCompact) {
            const reason = nativeCompactReason(response.native_reason);
            if (reason !== undefined) rejected.native_reason = reason;
          }
          return finish(rejected);
        }
        if (
          op === 'seal' &&
          !(
            (data?.sealed === true && Object.keys(data).length === 1) ||
            (data?.sealed === false && data.reason === 'busy' && Object.keys(data).length === 2)
          )
        )
          throw new Error('INVALID_ATTACHMENT_RESPONSE');
        if (partialReply) {
          partial =
            op === 'bash'
              ? inlineBashResult(data)
              : { withdrawal: inlineWithdrawal(data?.withdrawal) };
          return;
        }
        finish(null, ownedCompact ? compactMetadata(data) : data);
      } catch {
        finish(failure('INVALID_ATTACHMENT_RESPONSE'));
      }
    });
    return reply.promise;
  }
  seal(beforeDispatch) {
    return this.request('seal', {}, { beforeDispatch });
  }
  state(timeout = 5000) {
    return this.request('state', {}, { timeout });
  }
  async idleSnapshot() {
    const state = await this.state();
    const idle = state.activity?.idle ?? state.isIdle;
    const busy = idle === false || state.activity?.pending_messages === true || nativeBusy(state);
    return {
      state,
      status: busy ? 'busy' : idle === true ? 'idle' : 'unknown',
      pending: pendingMessages(state),
    };
  }
  async readFeatures() {
    if (this.record.readContract !== READ_CONTRACT)
      throw new OwnerFailure('OWNER_READ_REFRESH_REQUIRED');
    const result = await this.request('read_features');
    if (result?.contract !== READ_CONTRACT) throw new OwnerFailure('OWNER_READ_REFRESH_REQUIRED');
    if (!servesSession(result, this.session)) throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    return assertReadFeatures(result);
  }
  async read(args) {
    if (this.record.readContract !== READ_CONTRACT)
      throw new OwnerFailure('OWNER_READ_REFRESH_REQUIRED');
    const result = await this.request('read', args);
    if (!servesSession(result, this.session)) throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
    const snapshot = assertReadSnapshot(result, args);
    if (
      snapshot.observation?.available &&
      snapshot.observation.owner_generation !== this.record.generation
    )
      throw new OwnerFailure('INVALID_OWNER_READ');
    return snapshot;
  }
  async snapshot() {
    const result = await this.request('snapshot');
    if (!servesSession(result, this.session) || !validNativeSnapshot(result))
      throw new OwnerFailure('INVALID_HOST_SNAPSHOT');
    return result;
  }
  async #mutationResult(op, body, beforeDispatch, parse) {
    const value = await this.request(op, body, { beforeDispatch });
    try {
      return parse(value);
    } catch (error) {
      // A malformed result cannot prove the dispatched mutation failed.
      error.uncertain = true;
      throw error;
    }
  }
  selectModel(model, { thinkingLevel, beforeDispatch } = {}) {
    return this.#mutationResult(
      'set_model',
      {
        ...(model ? { model } : {}),
        ...(thinkingLevel !== undefined ? { thinking_level: thinkingLevel } : {}),
      },
      beforeDispatch,
      modelSettings,
    );
  }
  async submitPrompt(input, { authorize, selection }) {
    const { images, text, mode, model, thinking_level } = input;
    if (hasPromptSettings(input)) {
      // Owners accept settings and input as distinct operations. Keep the
      // observed selection in the receipt even if dispatch is later refused.
      selection.model_selection = await this.selectModel(model, {
        thinkingLevel: thinking_level,
        beforeDispatch: authorize,
      });
      await authorize?.();
    }
    if (images && this.record.imagesSupported !== true)
      throw new OwnerFailure('IMAGE_INPUT_UNSUPPORTED');
    return attachedPromptResult(
      await this.request('send', { text, images, mode }, { beforeDispatch: authorize }),
    );
  }
  setSessionName(name, beforeDispatch) {
    return this.#mutationResult('set_name', { name }, beforeDispatch, (value) => ({
      name: typeof value?.name === 'string' ? value.name : name,
    }));
  }
  executeBash({ command, exclude_from_context, max_chars, beforeDispatch }) {
    return this.#mutationResult(
      'bash',
      {
        command,
        max_chars,
        ...(exclude_from_context ? { exclude_from_context: true } : {}),
      },
      beforeDispatch,
      inlineBashResult,
    );
  }
  async reload(beforeDispatch) {
    if (this.record.reloadSupported !== true) throw new OwnerFailure('RELOAD_UNSUPPORTED');
    const hosted = this.record.kind === 'host';
    try {
      const receipt = await this.request(
        'reload',
        {},
        { beforeDispatch, timeout: hosted ? 10000 : undefined },
      );
      if (receipt?.[hosted ? 'reloaded' : 'reloading'] !== true)
        throw new OwnerFailure('RELOAD_UNCONFIRMED', true);
    } catch (error) {
      if (!error.uncertain) throw error;
      if (hosted) throw new OwnerFailure('RELOAD_UNCONFIRMED', true);
    }
    // A host callback attests completion. A companion reload closes its old
    // endpoint and must confirm a replacement even after a lost reply.
    const record = hosted ? this.record : await this.#reloadedCompanion();
    return {
      status: 'completed',
      owner_version: record.bridgeVersion,
      read_compatible: record.readContract === READ_CONTRACT,
    };
  }
  async #reloadedCompanion() {
    try {
      const original = this.record;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await readClaim(this.config.attachmentDir, this.session);
        if (
          !current ||
          ['file', 'sessionId', 'kind', 'mode'].some(
            (field) => current[field] !== original[field],
          ) ||
          !sameOwner(current.owner, original.owner) ||
          !(await ownerAlive(original.owner))
        )
          break;
        if (current.generation !== original.generation && current.phase === 'ready') {
          if (typeof current.bridgeVersion !== 'string' || typeof current.readContract !== 'string')
            break;
          const replacement = new AttachedRuntime(this.config, this.session, current);
          try {
            const state = await replacement.state(
              Math.max(1, Math.min(1000, deadline - Date.now())),
            );
            if (state.sessionFile !== original.file || state.sessionId !== original.sessionId)
              break;
            if (
              (await readClaim(this.config.attachmentDir, this.session))?.generation !==
              current.generation
            )
              break;
            if (state.reloadComplete === true) return current;
          } catch (error) {
            if (error.code === 'RUNTIME_SESSION_CHANGED') break;
          }
        }
        await delay(25);
      }
    } catch {
      // Once dispatched, an unreadable replacement cannot prove rejection.
    }
    throw new OwnerFailure('RELOAD_UNCONFIRMED', true);
  }
  compact(body, beforeDispatch) {
    return this.request('compact', body, { beforeDispatch });
  }
  stopExecution({ max_chars } = {}) {
    return this.#mutationResult('stop', { max_chars }, undefined, (result) => ({
      ...stopReceipt(result),
      withdrawal: inlineWithdrawal(result.withdrawal),
    }));
  }
  async stopForDelete() {
    if (this.record.kind === 'host') {
      // Prefer session-local close for SDK hosts that may share a process.
      // Release is best effort, regardless of how a callback/transport fails.
      // Process termination below independently revalidates the binding and
      // shared-owner isolation; an error response is never signal authority.
      let result;
      try {
        result = await this.request(
          'release',
          {},
          { timeout: this.config.attachmentExitTimeoutMs },
        );
      } catch {
        // Do not turn callback error names into an additional delete gate.
      }
      if (result?.released === true) {
        const current = await readClaim(this.config.attachmentDir, this.session);
        if (current && !(isReleasedOwner(current) && current.generation === this.record.generation))
          throw new OwnerFailure('RUNTIME_SESSION_CHANGED');
        return;
      }
    }
    await terminateOwnerForDelete(this.config, this.session, this.record);
  }
}
