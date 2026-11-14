import { until } from './fixtures/until.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { aiEntry } from './fixtures/pi.mjs';

import { savedEntries } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { RpcClient } from './fixtures/pi.mjs';

import { executeBatch } from '../src/batch.mjs';
import { readClaim, processIdentity } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding } from '../src/host-bindings.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';

import { nativeOwner } from './fixtures/native-owner.mjs';

async function fixture(t, owned = false) {
  const f = await nativeOwner(t, {
    prefix: 'stop',
    factory: owned ? undefined : async () => assert.fail('external owner must not spawn Pi'),
    async configure({ dir, config }) {
      const extension = path.join(dir, 'provider.mjs');
      await fs.writeFile(
        extension,
        `import fs from 'node:fs';
 import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(aiEntry)};
 export default pi=>{
   globalThis.fetch=async()=>{throw new Error('offline fixture blocks network');};
   fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid.json'))},JSON.stringify(process.pid));
   const faux=fauxProvider({provider:'stop-native-fixture',models:[{id:'slow'}],tokensPerSecond:40,tokenSize:{min:4,max:4}});
   faux.setResponses(Array.from({length:20},()=>async(context)=>fauxAssistantMessage(JSON.stringify(context.messages.findLast(m=>m.role==='user')?.content).includes('CONTINUE_NORMALLY')?'AFTER_STOP_REPLY':'slow response '.repeat(1000))));
   pi.registerProvider(faux.provider);
   pi.on('user_bash',event=>{if(event.command==='HOOK_ONLY')return {result:{output:'HOOK_NATIVE_RESULT',exitCode:0,cancelled:false,truncated:false}};});
 };`,
      );
      config.grants[0].delete = false;
      config.piArgs.push(
        '-e',
        extension,
        '--provider',
        'stop-native-fixture',
        '--model',
        'slow',
        '--thinking',
        'off',
      );
    },
  });
  return { ...f, saved: f.session, pidFile: path.join(f.dir, 'pid.json'), cleanups: f.cleanup };
}
for (const op of ['send', 'command'])
  test(
    'batch lane ' + op + ' stays withdrawn after external Stop and a later batch Stop',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, true),
        id = f.saved.id;
      f.config.grants[0].command = true;
      await f.bridge.pool.resolve(f.saved);
      const entered = Promise.withResolvers(),
        finish = Promise.withResolvers();
      f.cleanups.push(() => finish.resolve());
      const read = f.bridge.read.bind(f.bridge);
      let held = false;
      t.mock.method(f.bridge, 'read', async (...args) => {
        const value = await read(...args);
        if (!held) {
          held = true;
          entered.resolve();
          await finish.promise;
        }
        return value;
      });
      const input = {
        op,
        args: {
          session_id: id,
          ...(op === 'send'
            ? { text: 'MUST_NOT_DISPATCH' }
            : { command: 'printf MUST_NOT_DISPATCH' }),
        },
      };
      const batch = executeBatch(f.bridge, {
        operations: [
          { op: 'read', args: { session_id: id } },
          { op: 'stop', args: { session_id: id } },
          input,
        ],
      });
      await entered.promise;
      assert.equal(f.bridge.inputs.size, 1);
      const stopped = await f.bridge.stop({ session_id: id });
      assert.equal(stopped.status, 'accepted', JSON.stringify(stopped));
      assert.equal(stopped.acknowledgement, 'native_ack');
      finish.resolve();
      const result = await batch;
      assert.equal(result.results[2].result.reason, 'STOP_IN_PROGRESS', JSON.stringify(result));
      assert.equal(f.bridge.inputs.size, 0);
      assert.ok(!(await fs.readFile(f.saved.file, 'utf8')).includes('MUST_NOT_DISPATCH'));
      const fresh = {
        op,
        args: {
          session_id: id,
          ...(op === 'send'
            ? { text: 'CONTINUE_NORMALLY' }
            : { command: 'printf CONTINUE_NORMALLY' }),
        },
      };
      const restarted = await executeBatch(f.bridge, {
        operations: [{ op: 'stop', args: { session_id: id } }, fresh],
      });
      assert.equal(
        restarted.results[1].result.status,
        op === 'send' ? 'started' : 'completed',
        JSON.stringify(restarted),
      );
      assert.equal(f.bridge.inputs.size, 0);
      await until(() => !f.bridge.pool.get(id) && !f.bridge.autoReleases.size);
      assert.equal(
        (await f.bridge[op](fresh.args)).status,
        op === 'send' ? 'started' : 'completed',
      );
    },
  );

