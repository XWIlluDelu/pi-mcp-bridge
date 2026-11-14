import packageInfo from '../package.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { META } from '../src/protocol.mjs';
import { launchStdio } from './fixtures/stdio-client.mjs';

test('per-request MCP over stdio creates a session and reads it in a batch', async (t) => {
  const f = await nativeOwner(t, {
    prefix: 'mcp-stdio',
    seed: false,
    configure({ config }) {
      config.grants[0].send = false;
      config.piArgs.push(...fauxArgs);
    },
  });
  await f.bridge.close();
  const client = launchStdio(f);
  const discovery = await client.request('server/discover');
  assert.equal(discovery.result._meta[META + 'serverInfo'].version, packageInfo.version);
  const call = async (name, args) => {
    const result = await client.call(name, args);
    assert.ok(!result.isError);
    return result.structuredContent;
  };
  const made = await call('create', {
    project: f.cwd,
    text: 'initial fixture',
  });
  assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
  const { results } = await call('batch', {
    operations: [
      { op: 'list', args: {} },
      { op: 'read', args: { session_id: made.session_id } },
    ],
  });
  assert.equal(results[0].result.sessions[0].session_id, made.session_id);
  assert.equal(results[1].result.session_id, made.session_id);
  client.child.stdin.end();
  assert.equal(await client.exit(), 0);
});
