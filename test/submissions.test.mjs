import test from 'node:test';
import assert from 'node:assert/strict';
import { Submissions } from '../src/submissions.mjs';

test('submission observations have independent identities and retain only admission metadata', () => {
  let time = Date.parse('2026-10-24T00:00:00Z');
  const submissions = new Submissions({ now: () => time });
  const first = submissions.start('session-a', 'send');
  const second = submissions.start('session-a', 'send');
  assert.notEqual(first, second);
  assert.equal(submissions.get('session-a', first).receipt.status, 'pending');
  time += 10;
  const value = {
    status: 'dispatched',
    admission: 'unobservable',
    text: 'PRIVATE_INPUT',
    images: ['PRIVATE_IMAGE'],
    output: 'PRIVATE_OUTPUT',
  };
  submissions.update(first, value);
  const record = submissions.get('session-a', first);
  assert.deepEqual(record.receipt, { status: 'dispatched', admission: 'unobservable' });
  assert.equal(record.operation, 'send');
  assert.equal(record.submitted_at, '2026-10-24T00:00:00.000Z');
  assert.equal(record.updated_at, '2026-10-24T00:00:00.010Z');
  assert.equal(JSON.stringify(record).includes('PRIVATE_'), false);
  record.receipt.status = 'modified-by-caller';
  assert.equal(submissions.get('session-a', first).receipt.status, 'dispatched');
  assert.equal(submissions.get('session-a', second).receipt.status, 'pending');
  assert.throws(() => submissions.get('session-b', first), /SUBMISSION_UNAVAILABLE/);
});

test('a late native acknowledgement survives an earlier unknown result unwinding afterwards', () => {
  for (const status of ['started', 'queued', 'handled', 'rejected']) {
    const submissions = new Submissions();
    const id = submissions.start('session-a', 'send');
    submissions.update(id, { status: 'unknown', reason: 'ACK_TIMEOUT' });
    const receipt = {
      status,
      ...(status === 'rejected' ? { reason: 'PI_REJECTED' } : {}),
    };
    submissions.update(id, receipt);
    assert.deepEqual(submissions.update(id, { status: 'unknown', reason: 'ACK_TIMEOUT' }), receipt);
    assert.deepEqual(submissions.get('session-a', id).receipt, receipt);
  }
});

test('expired observations remain unavailable even when a late acknowledgement arrives', () => {
  let time = 0;
  const submissions = new Submissions({ now: () => time, ttl: 100 });
  const id = submissions.start('session-a', 'create');
  time = 99;
  submissions.update(id, { status: 'unknown', reason: 'ACK_TIMEOUT' });
  assert.equal(submissions.get('session-a', id).expires_at, '1970-01-01T00:00:00.100Z');
  time = 100;
  assert.throws(() => submissions.get('session-a', id), /SUBMISSION_UNAVAILABLE/);
  assert.equal(submissions.update(id, { status: 'started' }), null);
  assert.equal(submissions.records.size, 0);
});

test('bounded observation eviction does not recreate records or infer refusal', () => {
  const submissions = new Submissions({ limit: 2 });
  const first = submissions.start('session-a', 'send');
  const second = submissions.start('session-b', 'send');
  submissions.update(first, { status: 'unknown', reason: 'ACK_TIMEOUT' });
  const third = submissions.start('session-a', 'send');
  assert.equal(submissions.records.size, 2);
  assert.throws(() => submissions.get('session-a', first), /SUBMISSION_UNAVAILABLE/);
  assert.equal(submissions.update(first, { status: 'handled' }), null);
  assert.equal(submissions.get('session-b', second).receipt.status, 'pending');
  assert.equal(submissions.get('session-a', third).receipt.status, 'pending');
});
