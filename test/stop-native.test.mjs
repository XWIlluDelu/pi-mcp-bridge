import { until } from './fixtures/until.mjs';
import { aiEntry, buildSessionProjection, RpcClient } from './fixtures/pi.mjs';

import { savedEntries } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';

import { executeBatch } from '../src/batch.mjs';
import { processIdentity } from '../src/attachments.mjs';
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
  return f;
}
for (const op of ['send', 'command'])
  test(
    'batch lane ' + op + ' stays withdrawn after external Stop and a later batch Stop',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, true),
        id = f.session.id;
      f.config.grants[0].command = true;
      await f.bridge.pool.resolve(f.session);
      const entered = Promise.withResolvers(),
        finish = Promise.withResolvers();
      f.cleanup.push(() => finish.resolve());
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
      assert.ok(!(await fs.readFile(f.session.file, 'utf8')).includes('MUST_NOT_DISPATCH'));
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
      assert.equal(restarted.results[1].result.status, op === 'send' ? 'started' : 'completed');
      assert.equal(f.bridge.inputs.size, 0);
    },
  );

async function hostedClient(f) {
  const controller = await reserveHostSession({
    buildSessionProjection,
    attachmentDir: f.config.attachmentDir,
    session: f.session,
  });
  const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  const client = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.cwd,
    env: { ...env, ...f.env },
    args: ['--session', f.session.file, ...f.config.piArgs],
  });
  f.cleanup.push(async () => {
    try {
      await client.stop();
    } finally {
      await controller.close();
    }
  });
  await client.start();
  await client.getState();
  await controller.ready(createRpcHostBinding(client), {
    owner: await processIdentity(
      JSON.parse(await fs.readFile(path.join(f.dir, 'pid.json'), 'utf8')),
    ),
  });
  return client;
}

for (const owned of [true, false])
  test(
    `native Stop withdraws queued inputs and aborts agent and bash (${owned ? 'owned' : 'RPC host'})`,
    {
      timeout: 30000,
    },
    async (t) => {
      const f = await fixture(t, owned);
      const client = owned ? null : await hostedClient(f);
      const args = { session_id: f.id };
      const send = (text, mode) => f.bridge.send({ ...args, text, mode });
      const command = (command) => f.bridge.command({ ...args, command });
      f.config.grants[0].command = true;
      if (client) assert.equal((await command('HOOK_ONLY')).output, 'HOOK_NATIVE_RESULT');
      assert.equal((await send('START_SLOW')).status, 'started');
      const runtime = f.bridge.pool.get(f.id);
      const state = () => (client ? client.getState() : runtime.state());
      await until(async () => (await state()).isStreaming);
      const steering = 'STEERING 😀 " ' + 'long queued text '.repeat(4000);
      for (const [mode, text] of [
        ['steer', steering],
        ['follow_up', 'FOLLOW_UP_PROMPT'],
      ])
        assert.equal((await send(text, mode)).status, 'queued');
      assert.equal((await state()).pendingMessageCount, 2);
      const marker = path.join(f.dir, 'bash-started');
      const bash = client
        ? client.bash(`touch '${marker}'; sleep 30`)
        : command(`touch '${marker}'; sleep 30`);
      await until(() => fs.stat(marker).catch(() => null));
      const stopped = await f.bridge.stop({ ...args, max_chars: 32768 });
      assert.equal(stopped.status, 'accepted');
      assert.ok(steering.startsWith(stopped.withdrawn_text));
      assert.ok(stopped.withdrawn_text.startsWith('STEERING'));
      assert.equal(stopped.withdrawn_complete, false);
      assert.equal((await bash).cancelled, true);
      const released = async (rpc) => {
        await until(() => rpc.exited && !f.bridge.autoReleases.size);
        assert.equal(rpc.child.exitCode, 0);
      };
      if (client) {
        const stoppedState = await state();
        assert.equal(stoppedState.pendingMessageCount, 0);
        assert.equal(stoppedState.isStreaming, false);
      } else await released(runtime);
      assert.equal((await send('CONTINUE_NORMALLY')).status, 'started');
      if (client) {
        await until(async () => !(await state()).isStreaming);
        assert.equal((await state()).sessionId, f.session.header.id);
        assert.equal((await f.bridge.stop(args)).generation, stopped.generation);
      } else {
        const next = f.bridge.pool.get(f.id);
        assert.notEqual(next.generation, runtime.generation);
        await released(next);
      }
      const rows = client
        ? (await client.getEntries()).entries
        : await savedEntries(f.bridge, f.id);
      assert.doesNotMatch(JSON.stringify(rows), /FOLLOW_UP_PROMPT/);
      assert.match(JSON.stringify(rows), /AFTER_STOP_REPLY/);
    },
  );
