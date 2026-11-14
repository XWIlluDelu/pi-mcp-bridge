import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createDiagnostics, diagnosticRef } from '../src/diagnostics.mjs';

test('diagnostics isolate concurrent contexts and exclude unapproved fields and errors', async () => {
  const rows = [],
    log = createDiagnostics({ enabled: true, write: (line) => rows.push(JSON.parse(line)) });
  await Promise.all(
    ['a', 'b'].map(async (id) =>
      log.measure('tool', { op: 'read', mcp_id_ref: diagnosticRef(id) }, async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 5 : 1));
        log.emit('fixture', {
          body: 'SECRET_BODY',
          token: 'SECRET_TOKEN',
          code: 'SECRET_ERROR',
          op: 'SECRET_OP',
        });
      }),
    ),
  );
  const starts = rows.filter((r) => r.event === 'tool.start');
  assert.equal(new Set(starts.map((r) => r.trace_id)).size, 2);
  assert.equal(new Set(starts.map((r) => r.mcp_id_ref)).size, 2);
  for (const start of starts)
    assert.equal(
      rows.find((r) => r.event === 'tool.end' && r.trace_id === start.trace_id).mcp_id_ref,
      start.mcp_id_ref,
    );
  assert.equal(JSON.stringify(rows).includes('SECRET'), false);
  assert.ok(rows.filter((r) => r.event === 'fixture').every((r) => r.code === 'OTHER_ERROR'));
});

test('disabled or failed diagnostic sinks cannot change operation outcomes', async () => {
  const disabled = createDiagnostics({
    write: () => {
      throw new Error('must not write');
    },
  });
  assert.equal(await disabled.measure('tool', {}, () => 42), 42);
  const broken = createDiagnostics({
    enabled: true,
    write: () => {
      throw new Error('broken collector');
    },
  });
  assert.equal(await broken.measure('tool', {}, () => 42), 42);
  const original = new Error('private failure');
  await assert.rejects(
    broken.measure('tool', {}, () => {
      throw original;
    }),
    (error) => error === original,
  );
});

test('enabled HTTP, RPC and timeout diagnostics remain private and correlated', async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/diagnostics.mjs', import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        HOME: '/tmp',
        PI_OFFLINE: '1',
        PI_MCP_LOG: '1',
        PI_MCP_LOG_CALLBACK_HOST: '1',
      },
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.deepEqual(JSON.parse(stdout), { ok: true });
  assert.equal(stderr.includes('PRIVATE_'), false);
  const rows = stderr.trim().split('\n').map(JSON.parse);
  const started = rows.find((r) => r.event === 'tool.start' && r.op === 'read');
  assert.ok(started);
  const related = rows.filter((r) => r.trace_id === started.trace_id);
  for (const event of [
    'permission.snapshot.end',
    'permission.check',
    'read.source',
    'attached.request.end',
    'tool.end',
  ])
    assert.ok(
      related.some((r) => r.event === event),
      event,
    );
  assert.ok(related.some((r) => r.event === 'attached.request.end' && r.op === 'read'));
  assert.ok(rows.some((r) => r.event === 'session.discover.end')); // Initial cold lookup.
  assert.equal(
    related.some((r) => r.event === 'session.discover.end'),
    false,
  ); // Warm read revalidates one file.
  for (const [code, reason] of [
    [-32015, 'challenge_failed'],
    [-32020, undefined],
  ]) {
    const response = rows.find((r) => r.event === 'http.rpc_response' && r.rpc_code === code);
    assert.ok(response);
    assert.equal(response.http_status, 400);
    assert.equal(response.rpc_status, 'error');
    assert.equal(response.callback_reason, reason);
    assert.ok(
      rows.some(
        (r) =>
          r.trace_id === response.trace_id &&
          r.event === 'http.request' &&
          r.method === 'events/subscribe',
      ),
    );
  }
  const callback = rows.find((r) => r.event === 'events.callback_target');
  assert.equal(callback.callback_hostname, 'callback.example');
  assert.ok(rows.some((r) => r.trace_id === callback.trace_id && r.rpc_code === -32015));
  assert.equal(stderr.includes('whsec_'), false);
  const eventList = rows.find((r) => r.event === 'http.request' && r.method === 'events/list');
  assert.ok(
    rows.some(
      (r) =>
        r.trace_id === eventList.trace_id &&
        r.event === 'http.rpc_response' &&
        r.http_status === 200 &&
        r.rpc_status === 'result',
    ),
  );
  assert.ok(rows.some((r) => r.event === 'http.closed' && r.response_finished === true));
  assert.ok(rows.some((r) => r.event === 'http.rejected' && r.http_status === 401));
  assert.ok(rows.some((r) => r.event === 'runtime.spawned'));
  assert.ok(rows.some((r) => r.event === 'runtime.exited'));
  const timeout = rows.find((r) => r.event === 'rpc.command.end' && r.code === 'ACK_TIMEOUT');
  assert.equal(timeout.uncertain, true);
  const late = rows.find((r) => r.event === 'rpc.late_ack');
  assert.equal(late.trace_id, timeout.trace_id);
  assert.equal(timeout.mcp_id_ref, diagnosticRef('PRIVATE_RPC_TIMEOUT'));
  assert.equal(late.mcp_id_ref, timeout.mcp_id_ref);
  assert.equal(rows.find((r) => r.event === 'fixture.late_callback').trace_id, timeout.trace_id);
  assert.ok(rows.filter((r) => r.duration_ms !== undefined).every((r) => r.duration_ms >= 0));
});
