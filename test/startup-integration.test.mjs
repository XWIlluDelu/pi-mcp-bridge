import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { processIdentity } from '../src/attachments.mjs';
import { PiRpc } from '../src/rpc.mjs';

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('PROOF_TIMEOUT');
}
function ipc(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error('PROOF_IPC_TIMEOUT')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => {
      try {
        const response = JSON.parse(buffer);
        if (response.error) reject(new Error(response.error));
        else resolve(response.data);
      } catch (error) { reject(error); }
    });
  });
}
const userText = entry => entry.type === 'message' && entry.message?.role === 'user'
  ? entry.message.content.map(part => part.text ?? '').join('') : '';

test('ordinary RPC startup supports a public companion, native RPC, settlement and process replacement', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-startup-'));
  const cwd = path.join(dir, 'project'), agentDir = path.join(dir, 'agent');
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ cacheWarm: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
  // A selected profile's normal automatic discovery, not an explicit -e.
  await fs.writeFile(path.join(agentDir, 'extensions', 'profile-probe.js'),
    "export default pi => pi.on('session_start', () => pi.appendEntry('profile-discovery', { loaded: true }));\n");
  const manager = SessionManager.create(cwd, path.join(dir, 'sessions'));
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'saved seed' }], timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage('saved seed response'));
  const file = manager.getSessionFile(), socketPath = path.join(dir, 'proof.sock');
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_BRIDGE_PROOF_SOCKET: socketPath });
  const options = {
    cliPath: path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    cwd, env, provider: 'bridge-fixture', model: 'deterministic',
    args: ['--session', file, '-e', path.resolve('research/faux-extension.mjs'), '-e', path.resolve('test/fixtures/startup-companion.mjs')],
  };
  let client = new RpcClient(options);
  t.after(async () => { await client.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  let rpcSettled = 0;
  client.onEvent(event => { if (event.type === 'agent_settled') rpcSettled += 1; });
  await client.start();
  await client.getState();
  const before = await ipc(socketPath, { op: 'read' });
  assert.equal(before.mode, 'rpc');
  assert.equal(before.sessionId, manager.getSessionId());
  assert.equal(before.sessionFile, file);
  assert.equal(before.settled, 0);
  assert.ok(before.entries.some(entry => entry.customType === 'profile-discovery'));
  for (const tool of ['read', 'bash', 'edit', 'write']) assert.ok(before.tools.includes(tool));
  const shell = await client.bash('pwd');
  assert.equal(shell.exitCode, 0);
  assert.equal(shell.output.trim(), cwd);

  const submitted = await ipc(socketPath, { op: 'send', text: 'COMPANION_STARTUP_PROOF' });
  assert.deepEqual(submitted, { dispatch: 'submitted', returnWasUndefined: true });
  const afterExtension = await until(async () => {
    const read = await ipc(socketPath, { op: 'read' });
    return read.settled === 1 && read.idle && !read.pending ? read : undefined;
  });
  assert.equal(afterExtension.entries.filter(entry => userText(entry) === 'COMPANION_STARTUP_PROOF').length, 1);
  assert.ok(afterExtension.entries.some(entry => entry.message?.role === 'assistant' && entry.message.content.some(part => part.text === 'Synthetic response 1.')));
  assert.deepEqual((await client.getEntries()).entries, afterExtension.entries);
  await until(() => rpcSettled === 1);

  const receipt = await client.prompt('RPC_LAUNCHER_PROOF');
  assert.equal(receipt, 'started');
  await until(() => rpcSettled === 2);
  const afterRpc = await ipc(socketPath, { op: 'read' });
  assert.equal(afterRpc.settled, 2);
  assert.equal(afterRpc.entries.filter(entry => userText(entry) === 'RPC_LAUNCHER_PROOF').length, 1);
  assert.equal(afterRpc.idle, true);
  t.diagnostic(JSON.stringify({ companion: submitted, rpc: receipt, sessionSettled: afterRpc.settled, ordinaryTools: before.tools, persistedMessages: afterRpc.entries.filter(entry => entry.type === 'message').length }));

  // An external idle shutdown request alone does NOT immediately stop RPC.
  assert.deepEqual(await ipc(socketPath, { op: 'shutdown' }), { shutdown: 'requested' });
  await delay(50);
  assert.ok(await processIdentity(before.pid));
  assert.ok(await fs.stat(file));
  await client.getState(); // A later RPC command checks the shutdown flag.
  await until(async () => !await processIdentity(before.pid));
  await client.stop();
  assert.ok(await fs.stat(file));

  client = new RpcClient(options);
  await client.start();
  await client.getState();
  const reopened = await ipc(socketPath, { op: 'read' });
  assert.notEqual(reopened.pid, before.pid);
  assert.equal(reopened.sessionId, before.sessionId);
  assert.equal(reopened.settled, 0); // An observation, not persisted request completion.
  assert.equal(reopened.entries.filter(entry => userText(entry) === 'COMPANION_STARTUP_PROOF').length, 1);
  assert.equal(reopened.entries.filter(entry => userText(entry) === 'RPC_LAUNCHER_PROOF').length, 1);
  t.diagnostic('idle external shutdown stayed alive until a later RPC command; reopen preserved both inputs with a new process');
  await client.stop();

  // The Bridge launcher must honor a selected profile's ordinary discovery too.
  // This test explicitly selects a disposable profile and filtered environment.
  const owned = await new PiRpc({
    stateDir: path.join(dir, 'bridge-state'),
    piRuntime: { agentDir, inheritEnv: [], tools: ['read', 'bash', 'edit', 'write'] },
    piArgs: ['--offline', '-e', path.resolve('research/faux-extension.mjs'), '--provider', 'bridge-fixture', '--model', 'deterministic'],
  }, { file, cwd, header: { id: before.sessionId } }).start();
  try {
    const initial = await owned.entries();
    assert.ok(initial.entries.filter(entry => entry.customType === 'profile-discovery').length > reopened.entries.filter(entry => entry.customType === 'profile-discovery').length);
    assert.equal(initial.activity.settlement.sequence, 0);
    const ack = await owned.command({ type: 'prompt', message: 'BRIDGE_OWNED_SETTLEMENT_PROOF' });
    assert.equal(ack.disposition, 'started');
    await until(() => owned.settlement.sequence === 1);
    const observed = await owned.entries();
    assert.equal(observed.activity.settlement.generation, owned.generation);
    assert.equal(observed.activity.settlement.sequence, 1);
    assert.equal(observed.activity.settlement.aborted, false);
    assert.equal(observed.activity.idle, null);
  } finally { await owned.stop(); }
});