async function exerciseBash(f, native) {
  const id = f.saved.id;
  f.config.grants[0].command = true;
  const hook = await f.bridge.command({ session_id: id, command: 'HOOK_ONLY' });
  assert.equal(hook.output, 'HOOK_NATIVE_RESULT');
  const marker = path.join(f.dir, 'bash-started');
  const bash = f.bridge.command({ session_id: id, command: `touch '${marker}'; sleep 30` });
  await until(() => fs.stat(marker).catch(() => null));
  assert.equal((await f.bridge.stop({ session_id: id })).status, 'accepted');
  assert.equal((await bash).cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}
async function exercise(f, native) {
  const first = await f.bridge.send({
    session_id: f.saved.id,
    text: 'START_SLOW',
  });
  assert.ok(['started', 'unknown'].includes(first.status));
  await until(async () => (await native.getState()).isStreaming);
  const steering = 'STEERING 😀 " \\ ' + 'long queued text '.repeat(4000),
    followUp = 'FOLLOW_UP_PROMPT';
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.saved.id,
          text: steering,
          mode: 'steer',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.saved.id,
          text: followUp,
          mode: 'follow_up',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal((await native.getState()).pendingMessageCount, 2);
  const receipt = await f.bridge.stop({ session_id: f.saved.id, max_chars: 32768 });
  assert.equal(receipt.status, 'accepted');
  const out = receipt.withdrawn_text;
  assert.ok((steering + '\n\n' + followUp).startsWith(out));
  assert.equal(receipt.withdrawn_complete, false);
  assert.equal((await native.getState()).pendingMessageCount, 0);
  assert.equal((await native.getState()).isStreaming, false);
  const claim = await readClaim(f.bridge.pool.attachmentDir, f.saved),
    generation = receipt.generation;
  assert.equal(generation, f.bridge.pool.get(f.saved.id).generation ?? claim.generation);
  const entries = (await native.getEntries()).entries;
  assert.ok(
    !entries.some(
      (entry) =>
        entry.message?.role === 'user' &&
        JSON.stringify(entry.message.content).includes('FOLLOW_UP_PROMPT'),
    ),
  );
  // Independent native bash is not covered by agent abort alone.
  const bash = native.bash('sleep 30');
  await delay(100);
  const stopped = await f.bridge.stop({ session_id: f.saved.id });
  assert.equal(stopped.status, 'accepted');
  assert.equal((await bash).cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
  const after = await f.bridge.send({
    session_id: f.saved.id,
    text: 'CONTINUE_NORMALLY',
  });
  assert.ok(['started', 'unknown'].includes(after.status));
  await until(async () => !(await native.getState()).isStreaming);
  assert.match(JSON.stringify((await native.getEntries()).entries), /AFTER_STOP_REPLY/);
  assert.equal((await f.bridge.stop({ session_id: f.saved.id })).generation, generation);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}

test(
  'Bridge-owned offline Pi cancels agent and bash, withdraws queued text, then releases and resumes history',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true),
      id = f.saved.id;
    await exerciseBash(f, {
      getEntries: async () => ({ entries: await savedEntries(f.bridge, id) }),
      getState: async () => {
        await f.bridge.pool.instances.get(id)?.autoReleaseTask;
        return (await f.bridge.pool.resolve(await f.bridge.session(id))).state();
      },
    });
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: id, text: 'START_SLOW' })).status,
      ),
      'Expected native prompt admission',
    );
    const runtime = f.bridge.pool.get(id),
      generation = runtime.generation;
    await until(async () => (await runtime.state()).isStreaming);
    const steering = 'STEERING 😀 " \\ ' + 'long queued text '.repeat(4000),
      followUp = 'FOLLOW_UP_PROMPT';
    for (const [mode, text] of [
      ['steer', steering],
      ['follow_up', followUp],
    ])
      assert.equal((await f.bridge.send({ session_id: id, mode, text })).status, 'queued');
    const marker = path.join(f.dir, 'concurrent-bash');
    const bash = f.bridge.command({
      session_id: id,
      command: "printf started > '" + marker + "'; sleep 30",
    });
    await until(() =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    const stopped = await f.bridge.stop({ session_id: id, max_chars: 32768 });
    assert.equal(stopped.status, 'accepted');
    assert.ok((steering + '\n\n' + followUp).startsWith(stopped.withdrawn_text));
    assert.equal(stopped.withdrawn_complete, false);
    assert.equal((await bash).cancelled, true);
    await until(() => runtime.exited && !f.bridge.autoReleases.size);
    assert.equal(runtime.child.exitCode, 0);
    assert.equal(runtime.child.signalCode, null);
    assert.equal(
      (await savedEntries(f.bridge, id)).filter((e) => e.message?.role === 'user').length,
      1,
    );
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: id, text: 'CONTINUE_NORMALLY' })).status,
      ),
      'Expected native prompt admission',
    );
    const next = f.bridge.pool.get(id);
    assert.notEqual(next.generation, generation);
    await until(() => next.exited && !f.bridge.autoReleases.size);
    assert.match(JSON.stringify(await savedEntries(f.bridge, id)), /AFTER_STOP_REPLY/);
    assert.equal(next.child.exitCode, 0);
    assert.equal(next.child.signalCode, null);
  },
);

test(
  'public RPC host binding uses existing child and returns all withdrawal through private IPC',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      controller = await reserveHostSession({
        buildSessionProjection: hostProjection,
        attachmentDir: f.bridge.pool.attachmentDir,
        session: f.saved,
      });
    const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    Object.assign(env, {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir,
      PI_OFFLINE: '1',
    });
    const client = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
      env,
      args: ['--session', f.saved.file, ...f.config.piArgs],
    });
    f.cleanups.push(async () => {
      await client.stop();
      await controller.close();
    });
    await client.start();
    await client.getState();
    await controller.ready(createRpcHostBinding(client), {
      owner: await processIdentity(JSON.parse(await fs.readFile(f.pidFile, 'utf8'))),
    });
    await exerciseBash(f, client);
    await exercise(f, client);
  },
);
