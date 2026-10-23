import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrControl, readRecord, writeRecord } from './herdr-control.mjs';
import { diagnostics } from './diagnostics.mjs';

const exec = promisify(execFile);

// Same child-shaped byte transport as spawn(). The scope covers the worker and
// Pi (including detached native tool children); it is not a session owner registry.
export class HerdrRpcTransport extends EventEmitter {
  constructor(binary, launch, { signal } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.scope = 'pi-bridge-rpc-' + randomUUID() + '.scope';
    this.sockets = new Set();
    this.channels = {};
    this.token = randomBytes(32).toString('hex');
    this.ready = Promise.resolve().then(() => this.start(binary, launch, signal));
  }
  async scopeActive() {
    const { stdout } = await exec(
      'systemctl',
      ['--user', 'show', this.scope, '--property=ActiveState', '--value'],
      { timeout: 8000 },
    );
    return !['inactive', 'failed'].includes(stdout.trim());
  }
  async waitForScope(forceAfterMs) {
    let deadline = forceAfterMs === undefined ? Infinity : Date.now() + forceAfterMs;
    while (await this.scopeActive()) {
      if (Date.now() >= deadline) {
        await this.signalScope('SIGKILL');
        deadline = Infinity;
      }
      await delay(25);
    }
  }
  async start(binary, launch, cancellation) {
    const timeout = AbortSignal.timeout(30000);
    const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
    signal.throwIfAborted();
    this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-herdr-'));
    const address = path.join(this.directory, 'rpc.sock');
    const ticket = path.join(this.directory, 'launch.json');
    let rejectChannels;
    const connected = new Promise((resolve, reject) => {
      rejectChannels = reject;
      this.server = createServer({ allowHalfOpen: true }, (socket) => {
        this.sockets.add(socket);
        socket.on('error', () => {});
        void (async () => {
          const hello = await readRecord(socket, signal, 1024);
          if (
            hello.token !== this.token ||
            !['control', 'rpc', 'stderr'].includes(hello.channel) ||
            this.channels[hello.channel]
          )
            throw new Error('HERDR_INVALID_HANDSHAKE');
          this.channels[hello.channel] = socket;
          if (Object.keys(this.channels).length === 3) resolve();
        })().catch(reject);
      });
    });
    connected.catch(() => {});
    signal.addEventListener('abort', () => rejectChannels(signal.reason), { once: true });
    signal.throwIfAborted();
    this.server.on('error', rejectChannels);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(address, resolve);
    });
    await fs.writeFile(ticket, JSON.stringify({ address, token: this.token }), {
      flag: 'wx',
      mode: 0o600,
    });
    this.control = await HerdrControl.open(binary);
    // A scope is required before granting Pi startup. No force-kill timeout is used.
    await exec('systemctl', ['--user', 'show-environment'], { timeout: 8000 });
    signal.throwIfAborted();
    const created = await this.control.request('workspace.create', {
      cwd: launch.cwd,
      label: 'Bridge RPC',
      focus: false,
    });
    this.pane = created.root_pane.pane_id;
    signal.throwIfAborted();
    this.scopeMayExist = true;
    const result = await this.control.request('layout.apply', {
      tab_id: created.tab.tab_id,
      focus: false,
      root: {
        type: 'pane',
        cwd: launch.cwd,
        label: 'Bridge Pi RPC',
        command: [
          'systemd-run',
          '--user',
          '--scope',
          '--quiet',
          '--collect',
          '--unit=' + this.scope,
          '--property=KillMode=control-group',
          '--property=SendSIGKILL=no',
          '--property=TimeoutStopSec=infinity',
          '--',
          process.execPath,
          fileURLToPath(new URL('./herdr-worker-entry.mjs', import.meta.url)),
          ticket,
        ],
      },
    });
    this.pane = result.layout.root.pane_id;
    await connected;
    const { control, rpc, stderr } = this.channels;
    writeRecord(control, {
      ...launch,
      pane: {
        address: this.control.address,
        identity: this.control.identity,
        id: this.pane,
      },
    });
    const ready = await readRecord(control, signal, 1024);
    if (!Number.isSafeInteger(ready.pid) || ready.pid < 1)
      throw new Error('HERDR_INVALID_HANDSHAKE');
    this.pid = ready.pid;
    // Once pid is known PiRpc applies the same PID/start/boot and session checks.
    this.stdin.pipe(rpc);
    rpc.pipe(this.stdout);
    stderr.pipe(this.stderr);
    for (const socket of [rpc, stderr, control]) {
      socket.on('error', (error) => this.emit('error', error));
    }
    const drained = Promise.all(
      [rpc, stderr].map((socket) => finished(socket, { writable: false, cleanup: true })),
    );
    drained.catch(() => {});
    // A missing control channel is not an exit. Stop the owned scope and wait
    // for kernel-confirmed death before emitting the child lifecycle events.
    this.observation = (async () => {
      let result;
      try {
        result = await readRecord(control, undefined, 1024);
        if (!(
          (Number.isInteger(result.code) && result.signal === null) ||
          (result.code === null && typeof result.signal === 'string')
        ))
          throw new Error('HERDR_INVALID_EXIT');
        await drained;
      } catch (error) {
        this.emit('error', error);
        await this.terminateScope();
        result = { code: null, signal: 'SIGTERM' };
      }
      // Pi is gone; reap any native tool descendants before releasing authority.
      await this.terminateScope();
      this.emit('exit', result.code, result.signal);
      await this.cleanup();
      this.emit('close', result.code, result.signal);
    })();
    this.observation.catch((error) => {
      this.emit('error', error);
      this.emit('exitError', error);
    });
    this.emit('spawn');
  }
  async signalScope(signal) {
    try {
      await exec(
        'systemctl',
        ['--user', 'kill', '--kill-whom=all', '--signal=' + signal, this.scope],
        { timeout: 8000 },
      );
    } catch (error) {
      // Normal EOF can empty/collect the scope between observation and signal.
      // Only confirmed inactivity makes a failed kill harmless.
      if (await this.scopeActive()) throw error;
    }
  }
  async terminateScope(forceAfterMs) {
    if (this.scopeMayExist && (await this.scopeActive())) {
      await this.signalScope('SIGTERM');
      // Only explicit delete supplies a force deadline. This scope was created
      // for this writer, never inferred from an external owner's process group.
      await this.waitForScope(forceAfterMs);
    }
  }
  async terminate() {
    // PiRpc has already validated the writer identity before requesting stop.
    await this.terminateScope();
  }
  async cleanup() {
    for (const socket of this.sockets) socket.destroy();
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    if (this.pane) {
      try {
        await this.control.request('pane.close', { pane_id: this.pane });
      } catch (error) {
        if (error.code !== 'pane_not_found')
          diagnostics.emit('operation.failure', { code: 'HERDR_PANE_CLEANUP_FAILED' });
      }
      this.pane = null;
    }
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
  }
  async abortStartup() {
    // Prevent a late worker from receiving a grant, including uncertain layout ACKs.
    for (const socket of this.sockets) socket.destroy();
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    await this.terminateScope();
    await this.cleanup();
  }
}
