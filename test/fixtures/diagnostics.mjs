import { denyAllPermissions } from './permissions.mjs';
import assert from 'node:assert/strict';
import { isolatedRuntime } from './isolated-runtime.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../../src/bridge.mjs';
import { PiRpc } from '../../src/rpc.mjs';
import { createHttpService, TOKEN_HEADER } from '../../src/http-server.mjs';
import { diagnostics, diagnosticRef } from '../../src/diagnostics.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'PRIVATE_PATH-')),
  cwd = path.join(dir, 'project');
await fs.mkdir(cwd);
const config = {
  ...isolatedRuntime(dir),
  principal: 'fixture',
  defaults: denyAllPermissions(),
  stateDir: path.join(dir, 'state'),
  sessionRoots: [path.join(dir, 'sessions')],
  folders: [{ id: 'project', path: cwd }],
  grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
};
config.piArgs.push(
  '-e',
  path.resolve('test/fixtures/faux-extension.mjs'),
  '--provider',
  'bridge-fixture',
  '--model',
  'deterministic',
);
const configFile = path.join(dir, 'config.json');
await fs.writeFile(configFile, JSON.stringify(config));
const bridge = await new Bridge(config, undefined, { configFile }).init(),
  token = 'PRIVATE_TOKEN_' + 'x'.repeat(32);
const service = createHttpService(bridge, { token }),
  url = await service.listen();
async function call(name, args, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [TOKEN_HEADER]: token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result?.isError, undefined);
  return body.result.structuredContent;
}
try {
  const args = { project: cwd, text: 'PRIVATE_BODY', request_id: 'PRIVATE_MUTATION' },
    created = await call('create', args, 'PRIVATE_RPC_ID');
  await call('create', args, 2);
  const saved = await bridge.session(created.session_id);

  await bridge.pool.resolve(await bridge.session(created.session_id));
  const read = await call('read', { session_id: created.session_id }, 3);
  assert.ok(JSON.stringify(read).includes('PRIVATE_BODY'));
  const denied = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 401);
  await denied.text();
  // Controlled bridge transport fixture: no Pi method is modified.
  let command;
  const rpc = new PiRpc(config, saved);
  rpc.alive = true;
  rpc.child = {
    stdin: {
      write: (line) => {
        command = JSON.parse(line);
      },
    },
  };
  await assert.rejects(
    diagnostics.measure(
      'tool',
      { op: 'send', mutation_ref: diagnosticRef('PRIVATE_MUTATION_TIMEOUT') },
      () =>
        rpc.dispatch({ type: 'prompt', message: 'PRIVATE_BODY' }, 5, () =>
          diagnostics.emit('fixture.late_callback'),
        ),
    ),
    { code: 'ACK_TIMEOUT' },
  );
  rpc.receiveResponse(
    {
      type: 'response',
      id: command.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    },
    rpc.generation,
  );
} finally {
  await service.close();
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true }));
