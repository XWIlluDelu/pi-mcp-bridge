import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { META, MODERN_VERSION } from '../../src/protocol.mjs';

const base = fileURLToPath(new URL('../../', import.meta.url));
const server = fileURLToPath(new URL('../../src/server.mjs', import.meta.url));
const meta = { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} };

export function launchStdio(f, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, server, f.configFile], {
    cwd: base,
    env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '',
    next = 0;
  const pending = new Map();
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    const resolve = pending.get(value.id);
    if (resolve) {
      pending.delete(value.id);
      resolve(value);
    }
  });
  const done = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  f.cleanup.unshift(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    lines.close();
  });
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      write({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });
    });
  return {
    child,
    request,
    call: async (name, args) => (await request('tools/call', { name, arguments: args })).result,
    stderr: () => stderr,
    exit: async () => {
      const result = await done;
      assert.equal(result.signal, null, stderr);
      return result.code;
    },
  };
}
