import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { toolNames } from '../src/protocol.mjs';
import { createDiagnostics, diagnosticRef } from '../src/diagnostics.mjs';

test('attached state diagnostics retain built-in failures but suppress unknown strings', async () => {
  const rows = [],
    log = createDiagnostics({ enabled: true, write: (line) => rows.push(JSON.parse(line)) });
  for (const code of [
    'INVALID_ATTACHMENT_RECORD',
    'INVALID_ATTACHMENT_RESPONSE',
    'PROCESS_IDENTITY_UNAVAILABLE',
  ]) {
    await assert.rejects(
      log.measure('attached.request', { op: 'state' }, () => {
        throw Object.assign(new Error('PRIVATE_MESSAGE'), { code });
      }),
      { code },
    );
    const end = rows.at(-1);
    assert.equal(end.op, 'state');
    assert.equal(end.code, code);
    assert.equal(end.status, 'error');
  }
  log.emit('attached.request.end', {
    op: 'PRIVATE_OPERATION',
    code: 'PRIVATE_CODE',
    message: 'PRIVATE_MESSAGE',
  });
  assert.equal(rows.at(-1).code, 'OTHER_ERROR');
  assert.equal(rows.at(-1).op, undefined);
  assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false);
});

test('native control operations and refusal codes remain identifiable without logging content', async () => {
  const rows = [],
    log = createDiagnostics({ enabled: true, write: (line) => rows.push(JSON.parse(line)) });
  const refusals = {
    stop: 'STOP_IN_PROGRESS',
    bash: 'BASH_UNSUPPORTED',
    models: 'MODELS_UNSUPPORTED',
    set_model: 'THINKING_LEVEL_UNSUPPORTED',
    compact: 'COMPACT_BUSY',
    reload: 'RELOAD_IDLE_UNCONFIRMED',
  };
  for (const op of toolNames) {
    log.emit('tool.start', { op });
    assert.equal(rows.at(-1).op, op);
  }
  for (const [op, reason] of Object.entries(refusals)) {
    await log.measure('tool', { op }, () => ({ status: 'rejected', reason }));
    assert.equal(rows.at(-1).op, op);
    assert.equal(rows.at(-1).code, reason);
  }
  for (const op of ['command', 'abort', 'abort_bash', 'clear_queue']) {
    log.emit('permission.check', {
      op,
      allowed: false,
      text: 'PRIVATE_PROMPT',
      command: 'PRIVATE_COMMAND',
      output: 'PRIVATE_OUTPUT',
    });
    assert.equal(rows.at(-1).op, op);
  }
  log.emit('rpc.command.end', { op: 'PRIVATE_OPERATION', code: 'PRIVATE_ERROR' });
  assert.equal(rows.at(-1).op, undefined);
  assert.equal(rows.at(-1).code, 'OTHER_ERROR');
  assert.equal(JSON.stringify(rows).includes('PRIVATE_'), false);
});

test('diagnostics isolate concurrent contexts and exclude unapproved fields and errors', async () => {
  const rows = [],
    log = createDiagnostics({ enabled: true, write: (line) => rows.push(JSON.parse(line)) });
  await Promise.all(
    ['a', 'b'].map(async (id) =>
      log.measure('tool', { op: 'read', mutation_ref: diagnosticRef(id) }, async () => {
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
  for (const start of starts)
    assert.equal(
      rows.find((r) => r.event === 'tool.end' && r.trace_id === start.trace_id).mutation_ref,
      start.mutation_ref,
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

test('enabled HTTP, RPC, replay and timeout diagnostics remain private and correlated', async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/diagnostics.mjs', import.meta.url))],
    {
      env: { PATH: process.env.PATH, HOME: '/tmp', PI_OFFLINE: '1', PI_MCP_LOG: '1' },
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.deepEqual(JSON.parse(stdout), { ok: true });
  assert.equal(/PRIVATE_(TOKEN|BODY|PATH|RPC_ID|MUTATION)/.test(stderr), false);
  const rows = stderr.trim().split('\n').map(JSON.parse);
  const started = rows.find((r) => r.event === 'tool.start' && r.op === 'read');
  assert.ok(started);
  const related = rows.filter((r) => r.trace_id === started.trace_id);
  for (const event of [
    'permission.reload.end',
    'permission.check',
    'read.source',
    'rpc.command.end',
    'tool.end',
  ])
    assert.ok(
      related.some((r) => r.event === event),
      event,
    );
  assert.ok(rows.some((r) => r.event === 'session.discover.end')); // Initial cold lookup.
  assert.equal(
    related.some((r) => r.event === 'session.discover.end'),
    false,
  ); // Warm read revalidates one file.
  assert.ok(rows.some((r) => r.event === 'http.closed' && r.response_finished === true));
  assert.ok(rows.some((r) => r.event === 'http.rejected' && r.http_status === 401));
  assert.ok(rows.some((r) => r.event === 'runtime.spawned'));
  assert.ok(rows.some((r) => r.event === 'runtime.exited'));
  const replay = rows.find((r) => r.event === 'receipt.replay' && r.status === 'accepted'),
    saved = rows.find((r) => r.event === 'receipt.saved' && r.status === 'accepted');
  assert.equal(replay.mutation_ref, saved.mutation_ref);
  assert.notEqual(replay.trace_id, saved.trace_id);
  const timeout = rows.find((r) => r.event === 'rpc.command.end' && r.code === 'ACK_TIMEOUT');
  assert.equal(timeout.uncertain, true);
  const late = rows.find((r) => r.event === 'rpc.late_ack');
  assert.equal(late.trace_id, timeout.trace_id);
  assert.equal(late.mutation_ref, timeout.mutation_ref);
  assert.equal(rows.find((r) => r.event === 'fixture.late_callback').trace_id, timeout.trace_id);
  assert.ok(rows.filter((r) => r.duration_ms !== undefined).every((r) => r.duration_ms >= 0));
});
