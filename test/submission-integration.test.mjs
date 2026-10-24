import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { Submissions } from '../src/submissions.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { aiEntry } from './fixtures/pi.mjs';

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('SUBMISSION_TEST_TIMEOUT');
}

async function fixture(t, { native = false, disposition = 'handled', holdProvider = false } = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-submissions-');
  const project = path.join(dir, 'project');
  const gate = path.join(dir, 'release-input');
  const providerGate = path.join(dir, 'release-provider');
  const callsFile = path.join(dir, 'input-calls');
  await fs.mkdir(project);
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: project }],
    defaults: { ...denyAllPermissions(), create: true, send: true, read: true },
  };
  const calls = [];
  const runtime = {
    alive: true,
    generation: 'synthetic-submission-owner',
    state: async () => ({ isIdle: true }),
    command: async (command) => {
      calls.push(command);
      return { disposition: 'handled' };
    },
    stop: async () => {
      runtime.alive = false;
    },
  };
  if (native) {
    const extension = path.join(dir, 'submission-probe.mjs');
    await fs.writeFile(
      extension,
      `import fs from 'node:fs/promises';
       import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(aiEntry)};
       const gate=${JSON.stringify(gate)}, calls=${JSON.stringify(callsFile)}, providerGate=${JSON.stringify(providerGate)};
       export default pi=>{
         globalThis.fetch=async()=>{throw Error('Submission fixture blocks network');};
         const faux=fauxProvider({provider:'submission-fixture',models:[{id:'offline',name:'Offline submission test'}],tokensPerSecond:1000});
         faux.setResponses(Array.from({length:4},()=>async()=>{
           while(${holdProvider}&&!await fs.stat(providerGate).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));
           return fauxAssistantMessage('SUBMISSION_RESULT');
         }));
         pi.registerProvider(faux.provider);
         pi.on('input',async()=>{
           await fs.appendFile(calls,'input\\n');
           while(!await fs.stat(gate).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));
           ${disposition === 'handled' ? "return {action:'handled'};" : ''}
         });
       };`,
    );
    config.piArgs.push('-e', extension, '--provider', 'submission-fixture', '--model', 'offline');
  }
  const bridge = await new Bridge(config, native ? undefined : async () => runtime).init();
  t.after(async () => {
    await fs.writeFile(gate, 'release');
    await fs.writeFile(providerGate, 'release');
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, config, project, gate, providerGate, callsFile, calls, runtime };
}

for (const disposition of ['handled', 'started'])
  test(
    `real Pi late ${disposition} ACK updates one submission without repeating its input`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, { native: true, disposition });
      ackTimeout(t, ['prompt'], 50);
      const saved = await savedSession(f.bridge);
      const args = { session_id: saved.session_id, text: 'IDENTICAL_INPUT' };
      const sent = await f.bridge.send(args);
      assert.equal(sent.status, 'unknown', JSON.stringify(sent));
      assert.equal(sent.reason, 'ACK_TIMEOUT');
      const query = { session_id: saved.session_id, submission_id: sent.submission_id };
      const runtime = f.bridge.pool.get(saved.session_id);
      assert.equal(runtime.promptAdmission.id, sent.submission_id);
      for (let i = 0; i < 3; i++)
        assert.equal((await f.bridge.submission(query)).receipt.status, 'unknown');
      assert.equal(await fs.readFile(f.callsFile, 'utf8'), 'input\n');
      await fs.writeFile(f.gate, 'release');
      await until(async () => (await f.bridge.submission(query)).receipt.status === disposition);
      assert.deepEqual((await f.bridge.submission(query)).receipt, { status: disposition });
      await until(() => runtime.exited && !f.bridge.autoReleases.size);

      const next = await f.bridge.send(args);
      assert.equal(next.status, disposition, JSON.stringify(next));
      assert.notEqual(next.submission_id, sent.submission_id);
      await until(() => !f.bridge.pool.instances.size && !f.bridge.autoReleases.size);
      assert.equal(await fs.readFile(f.callsFile, 'utf8'), 'input\ninput\n');
      t.mock.method(f.bridge.pool, 'resolve', () => assert.fail('Receipt query must not start Pi'));
      t.mock.method(f.bridge.pool, 'forRead', () =>
        assert.fail('Receipt query must not probe an owner'),
      );
      const result = await callBridgeTool(f.bridge, 'submission', query);
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.receipt, { status: disposition });
      assert.equal(result.structuredContent.completion, undefined);
      assert.equal(result.structuredContent.leaf_id, undefined);
    },
  );

