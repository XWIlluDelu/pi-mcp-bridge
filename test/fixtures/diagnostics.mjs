import assert from 'node:assert/strict';
import { createHttpService } from '../../src/http-server.mjs';
import { TOKEN_HEADER } from '../../src/http-config.mjs';
import { diagnostics, diagnosticRef } from '../../src/diagnostics.mjs';
import { PiRpc } from '../../src/rpc.mjs';
import { nativeOwner } from './native-owner.mjs';

const cleanup = [];
try {
  const f = await nativeOwner(
    { after: (close) => cleanup.push(close) },
    { prefix: 'PRIVATE_PATH' },
  );
  const token = 'PRIVATE_TOKEN_' + 'x'.repeat(32);
  const service = createHttpService(f.bridge, { token });
  f.cleanup.push(() => service.close());
  const url = await service.listen();
  const request = (headers) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'PRIVATE_REQUEST',
        method: 'tools/call',
        params: { name: 'read', arguments: { session_id: f.id } },
      }),
    });
  await f.bridge.pool.resolve(f.session);
  const read = await request({ [TOKEN_HEADER]: token });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).result.structuredContent.session_id, f.id);
  const denied = await request({});
  assert.equal(denied.status, 401);
  await denied.text();

  let command;
  const rpc = new PiRpc(f.config, f.session);
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
      { op: 'send', mcp_id_ref: diagnosticRef('PRIVATE_RPC_TIMEOUT') },
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
  await rpc.drainAcks();
} finally {
  for (const close of cleanup) await close();
}
