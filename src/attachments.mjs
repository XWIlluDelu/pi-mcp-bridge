import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_ATTACHMENT_SNAPSHOT_BYTES,
} from './attachment-protocol.mjs';
import { readLfLines } from './lf-lines.mjs';
import { assertReadSnapshot, READ_CONTRACT } from './context-read.mjs';
import { stopReceipt, inlineWithdrawal } from './stop-execution.mjs';
import { inlineBashResult } from './bash-execution.mjs';
import { hasPromptSettings } from './prompt-input.mjs';
import { diagnostics } from './diagnostics.mjs';
// Cooperative, owner-private Linux/Unix-socket attachment transport. No credentials.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { assertSingleSessionFile } from './data.mjs';
import { atomicJson, opaqueId, assertPrivateDirectory } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
export class AttachmentFailure extends Error {
  constructor(code, uncertain = false, options) {
    super(code, options);
    this.code = code;
    this.uncertain = uncertain;
  }
}
export async function processIdentity(pid = process.pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1)
    throw new AttachmentFailure('PROCESS_IDENTITY_UNAVAILABLE');
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
    throw new AttachmentFailure('PROCESS_IDENTITY_UNAVAILABLE', false, { cause });
  }
}
export function isReleasedOwner(record) {
  return record?.owner === null && record.phase === 'released' && record.noColdReacquire === true;
}
export async function ownerAlive(owner) {
  if (owner === null) return false;
  const current = await processIdentity(owner.pid);
  return Boolean(
    current &&
    current.start === owner.start &&
    current.boot === owner.boot &&
    !['Z', 'X'].includes(current.state),
  );
}
export async function privateDirectory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir))
    throw new AttachmentFailure('INVALID_ATTACHMENT_DIRECTORY');
  // Validate identically for bridge and extension, before either can treat a missing claim as safe.
  if (Buffer.byteLength(path.join(dir, '2147483647-12345678.sock')) > 100)
    throw new AttachmentFailure('ATTACHMENT_SOCKET_PATH_TOO_LONG');
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
  return path.join(dir, `${opaqueId(`${session.file}\0${session.header.id}`)}.owner.json`);
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
  return readOwnerRecord(dir, claimFile(dir, session), session);
}
export async function readOwnerRecord(dir, file, session, scope = {}) {
  let handle;
  try {
    // Validate the opened inode and bound the read itself, including growth after stat.
    // NONBLOCK also prevents a replaced special file from hanging registry scans.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192)
      throw new Error();
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw new Error();
    const record = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    const released = isReleasedOwner(record);
    const identified =
      Number.isSafeInteger(record?.owner?.pid) &&
      record.owner.pid > 0 &&
      typeof record.owner.start === 'string' &&
      typeof record.owner.boot === 'string';
    // Establish scope from the bounded private inode before interpreting its
    // protocol. An unrelated owner's mismatch must not block this session.
    // Ambiguous path/identity or unsafe storage still fails closed.
    if (
      typeof record?.file !== 'string' ||
      !path.isAbsolute(record.file) ||
      record.file.includes('\0') ||
      (!released && !identified)
    )
      throw new Error();
    if (scope.file !== undefined && record.file !== scope.file) return null;
    if (
      scope.owner &&
      (record.owner?.pid !== scope.owner.pid ||
        record.owner.start !== scope.owner.start ||
        record.owner.boot !== scope.owner.boot)
    )
      return null;
    const fields = [
      'kind',
      'mode',
      'file',
      'sessionId',
      'generation',
      'owner',
      'phase',
      'socket',
      'noColdReacquire',
      'handoffId',
      'releaseSupported',
      'imagesSupported',
      'readContract',
    ];
    if (Object.keys(record).some((key) => !fields.includes(key)))
      throw new AttachmentFailure('ATTACHMENT_PROTOCOL_MISMATCH');
    if (
      typeof record.sessionId !== 'string' ||
      !['tui', 'rpc', 'host', 'extension', 'delete'].includes(record.kind) ||
      typeof record.generation !== 'string'
    )
      throw new Error();
    if (session && (record.file !== session.file || record.sessionId !== session.header.id))
      throw new Error();
    if (
      (['tui', 'host', 'extension'].includes(record.kind) || record.socket !== undefined) &&
      (typeof record.socket !== 'string' || path.dirname(record.socket) !== dir)
    )
      throw new Error();
    if (record.noColdReacquire !== undefined && typeof record.noColdReacquire !== 'boolean')
      throw new Error();
    return record;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof AttachmentFailure) throw e;
    throw new AttachmentFailure('INVALID_ATTACHMENT_RECORD');
  } finally {
    await handle?.close();
  }
}
// Call while holding registryTransaction: a changed header must not bypass
// an existing path owner merely because its claim has a different filename.
// Without a header, check every claim on the path before native open. A local
// session replacement may reuse this process; this read does not reserve it.
export async function assertNoOtherLiveOwner(dir, session, { allowSameProcess = false } = {}) {
  for (const name of await fs.readdir(dir)) {
    if (!/^ps_[a-f0-9]{32}\.owner\.json$/.test(name)) continue;
    const other = await readOwnerRecord(dir, path.join(dir, name), undefined, {
      file: session.file,
    });
    if (
      other &&
      other.file === session.file &&
      other.sessionId !== session.header?.id &&
      (!allowSameProcess || other.owner?.pid !== process.pid) &&
      (await ownerAlive(other.owner))
    )
      throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
  }
}
export async function reserveOwner(dir, session, kind, owner = undefined) {
  return registryTransaction(dir, async () => {
    await assertSingleSessionFile(session.file);
    await assertNoOtherLiveOwner(dir, session);
    const old = await readClaim(dir, session);
    if (old && (await ownerAlive(old.owner))) throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
    // Only explicit owner-local release pauses cold resume. Ordinary join
    // reservations are protected by their exact live process identity.
    if (kind === 'rpc' && old?.noColdReacquire)
      throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    const record = {
      ...(old?.noColdReacquire ? { noColdReacquire: true } : {}),
      kind,
      file: session.file,
      sessionId: session.header.id,
      generation: randomUUID(),
      owner: owner ?? (await processIdentity()),
      phase: 'starting',
    };
    if (['tui', 'host', 'extension'].includes(kind))
      record.socket = path.join(dir, `${process.pid}-${record.generation.slice(0, 8)}.sock`);
    await atomicJson(claimFile(dir, session), record);
    return record;
  });
}
export async function updateOwner(dir, session, record, changes) {
  return registryTransaction(dir, async () => {
    const current = await readClaim(dir, session);
    if (current?.generation !== record.generation)
      throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    if (isReleasedOwner(current)) {
      // Late teardown is idempotent; never republish its cached live owner.
      if (changes.phase === 'transitioning' && Object.keys(changes).length === 1) return current;
      throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    }
    Object.assign(record, current.noColdReacquire ? { noColdReacquire: true } : {}, changes);
    await atomicJson(claimFile(dir, session), record);
    return record;
  });
}
export async function releaseOwner(dir, session, record) {
  return registryTransaction(dir, async () => {
    const current = await readClaim(dir, session);
    if (current?.generation === record.generation) {
      if (current.noColdReacquire)
        await atomicJson(claimFile(dir, session), { ...current, phase: 'released', owner: null });
      else await fs.unlink(claimFile(dir, session));
    }
  });
}
export async function waitOwnerExit(owner, timeout = 5000) {
  const until = Date.now() + timeout;
  while (await ownerAlive(owner)) {
    if (Date.now() >= until) throw new AttachmentFailure('OWNER_STILL_ALIVE');
    await new Promise((r) => setTimeout(r, 25));
  }
}
export class AttachedRuntime {
  constructor(config, session, record) {
    this.config = config;
    this.session = session;
    this.record = record;
    this.alive = true;
    this.attached = true;
  }
  async request(op, body = {}, timeout = 5000, beforeDispatch) {
    return diagnostics.measure('attached.request', { op, generation: this.record.generation }, () =>
      this.requestOnce(op, body, timeout, beforeDispatch),
    );
  }
  async requestOnce(op, body = {}, timeout = 5000, beforeDispatch) {
    const mutating = ['send', 'stop', 'bash', 'compact'].includes(op);
    const serialized =
      JSON.stringify({
        op,
        body,
        generation: this.record.generation,
        file: this.record.file,
        sessionId: this.record.sessionId,
      }) + '\n';
    if (Buffer.byteLength(serialized) > MAX_ATTACHMENT_REQUEST_BYTES)
      throw new AttachmentFailure('ATTACHMENT_REQUEST_TOO_LARGE');
    const current = await readClaim(this.config.attachmentDir, this.session);
    if (current?.generation !== this.record.generation)
      throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    if (!(await ownerAlive(this.record.owner)) || current.phase !== 'ready')
      throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.record.socket);
      let bytes = 0,
        partial,
        written = false,
        done = false,
        lines;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        lines?.close();
        socket.destroy();
        if (error && partial !== undefined) error.result = partial;
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () => finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE', written && mutating)),
        timeout,
      );
      socket.on('error', () =>
        finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE', written && mutating)),
      );
      socket.on('end', () =>
        finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE', written && mutating)),
      );
      socket.on('connect', async () => {
        try {
          await beforeDispatch?.();
        } catch (error) {
          finish(error);
          return;
        }
        if (done) return;
        written = true;
        socket.write(serialized);
      });
      socket.on('data', (chunk) => {
        bytes += chunk.length;
        if (
          bytes >
          (['snapshot', 'read'].includes(op)
            ? MAX_ATTACHMENT_SNAPSHOT_BYTES + 2048
            : ['bash', 'stop'].includes(op)
              ? MAX_ATTACHMENT_REQUEST_BYTES
              : 256 * 1024 + 2048)
        )
          finish(
            new AttachmentFailure(
              op === 'snapshot' ? 'SESSION_TOO_LARGE' : 'INVALID_ATTACHMENT_RESPONSE',
              written && mutating,
            ),
          );
      });
      lines = readLfLines(socket, (line) => {
        if (done) return;
        try {
          const response = JSON.parse(line);
          if (response.generation !== this.record.generation) throw new Error();
          if (response.partial === true) {
            if (op === 'bash') partial = inlineBashResult(response.data);
            else if (op === 'stop')
              partial = { withdrawal: inlineWithdrawal(response.data?.withdrawal) };
            else throw new Error();
            return;
          }
          if (
            op === 'compact' &&
            [
              'COMPACT_UNSUPPORTED',
              'COMPACT_IDLE_UNCONFIRMED',
              'COMPACT_BUSY',
              'COMPACTION_PENDING',
              'PI_REJECTED',
              'INVALID_ARGUMENTS',
            ].includes(response.error)
          )
            return finish(new AttachmentFailure(response.error));
          if (op === 'compact' && response.error === 'HOST_COMPACT_UNCERTAIN')
            return finish(new AttachmentFailure(response.error, true));
          if (
            op === 'send' &&
            [
              'MODEL_SELECTION_UNSUPPORTED',
              'COMPACTION_PENDING',
              'MODEL_SELECTION_PENDING',
              'MODEL_UNAVAILABLE',
              'THINKING_LEVEL_UNSUPPORTED',
              'THINKING_SUPPORT_UNKNOWN',
              'IMAGE_INPUT_UNSUPPORTED',
              'MODEL_IMAGE_INPUT_UNSUPPORTED',
              'INVALID_PROMPT_INPUT',
              'INVALID_ATTACHED_SEND',
            ].includes(response.error)
          )
            return finish(new AttachmentFailure(response.error));
          if (mutating && ['STOP_IN_PROGRESS', 'BASH_IN_PROGRESS'].includes(response.error))
            return finish(new AttachmentFailure(response.error));
          if (op === 'bash' && response.error === 'BASH_UNSUPPORTED')
            return finish(new AttachmentFailure('BASH_UNSUPPORTED'));
          if (op === 'stop' && response.error === 'STOP_UNSUPPORTED')
            return finish(new AttachmentFailure('STOP_UNSUPPORTED'));
          if (response.error)
            return finish(
              new AttachmentFailure(
                [
                  'MODEL_SELECTION_CHANGED',
                  'MODEL_SELECTION_FAILED',
                  'INVALID_MODEL_SELECTION',
                  'THINKING_LEVEL_UNSUPPORTED',
                  'THINKING_SUPPORT_UNKNOWN',
                  'BASH_UNSUPPORTED',
                  'INVALID_BASH_RESULT',
                  'STOP_IN_PROGRESS',
                  'STOP_UNSUPPORTED',
                  'INVALID_STOP_RECEIPT',
                  'RUNTIME_SESSION_CHANGED',
                  'SESSION_TOO_LARGE',
                  'ENTRY_NOT_FOUND',
                  'STALE_CURSOR',
                  'INVALID_CURSOR',
                  'INVALID_READ_ARGUMENTS',
                  'OWNER_READ_REFRESH_REQUIRED',
                  'HOST_RELEASE_UNSUPPORTED',
                  'HOST_RELEASE_FAILED',
                  'HOST_NOT_READY',
                  'HOST_SUBMIT_UNCERTAIN',
                  'READ_BUDGET_TOO_SMALL',
                  'READ_SNAPSHOT_TOO_LARGE',
                  'INVALID_OWNER_READ',
                  'READ_SNAPSHOT_CHANGED',
                  'INVALID_HOST_SNAPSHOT',
                ].includes(response.error)
                  ? response.error
                  : 'ATTACHED_OPERATION_FAILED',
                written && mutating,
              ),
            );
          finish(null, response.data);
        } catch {
          finish(new AttachmentFailure('INVALID_ATTACHMENT_RESPONSE', written && mutating));
        }
      });
    });
  }
  async start() {
    await this.state();
    return this;
  }
  async state(timeout = 5000) {
    const state = await this.request('state', {}, timeout);
    if (
      this.record.kind === 'host' &&
      (state?.capabilities?.send !== true ||
        typeof state.capabilities.command !== 'boolean' ||
        typeof state.capabilities.stop !== 'boolean')
    )
      throw new AttachmentFailure('OWNER_COMPONENT_UPDATE_REQUIRED');
    return state;
  }
  async read(args) {
    if (this.record.readContract !== READ_CONTRACT)
      throw new AttachmentFailure('OWNER_READ_REFRESH_REQUIRED');
    const result = await this.request('read', args);
    if (result?.sessionFile !== this.session.file || result?.sessionId !== this.session.header.id)
      throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    return assertReadSnapshot(result, args);
  }
  async snapshot() {
    const result = await this.request('snapshot');
    if (
      result?.sessionFile !== this.session.file ||
      result?.sessionId !== this.session.header.id ||
      !Array.isArray(result.entries) ||
      !result.entries.every((entry) => typeof entry?.id === 'string' && entry.id.length <= 128) ||
      !(
        result.leafId === null ||
        (typeof result.leafId === 'string' && result.leafId.length <= 128)
      )
    )
      throw new AttachmentFailure('INVALID_HOST_SNAPSHOT');
    return result;
  }
  send(args) {
    if (hasPromptSettings(args)) throw new AttachmentFailure('MODEL_SELECTION_UNSUPPORTED');
    if (args.images && this.record.imagesSupported !== true)
      throw new AttachmentFailure('IMAGE_INPUT_UNSUPPORTED');
    return this.request(
      'send',
      {
        text: args.text,
        ...(args.images ? { images: args.images } : {}),
        mode: args.mode ?? 'default',
      },
      args.timeout_ms ?? 5000,
      args.beforeDispatch,
    );
  }
  async executeBash({ command, max_chars, timeout_ms = 5000, beforeDispatch }) {
    await beforeDispatch?.();
    const result = await this.request(
      'bash',
      { command, max_chars, timeout_ms },
      timeout_ms,
      beforeDispatch,
    );
    try {
      return inlineBashResult(result);
    } catch (error) {
      error.uncertain = true;
      throw error;
    }
  }
  compact(body, timeout, beforeDispatch) {
    return this.request('compact', body, timeout, beforeDispatch);
  }
  async stopExecution({ max_chars, timeout_ms = 5000 } = {}) {
    const result = await this.request('stop', { max_chars, timeout_ms }, timeout_ms);
    try {
      return { ...stopReceipt(result), withdrawal: inlineWithdrawal(result?.withdrawal) };
    } catch (error) {
      error.uncertain = true;
      throw error;
    }
  }
  async stop() {
    this.alive = false;
  } // Disconnect only. Never shut down external Pi on bridge close.
  async stopForDelete() {
    // Public RPC extension shutdown is deferred, and this child is not ours.
    // Keep its read/send endpoint alive; never request host exit or kill it.
    if (this.record.kind === 'extension') throw new AttachmentFailure('HOST_RELEASE_UNSUPPORTED');
    if (this.record.kind === 'host') {
      // A shared SDK host may keep other sessions alive. Only the host can
      // close this session's admission and drain its own preparation work.
      const result = await this.request('release', {}, this.config.attachmentExitTimeoutMs ?? 5000);
      if (result?.released !== true) throw new AttachmentFailure('HOST_RELEASE_FAILED');
      const current = await readClaim(this.config.attachmentDir, this.session);
      if (current && !(isReleasedOwner(current) && current.generation === this.record.generation))
        throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
      this.alive = false;
      return;
    }
    await this.request('shutdown');
    await waitOwnerExit(this.record.owner, this.config.attachmentExitTimeoutMs ?? 5000);
    await releaseOwner(this.config.attachmentDir, this.session, this.record);
    this.alive = false;
  }
}
