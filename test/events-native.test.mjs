import { mcpRequest } from './fixtures/tool-call.mjs';
import { until } from './fixtures/until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Webhook } from 'standardwebhooks';
import { createHttpService } from '../src/http-server.mjs';
import { TOKEN_HEADER } from '../src/mcp/http-config.mjs';
import { MODERN_VERSION } from '../src/mcp/protocol.mjs';
import { nativeOwner, fauxArgs, gatedExtension } from './fixtures/native-owner.mjs';

test(
  'authenticated MCP subscription reports the final automatic continuation once, then reads that exact result after a later round',
  { timeout: 30000 },
  async (t) => {
    const f = await nativeOwner(t, {
      prefix: 'events-native',
      async configure(context) {
        const { dir, config, cleanup } = context;
        cleanup.push(async () => {
          for (const gate of ['release-continuation', 'release-shutdown'])
            await fs.writeFile(path.join(dir, gate), 'go');
        });
        config.piArgs.push(...fauxArgs, '--thinking', 'off');
        await gatedExtension(
          context,
          `
      let continued = false;
      const inputText = ctx => {
        const input = ctx.sessionManager.getBranch().findLast(e => e.message?.role === 'user')?.message.content;
        return typeof input === 'string' ? input : input?.find(b => b.type === 'text')?.text;
      };
      pi.on('session_shutdown', () => wait('release-shutdown'));
      pi.on('message_end', (event, ctx) => {
        if (event.message.role !== 'assistant') return;
        for (const block of event.message.content)
          if (block.type === 'text') block.text += ' (' + inputText(ctx) + ')';
      });
      pi.on('agent_before_settle', async (_event, ctx) => {
        if (continued || inputText(ctx) !== 'FIRST') return;
        continued = true;
        await mark('continuation-ready');
        await wait('release-continuation');
        return {
          entries: [{type:'custom_message', customType:'continuation-probe', content:'Finish the final report.', display:false}],
          continue:true,
        };
      });
        `,
        );
      },
    });
    const { bridge, id } = f;
    const token = 'local-test-token-not-a-credential';
    const service = createHttpService(bridge, { token });
    const url = await service.listen();
    f.cleanup.push(() => service.close());
    const events = [];
    const secret = 'whsec_' + Buffer.alloc(32, 4).toString('base64');
    bridge.events.post = async (_url, body, headers) => {
      const data = new Webhook(secret).verify(body, headers);
      if (data.type === 'verification')
        return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
      assert.equal(data.eventId, headers['webhook-id']);
      events.push(data);
      return { status: 204, body: '' };
    };
    let requestId = 0;
    async function call(method, params) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TOKEN_HEADER]: token,
          'MCP-Protocol-Version': MODERN_VERSION,
          'MCP-Method': method,
          ...(method === 'tools/call' ? { 'MCP-Name': params.name } : {}),
        },
        body: JSON.stringify(mcpRequest(method, params, ++requestId)),
      });
      return { status: response.status, body: await response.json() };
    }
    const input = {
      name: 'session.settled',
      arguments: { session_id: id },
      delivery: { mode: 'webhook', url: 'https://callback.example/original-chat', secret },
    };
    const subscribed = await call('events/subscribe', input);
    assert.equal(subscribed.status, 200, JSON.stringify(subscribed));
    const send = (text) =>
      call('tools/call', {
        name: 'send',
        arguments: { session_id: id, text },
      });
    assert.equal((await send('FIRST')).body.result.structuredContent.status, 'started');
    await until(() => fs.stat(path.join(f.dir, 'continuation-ready')).catch(() => null));
    assert.equal(events.length, 0, 'Intermediate completion must not publish a settled event');
    await f.mark('release-continuation');
    await until(() => events.length === 1);
    const first = events[0];
    assert.equal(first.data.result.text, 'Synthetic response 2. (FIRST)');
    assert.equal(bridge.pool.get(id).exited, false, 'completion precedes exit');
    await f.mark('release-shutdown');
    await until(() => !bridge.pool.get(id) && !bridge.lane(id));
    await send('SECOND');
    await until(() => events.length === 2);
    assert.notEqual(first.data.leaf_id, events[1].data.leaf_id);
    // A matching memory reader must not intercept the event's native leaf read.
    const unhookReader = bridge.compatibilityServices.sessionReaders.register('memory-probe', {
      matches: () => true,
      read: () => assert.fail('Settlement read must bypass a current-memory reader'),
    });
    const result = await call('tools/call', {
      name: 'read',
      arguments: first.data.read,
    });
    unhookReader();
    const read = result.body.result.structuredContent;
    assert.equal(read.leaf_id, first.data.leaf_id);
    assert.match(JSON.stringify(read.items), /Synthetic response 2\. \(FIRST\)/);
    assert.doesNotMatch(JSON.stringify(read.items), /SECOND/);
  },
);
