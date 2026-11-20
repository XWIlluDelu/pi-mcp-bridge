import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createDiagnostics, diagnosticRef } from '../src/core/diagnostics.mjs';

test('diagnostics isolate concurrent contexts and exclude unapproved fields and errors', async () => {
  const rows = [],
    log = createDiagnostics({ enabled: true, write: (line) => rows.push(JSON.parse(line)) });
  await Promise.all(
    ['a', 'b'].map(async (id) =>
      log.measure('tool', { op: 'send', mcp_id_ref: diagnosticRef(id) }, async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 5 : 1));
        log.emit('fixture', {
          body: 'SECRET_BODY',
          token: 'SECRET_TOKEN',
          code: 'SECRET_ERROR',
          op: { private: 'SECRET_OP', toString: () => 'send' },
          session_ref: { private: 'SECRET_RECORD', toString: () => diagnosticRef(id) },
        });
      }),
    ),
  );
  const starts = rows.filter((r) => r.event === 'tool.start');
  assert.ok(starts.every((r) => r.op === 'send'));
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

test('HTTP, owner IPC and late RPC diagnostics stay private and correlated', async () => {
  const { stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/diagnostics.mjs', import.meta.url))],
    {
      env: { PATH: process.env.PATH, HOME: '/tmp', PI_OFFLINE: '1', PI_MCP_LOG: '1' },
      timeout: 20000,
    },
  );
  assert.doesNotMatch(stderr, /PRIVATE_|whsec_/);
  const rows = stderr.trim().split('\n').map(JSON.parse);
  const read = rows.find((r) => r.event === 'tool.start' && r.op === 'read');
  for (const event of ['permission.check', 'attached.request.end', 'tool.end'])
    assert.ok(
      rows.some((r) => r.event === event && r.trace_id === read.trace_id),
      event,
    );
  assert.ok(rows.some((r) => r.event === 'http.rejected' && r.http_status === 401));
  const timeout = rows.find((r) => r.event === 'rpc.command.end' && r.code === 'ACK_TIMEOUT');
  assert.equal(timeout.uncertain, true);
  assert.equal(timeout.mcp_id_ref, diagnosticRef('PRIVATE_RPC_TIMEOUT'));
  for (const event of ['rpc.late_ack', 'fixture.late_callback'])
    assert.ok(rows.some((r) => r.event === event && r.trace_id === timeout.trace_id));
});
