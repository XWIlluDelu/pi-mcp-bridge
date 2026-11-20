import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { nativeRpcHost } from './fixtures/native-rpc.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';
import { offlineModels, sdkSession } from './fixtures/native-sdk.mjs';
import { fauxAssistantMessage, fauxProvider } from './fixtures/pi.mjs';
import { readClaim } from '../src/runtime/attachments.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/runtime/host-bindings.mjs';

const deferred = () => Promise.withResolvers();
const fixture = (t) => nativeOwner(t, { factory: () => assert.fail('Unexpected second writer') });
test('official host-owned Pi RPC serves bridge reads and sends without spawning; timed-out replies do not redispatch', async (t) => {
  const f = await fixture(t),
    saved = f.session;
  const { client, controller, owner } = await nativeRpcHost(f, {
    args: [...f.config.piArgs, '--no-extensions', '--no-tools', ...fauxArgs],
  });
  const binding = createRpcHostBinding(client),
    gate = deferred();
  let submissions = 0;
  f.cleanup.unshift(() => gate.resolve());
  await controller.ready({
    ...binding,
    submit: async (args) => {
      submissions++;
      const result = await binding.submit(args);
      if (args.text === 'PUBLIC_DELAYED_REPLY') await gate.promise;
      return result;
    },
  });
  const idleOnly = await f.bridge.send({
    session_id: saved.id,
    text: 'MUST_NOT_SEND',
    mode: 'idle_only',
  });
  assert.equal(idleOnly.status, 'rejected');
  assert.equal(idleOnly.reason, 'HOST_ADMISSION_UNSUPPORTED');
  const first = await f.bridge.send({ session_id: saved.id, text: 'PUBLIC_RPC_INPUT' });
  assert.equal(first.status, 'started');
  await until(async () => !(await client.getState()).isStreaming);
  assert.match(JSON.stringify(await f.bridge.read({ session_id: saved.id })), /PUBLIC_RPC_INPUT/);
  ackTimeout(t, ['send']);
  const delayedArgs = {
    session_id: saved.id,
    text: 'PUBLIC_DELAYED_REPLY',
  };
  const delayed = await f.bridge.send(delayedArgs);
  assert.equal(delayed.status, 'unknown');
  assert.equal(submissions, 2);
  gate.resolve();
  await until(async () => !(await client.getState()).isStreaming);
  const entries = await client.getEntries();
  assert.ok(!JSON.stringify(entries).includes('MUST_NOT_SEND'));
  assert.equal(
    entries.entries.filter(
      (e) =>
        e.message?.role === 'user' &&
        JSON.stringify(e.message.content).includes('PUBLIC_DELAYED_REPLY'),
    ).length,
    1,
  );
  assert.equal((await readClaim(f.config.attachmentDir, saved)).owner.pid, owner.pid);
});

test('two official SDK sessions in one host PID release independently without shutting down their neighbor', async (t) => {
  const f = await fixture(t),
    savedA = f.session,
    savedB = await f.create();
  const faux = fauxProvider({
    provider: 'host-sdk-fixture',
    models: [{ id: 'a', input: ['text'] }],
  });
  faux.setResponses([
    fauxAssistantMessage('PUBLIC_A_REPLY'),
    fauxAssistantMessage('PUBLIC_B_REPLY'),
  ]);
  const modelRuntime = await offlineModels(faux);
  const hosts = [];
  for (const saved of [savedA, savedB]) {
    const controller = await f.reserveHost(saved);
    const session = await sdkSession({ ...f, session: saved }, modelRuntime, faux.getModel(), {
      agentDir: path.join(f.dir, saved === savedA ? 'agent-a' : 'agent-b'),
    });
    let released = 0;
    f.cleanup.push(async () => {
      await session.abort();
      session.dispose();
    });
    await controller.ready(
      createSdkHostBinding(session, {
        release: async () => {
          await session.abort();
          session.dispose();
          released++;
          return { released: true };
        },
      }),
    );
    hosts.push({
      session,
      get released() {
        return released;
      },
    });
  }
  const claimA = await readClaim(f.config.attachmentDir, savedA),
    claimB = await readClaim(f.config.attachmentDir, savedB);
  assert.equal(claimA.owner.pid, process.pid);
  assert.equal(claimB.owner.pid, process.pid);
  assert.notEqual(claimA.generation, claimB.generation);
  const sentA = await f.bridge.send({
    session_id: savedA.id,
    text: 'PUBLIC_A_INPUT',
    mode: 'idle_only',
  });
  assert.equal(sentA.status, 'dispatched');
  await until(() => !hosts[0].session.isStreaming && faux.state.callCount === 1);
  assert.match(JSON.stringify(await f.bridge.read({ session_id: savedA.id })), /PUBLIC_A_INPUT/);
  const removed = await f.bridge.delete({ session_id: savedA.id });
  assert.equal(removed.status, 'deleted');
  assert.equal(hosts[0].released, 1);
  assert.equal(hosts[1].released, 0);
  assert.equal((await readClaim(f.config.attachmentDir, savedB)).generation, claimB.generation);
  const sentB = await f.bridge.send({
    session_id: savedB.id,
    text: 'PUBLIC_B_INPUT',
  });
  assert.equal(sentB.status, 'dispatched');
  await until(() => !hosts[1].session.isStreaming && faux.state.callCount === 2);
  assert.match(JSON.stringify(await f.bridge.read({ session_id: savedB.id })), /PUBLIC_B_INPUT/);
  assert.ok(await fs.stat(savedB.file));
});