test(
  'native settlement does not relabel queued submissions as completed work',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { native: true, disposition: 'started', holdProvider: true });
    await fs.writeFile(f.gate, 'release');
    const saved = await savedSession(f.bridge);
    const started = await f.bridge.send({ session_id: saved.session_id, text: 'FIRST_INPUT' });
    assert.equal(started.status, 'started');
    const runtime = f.bridge.pool.get(saved.session_id);
    await until(async () => (await runtime.state()).isStreaming);
    const queued = [];
    for (const mode of ['follow_up', 'steer']) {
      const result = await f.bridge.send({
        session_id: saved.session_id,
        text: 'QUEUED_INPUT',
        mode,
      });
      assert.equal(result.status, 'queued', JSON.stringify(result));
      queued.push(result.submission_id);
    }
    assert.notEqual(queued[0], queued[1]);
    await fs.writeFile(f.providerGate, 'release');
    await until(() => runtime.exited && !f.bridge.autoReleases.size);
    for (const submission_id of queued) {
      const record = await f.bridge.submission({ session_id: saved.session_id, submission_id });
      assert.deepEqual(record.receipt, { status: 'queued' });
      assert.equal(record.completion, undefined);
      assert.equal(record.result, undefined);
    }
  },
);

test('submission lookup checks current read/send/create grants and exact session without acquiring an owner', async (t) => {
  const f = await fixture(t);
  f.config.defaults = { ...denyAllPermissions(), create: true };
  const made = await f.bridge.create({ project: f.project, text: 'CREATE_ONLY_INPUT' });
  assert.equal(made.status, 'handled', JSON.stringify(made));
  const createQuery = { session_id: made.session_id, submission_id: made.submission_id };
  assert.equal((await f.bridge.submission(createQuery)).operation, 'create');
  f.config.defaults = { ...denyAllPermissions(), send: true };
  const sent = await f.bridge.send({ session_id: made.session_id, text: 'SEND_ONLY_INPUT' });
  assert.equal(sent.status, 'handled');
  const sendQuery = { session_id: made.session_id, submission_id: sent.submission_id };
  const other = await savedSession(f.bridge);
  t.mock.method(f.bridge.pool, 'resolve', () => assert.fail('Receipt query must not start Pi'));
  t.mock.method(f.bridge.pool, 'forRead', () =>
    assert.fail('Receipt query must not probe an owner'),
  );
  for (const grant of ['send', 'read']) {
    f.config.defaults = { ...denyAllPermissions(), [grant]: true };
    for (const query of [createQuery, sendQuery])
      assert.equal((await f.bridge.submission(query)).receipt.status, 'handled');
  }
  f.config.defaults = { ...denyAllPermissions(), create: true };
  assert.equal((await f.bridge.submission(createQuery)).receipt.status, 'handled');
  await assert.rejects(f.bridge.submission(sendQuery), /NOT_FOUND_OR_DENIED/);
  f.config.defaults = { ...denyAllPermissions(), read: true };
  await assert.rejects(
    f.bridge.submission({ ...sendQuery, session_id: other.session_id }),
    /SUBMISSION_UNAVAILABLE/,
  );
  f.config.defaults = denyAllPermissions();
  for (const query of [createQuery, sendQuery])
    await assert.rejects(f.bridge.submission(query), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.calls.length, 2);
});

test('expired and evicted Bridge submissions return unavailable without retrying work', async (t) => {
  const f = await fixture(t);
  let time = Date.now();
  f.bridge.submissions = new Submissions({ now: () => time, limit: 1, ttl: 100 });
  const saved = await savedSession(f.bridge);
  const args = { session_id: saved.session_id, text: 'SAME_INPUT' };
  const first = await f.bridge.send(args);
  const second = await f.bridge.send(args);
  assert.notEqual(first.submission_id, second.submission_id);
  await assert.rejects(
    f.bridge.submission({ session_id: saved.session_id, submission_id: first.submission_id }),
    /SUBMISSION_UNAVAILABLE/,
  );
  time += 100;
  await assert.rejects(
    f.bridge.submission({ session_id: saved.session_id, submission_id: second.submission_id }),
    /SUBMISSION_UNAVAILABLE/,
  );
  assert.equal(f.calls.length, 2);
});

test('a native late ACK winning the timeout race removes the obsolete uncertainty reason', async (t) => {
  const f = await fixture(t);
  f.runtime.command = async (_command, _timeout, onLate) => {
    await onLate({ ok: true, data: { disposition: 'started' } });
    throw Object.assign(new Error('ACK_TIMEOUT'), { code: 'ACK_TIMEOUT', uncertain: true });
  };
  const saved = await savedSession(f.bridge);
  const sent = await f.bridge.send({ session_id: saved.session_id, text: 'RACE_INPUT' });
  assert.equal(sent.status, 'started');
  assert.equal(sent.reason, undefined);
  assert.deepEqual(
    (await f.bridge.submission({ session_id: saved.session_id, submission_id: sent.submission_id }))
      .receipt,
    { status: 'started' },
  );
  const made = await f.bridge.create({ project: f.project, text: 'RACE_CREATE_INPUT' });
  assert.equal(made.status, 'started');
  assert.equal(made.send.reason, undefined);
});
