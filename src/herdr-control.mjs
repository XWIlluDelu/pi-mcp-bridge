import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const serviceKeys = new Set([
  'SYSTEMD_EXEC_PID',
  'INVOCATION_ID',
  'NOTIFY_SOCKET',
  'JOURNAL_STREAM',
  'LISTEN_PID',
  'LISTEN_FDS',
  'LISTEN_FDNAMES',
]);
export async function findHerdr(env = process.env) {
  for (const directory of [
    ...(env.PATH ?? '/usr/bin:/bin').split(path.delimiter),
    path.join(env.HOME ?? os.homedir(), '.local', 'bin'),
  ]) {
    const file = path.resolve(directory, 'herdr');
    try {
      if ((await fs.stat(file)).isFile()) {
        await fs.access(file, constants.X_OK);
        return file;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

// Startup/control records only. Native RPC bytes never pass through this decoder.
export function readRecord(socket, signal, limit = 65536) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      socket.pause();
      socket.off('data', data);
      socket.off('error', fail);
      socket.off('end', ended);
      socket.off('close', ended);
      signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve(value);
    };
    const fail = (error) => finish(error);
    const ended = () => fail(new Error('HERDR_DISCONNECTED'));
    const aborted = () => fail(signal.reason);
    const data = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0 && buffer.length <= limit) return;
      if (end < 0 || end > limit) return fail(new Error('HERDR_INVALID_RECORD'));
      socket.pause();
      if (end + 1 < buffer.length) socket.unshift(buffer.subarray(end + 1));
      try {
        finish(null, JSON.parse(buffer.subarray(0, end).toString('utf8')));
      } catch {
        fail(new Error('HERDR_INVALID_RECORD'));
      }
    };
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('end', ended);
    socket.once('close', ended);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (socket.destroyed || socket.readableEnded) ended();
    else socket.resume();
  });
}
export function writeRecord(socket, value) {
  socket.write(JSON.stringify(value) + '\n');
}
async function socketIdentity(address) {
  const stat = await fs.lstat(address, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.getuid()))
    throw new Error('HERDR_UNSAFE_SOCKET');
  return [stat.dev, stat.ino, stat.ctimeNs].join(':');
}

// Pin the daemon incarnation, so cleanup cannot address a reused pane on a new server.
export class HerdrControl {
  constructor(address, identity) {
    this.address = address;
    this.identity = identity;
  }
  async request(method, params = {}) {
    const signal = AbortSignal.timeout(8000);
    const check = async () => {
      if ((await socketIdentity(this.address)) !== this.identity)
        throw new Error('HERDR_SERVER_CHANGED');
    };
    await check();
    const socket = connect(this.address);
    socket.on('error', () => {});
    try {
      await once(socket, 'connect', { signal });
      await check();
      const id = randomUUID();
      writeRecord(socket, { id, method, params });
      const response = await readRecord(socket, signal);
      if (response.id !== id) throw new Error('HERDR_INVALID_RECORD');
      if (response.error)
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return response.result;
    } finally {
      socket.destroy();
    }
  }
  static async open(binary, environment = process.env) {
    const env = { ...environment };
    for (const key of Object.keys(env))
      if (
        key.startsWith('PI_MCP_') ||
        [
          'HERDR_ENV',
          'HERDR_SESSION',
          'HERDR_SOCKET_PATH',
          'HERDR_CLIENT_SOCKET_PATH',
          'HERDR_PANE_ID',
          'HERDR_TAB_ID',
          'HERDR_WORKSPACE_ID',
        ].includes(key)
      )
        delete env[key];
    const status = async () =>
      JSON.parse(
        (await exec(binary, ['status', 'server', '--json'], { env, timeout: 8000 })).stdout,
      );
    let current = await status();
    if (current.status === 'not_running' && current.running === false) {
      // Keep a shared daemon outside a service's cgroup, without changing enable/linger.
      if (env.INVOCATION_ID || env.SYSTEMD_EXEC_PID) {
        await exec(
          'systemd-run',
          [
            '--user',
            '--collect',
            '--quiet',
            '--unit=pi-bridge-herdr-' + randomUUID(),
            // Values stay in the environment, never in argv or command-error text.
            ...Object.keys(env)
              .filter(
                (key) =>
                  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                  env[key] !== undefined &&
                  !serviceKeys.has(key),
              )
              .map((key) => '--setenv=' + key),
            '--',
            binary,
            'server',
          ],
          { env, timeout: 8000 },
        );
      } else {
        const child = spawn(binary, ['server'], { env, detached: true, stdio: 'ignore' });
        await once(child, 'spawn');
        child.unref();
      }
      const deadline = Date.now() + 8000;
      do {
        await delay(50);
        current = await status();
      } while (!current.running && Date.now() < deadline);
    }
    if (current.running && current.compatible !== true) throw new Error('HERDR_PROTOCOL_MISMATCH');
    if (!current.running || typeof current.socket !== 'string')
      throw new Error('HERDR_UNAVAILABLE');
    const control = new HerdrControl(current.socket, await socketIdentity(current.socket));
    if ((await control.request('ping')).protocol !== current.protocol)
      throw new Error('HERDR_PROTOCOL_MISMATCH');
    return control;
  }
}
