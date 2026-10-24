import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Webhook } from 'standardwebhooks';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { META, MODERN_VERSION } from '../src/protocol.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

async function until(fn) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(10);
  }
  throw new Error('EVENT_COMPLETION_TIMEOUT');
}

test(
  'authenticated MCP subscription receives real Pi settlement before exit, then reads that exact result after a later round',
  { timeout: 30000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-events-native-');
    const gate = dir + '/release-shutdown';
    const config = {
      ...isolatedRuntime(dir),
      stateDir: dir + '/state',
      sessionRoots: [dir + '/sessions'],
      folders: [{ path: dir }],
      defaults: { ...denyAllPermissions(), read: true, send: true },
    };
    const extension = dir + '/shutdown-gate.mjs';
    await fs.writeFile(
      extension,
      `
    import fs from 'node:fs/promises';
    export default pi => pi.on('session_shutdown', async () => {
      while (!await fs.stat(${JSON.stringify(gate)}).then(()=>true,()=>false))
        await new Promise(r=>setTimeout(r,10));
    });
  `,
    );
    config.piArgs.push(
      '-e',
      path.resolve('test/fixtures/faux-extension.mjs'),
      '-e',
      extension,
      '--provider',
      'bridge-fixture',
      '--model',
      'deterministic',
      '--thinking',
      'off',
    );
    await fs.mkdir(config.piRuntime.agentDir);
    await fs.writeFile(
      config.piRuntime.agentDir + '/settings.json',
      JSON.stringify({
        cacheWarming: 'off',
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const bridge = await new Bridge(config).init();
    const token = 'local-test-token-not-a-credential';
    const service = createHttpService(bridge, { token });
    const url = await service.listen();
    t.after(async () => {
      await fs.writeFile(gate, 'go');
      await service.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const made = await savedSession(bridge),
      events = [],
      verification = [];
    const secret = 'whsec_' + Buffer.alloc(32, 4).toString('base64');
    bridge.events.post = async (_url, body, headers) => {
      const data = new Webhook(secret).verify(body, headers);
      if (data.type === 'verification') {
        verification.push(data);
        return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
      }
      assert.equal(data.eventId, headers['webhook-id']);
      events.push(data);
      return { status: 204, body: '' };
    };
    let requestId = 0;
    async function call(method, params = {}, credentials = token) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TOKEN_HEADER]: credentials,
          'MCP-Protocol-Version': MODERN_VERSION,
          'MCP-Method': method,
          ...(method === 'tools/call' ? { 'MCP-Name': params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++requestId,
          method,
          params: {
            ...params,
            _meta: {
              [META + 'protocolVersion']: MODERN_VERSION,
              [META + 'clientCapabilities']: {},
            },
          },
        }),
      });
      return { status: response.status, body: await response.json() };
    }
    const input = {
      name: 'session.settled',
      arguments: { session_id: made.session_id },
      delivery: { mode: 'webhook', url: 'https://callback.example/original-chat', secret },
    };
    assert.equal((await call('events/subscribe', input, 'wrong')).status, 401);
    assert.equal(verification.length, 0);
    const subscribed = await call('events/subscribe', input);
    assert.equal(subscribed.status, 200, JSON.stringify(subscribed));
    assert.equal(verification.length, 1);
    const send = (text) =>
      call('tools/call', {
        name: 'send',
        arguments: { session_id: made.session_id, text },
      });
    const firstSend = await send('FIRST');
    assert.equal(firstSend.body.result.isError, undefined, JSON.stringify(firstSend));
    const firstSubmission = firstSend.body.result.structuredContent.submission_id;
    assert.match(firstSubmission, /^[a-f0-9-]{36}$/);
    await until(() => events.length === 1);
    const first = events[0];
    assert.equal(first.data.session_id, made.session_id);
    assert.equal(first.data.aborted, false);
    assert.equal(typeof first.data.leaf_id, 'string');
    assert.equal(bridge.pool.get(made.session_id).exited, false, 'completion is not process exit');
    const runtime = bridge.pool.get(made.session_id);
    const duplicate = {
      op: 'settled',
      session_id: made.session_id,
      generation: runtime.ownerRecord.generation,
      sequence: runtime.completionSequence,
      leafId: first.data.leaf_id,
      aborted: false,
      timestamp: first.timestamp,
    };
    await assert.rejects(ownerRequest(config, duplicate), /INVALID_OWNER_COMMAND/);
    await assert.rejects(
      ownerRequest(config, { ...duplicate, generation: 'retired' }),
      /INVALID_OWNER_COMMAND/,
    );
    assert.equal(events.length, 1);
    await fs.writeFile(gate, 'go');
    await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
    const secondSend = await send('SECOND');
    assert.notEqual(secondSend.body.result.structuredContent.submission_id, firstSubmission);
    await until(() => events.length === 2);
    await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
    assert.notEqual(first.data.leaf_id, events[1].data.leaf_id);
    const receipt = await call('tools/call', {
      name: 'submission',
      arguments: { session_id: made.session_id, submission_id: firstSubmission },
    });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.result.isError, undefined);
    assert.deepEqual(receipt.body.result.structuredContent.receipt, { status: 'started' });
    assert.equal(receipt.body.result.structuredContent.leaf_id, undefined);
    assert.equal(bridge.pool.get(made.session_id), null);
    const result = await call('tools/call', {
      name: 'read',
      arguments: {
        session_id: first.data.session_id,
        leaf_id: first.data.leaf_id,
        preset: 'latest',
      },
    });
    const read = result.body.result.structuredContent;
    assert.equal(read.leaf_id, first.data.leaf_id);
    assert.ok(JSON.stringify(read.items).includes('Synthetic response 1.'), JSON.stringify(read));
    assert.equal(JSON.stringify(read.items).includes('SECOND'), false);
    const session = await bridge.session(made.session_id);
    assert.equal(
      (await fs.readFile(session.file, 'utf8')).includes('pi_bridge_session_settled'),
      false,
    );
    const { secret: _, ...destination } = input.delivery;
    assert.equal(
      (await call('events/unsubscribe', { ...input, delivery: destination })).status,
      200,
    );
    assert.equal(bridge.events.records.size, 0);
  },
);
