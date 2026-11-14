import { nativeOwner } from './fixtures/native-owner.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Webhook } from 'standardwebhooks';
import { Bridge } from '../src/bridge.mjs';
import { EventSubscriptions } from '../src/events.mjs';
import { ownerSocket, ownerRequest } from '../src/owner-runtime.mjs';
import { reserveOwner, updateOwner, releaseOwner } from '../src/attachments.mjs';
import { SettledObserver } from '../src/settled-observer.mjs';
import { READ_CONTRACT } from '../src/context-read.mjs';
import { hash } from '../src/storage.mjs';

import { dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { SessionManager, fauxAssistantMessage } from './fixtures/pi.mjs';

const secret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
const request = (id) => ({
  name: 'session.settled',
  arguments: { session_id: id },
  delivery: { mode: 'webhook', url: 'https://callback.example/chat', secret },
});
async function fixture(t, eventOptions = { retryDelays: [0, 0] }) {
  const f = await nativeOwner(t, {
    prefix: 'events',
    configure({ config }) {
      config.defaults.read = true;
      config.grants = [];
    },
  });
  const { config, session, dir } = f;
  let bridge = f.bridge;
  f.cleanup.push(() => bridge.close());
  let now = Date.now();
  const sent = [];
  let status = 204,
    challengeOK = true;
  const post = async (_url, body, headers) => {
    const decoded = new Webhook(secret).verify(body, headers);
    sent.push({ body, headers, decoded });
    return decoded.type === 'verification'
      ? {
          status: 200,
          body: JSON.stringify({ challenge: challengeOK ? decoded.challenge : 'wrong' }),
        }
      : { status, body: '' };
  };
  const wire = () => {
    bridge.events = new EventSubscriptions(bridge, { post, now: () => now, ...eventOptions });
  };
  wire();
  const call = async (method, params = {}, options) =>
    dispatchModern(
      bridge,
      {
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
        },
      },
      options,
    );
  const settle = async (target = session) => {
    bridge.events.observe(target, {
      timestamp: new Date(now).toISOString(),
      leafId: null,
      aborted: false,
      result: {
        entry_id: 'response',
        text: 'Review [report](./report.md)',
        stop_reason: 'stop',
        truncated: false,
      },
    });
    await Promise.all([...bridge.events.deliveries.keys()]);
  };
  return {
    dir,
    config,
    session,
    sent,
    call,
    settle,
    get bridge() {
      return bridge;
    },
    advance: (ms) => {
      now += ms;
    },
    status: (value) => {
      status = value;
    },
    challenge: (value) => {
      challengeOK = value;
    },
    restart: async () => {
      await bridge.close();
      bridge = await new Bridge(config).init();
      wire();
      await bridge.events.init();
    },
  };
}

// Advance only the retry clock; real authorization and subscription storage still run.
function retryClock(t, fixture) {
  let elapsed = 0;
  const waits = [];
  const timer = t.mock.method(timersPromises, 'setTimeout', async (ms, value, { signal } = {}) => {
    signal?.throwIfAborted();
    waits.push(ms);
    elapsed += ms;
    fixture.advance(ms);
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => {
    timer.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    waits,
    get elapsed() {
      return elapsed;
    },
  };
}

test('event subscriptions verify consent, persist, rotate signing keys and expire', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  assert.equal((await f.call('events/list')).message.result.events[0].name, 'session.settled');
  const subscribe = (params = input) => f.call('events/subscribe', params);
  assert.equal((await subscribe({ ...input, ttlMs: -1 })).message.error.code, -32602);
  f.challenge(false);
  assert.equal((await subscribe()).message.error.code, -32015);
  assert.equal(f.bridge.events.records.size, 0);
  f.challenge(true);

  const { id } = (await subscribe()).message.result;
  const verified = f.sent.length;
  assert.equal((await subscribe()).message.result.id, id);
  assert.equal(f.sent.length, verified, 'reuse receiver consent');
  assert.equal((await fs.stat(f.dir + '/state/event-subscriptions.json')).mode & 0o777, 0o600);
  await f.restart();
  await f.settle();
  assert.equal(f.sent.at(-1).decoded.name, 'session.settled');
  const rotated = {
    ...input,
    delivery: { ...input.delivery, secret: 'whsec_' + Buffer.alloc(24, 1).toString('base64') },
  };
  assert.equal((await subscribe(rotated)).message.result.id, id);
  await f.settle();
  assert.equal(f.sent.at(-1).headers['webhook-signature'].split(' ').length, 2);
  f.advance(3600001);
  const before = f.sent.length;
  await f.settle();
  assert.equal(f.sent.length, before);
});

test('event admission uses receive-time authorization and delivery reauthorizes', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const pending = f.call('events/subscribe', input, {
    execute: async (run) => {
      entered.resolve();
      await release.promise;
      return run();
    },
  });
  await entered.promise;
  f.config.defaults.read = false;
  release.resolve();
  assert.ok((await pending).message.result.id);
  assert.equal((await f.call('events/subscribe', input)).message.error.code, -32024);
  const before = f.sent.length;
  await f.settle();
  assert.equal(f.sent.length, before);
  assert.equal(f.bridge.events.records.size, 0);
});

test('delivery filters sessions and stops on permanent responses or unsubscribe', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  await f.call('events/subscribe', input);
  const other = await savedSession(f.bridge);
  await f.settle(await f.bridge.session(other.session_id));
  assert.equal(f.sent.length, 1);
  for (const status of [410, 302]) {
    f.status(status);
    const before = f.sent.length;
    await f.settle();
    assert.equal(f.sent.length, before + 1);
  }
  const beginning = Promise.withResolvers();
  f.bridge.events.post = (_url, _body, _headers, { signal }) =>
    new Promise((_, reject) => {
      beginning.resolve();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const delivering = f.settle();
  await beginning.promise;
  const { secret: _, ...destination } = input.delivery;
  await f.call('events/unsubscribe', { ...input, delivery: destination });
  await delivering;
  assert.equal(f.bridge.events.deliveries.size, 0);
});

test('default delivery retries exhaust a bounded window and do not replay after receiver recovery or restart', async (t) => {
  const f = await fixture(t, {});
  await f.call('events/subscribe', request(f.session.id));
  const clock = retryClock(t, f),
    attempts = [];
  let status = 503;
  const post = async (_url, body, headers) => {
    attempts.push({ body, headers });
    return { status, body: '' };
  };
  f.bridge.events.post = post;
  await f.settle();
  assert.ok(clock.elapsed >= 300000 && clock.elapsed <= 480000);
  assert.ok(attempts.length > 4 && attempts.length <= 10);
  assert.equal(new Set(attempts.map(({ body }) => body)).size, 1);
  assert.equal(new Set(attempts.map(({ headers }) => headers['webhook-id'])).size, 1);
  assert.equal(attempts[0].headers['webhook-id'], JSON.parse(attempts[0].body).eventId);
  assert.ok(Math.max(...clock.waits) <= 120000);
  assert.equal(f.bridge.events.deliveries.size, 0);
  const exhaustedCount = attempts.length;
  status = 204;
  await f.restart();
  assert.equal(f.bridge.events.records.size, 1);
  assert.equal(attempts.length, exhaustedCount);
  f.bridge.events.post = post;
  await f.settle();
  assert.equal(attempts.length, exhaustedCount + 1);
  assert.notEqual(attempts.at(-1).headers['webhook-id'], attempts[0].headers['webhook-id']);
});

async function projectScope(f) {
  const project = f.dir + '/original',
    replacement = f.dir + '/replacement';
  await Promise.all([fs.mkdir(project), fs.mkdir(replacement)]);
  const { session_id } = await savedSession(f.bridge, { project });
  const session = await f.bridge.session(session_id);
  f.config.defaults = denyAllPermissions();
  f.config.grants = [{ folder: project, read: true }];
  await f.call('events/subscribe', request(session.id));
  const replace = async () => {
    const lines = (await fs.readFile(session.file, 'utf8')).split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: replacement });
    await fs.writeFile(session.file, lines.join('\n'));
    f.config.grants = [{ folder: replacement, read: true }];
  };
  return { project, replacement, session, replace };
}

test('a retry cannot authorize an old occurrence through a replacement native cwd', async (t) => {
  const f = await fixture(t),
    scope = await projectScope(f),
    { session, replacement } = scope;
  const attempts = [];
  f.bridge.events.post = async (_url, body) => {
    attempts.push(JSON.parse(body));
    await scope.replace();
    return { status: 503 };
  };
  await f.settle(session);
  assert.equal((await f.bridge.events.authorize(session.id)).header.cwd, replacement);
  assert.equal(attempts.length, 1, 'new project permission cannot release the old captured result');
  assert.equal(f.bridge.events.deliveries.size, 0);
});

async function settledOwner(f, session) {
  const dir = f.bridge.pool.attachmentDir;
  const claim = await reserveOwner(dir, session, 'extension');
  await updateOwner(dir, session, claim, {
    phase: 'ready',
    readContract: READ_CONTRACT,
    completionSocket: ownerSocket(f.config),
  });
  return {
    observer: new SettledObserver(f.config, claim.generation),
    release: () => releaseOwner(dir, session, claim),
  };
}

test('owner IPC preserves capture identity before the first delivery and ignores native cwd overrides', async (t) => {
  const f = await fixture(t),
    scope = await projectScope(f);
  const { project, replacement, session } = scope;
  const manager = SessionManager.open(session.file, undefined, replacement);
  const { observer, release } = await settledOwner(f, session);
  try {
    assert.equal(manager.getCwd(), replacement);
    assert.equal(manager.getHeader().cwd, project);
    observer.start(manager);
    manager.appendMessage(fauxAssistantMessage('ORIGINAL_RESULT'));
    const first = observer.capture({ aborted: false }, manager);
    assert.equal(first.sessionCwdHash, hash(project));
    const { sessionCwdHash: _, ...missingIdentity } = first;
    for (const invalid of [missingIdentity, { ...missingIdentity, sessionCwd: project }])
      await assert.rejects(ownerRequest(f.config, invalid), /INVALID_OWNER_COMMAND/);
    await ownerRequest(f.config, first);
    for (const replay of [first, { ...first, generation: 'retired' }])
      await assert.rejects(ownerRequest(f.config, replay), /INVALID_OWNER_COMMAND/);
    await Promise.all([...f.bridge.events.deliveries.keys()]);
    assert.equal(f.sent.filter((item) => item.decoded.name === 'session.settled').length, 1);
    assert.equal(f.sent.at(-1).decoded.data.result.text, 'ORIGINAL_RESULT');

    observer.start(manager);
    manager.appendMessage(fauxAssistantMessage('OLD_PROJECT_CAPTURED_RESULT'));
    const captured = observer.capture({ aborted: false }, manager);
    await scope.replace();
    await assert.rejects(ownerRequest(f.config, captured), /INVALID_OWNER_COMMAND/);
    assert.equal(f.bridge.completionSequences.get(session.id).sequence, first.sequence);
  } finally {
    await release();
  }
});

for (const invalid of ['active record', 'file privacy'])
  test(`an invalid subscription ${invalid} disables only events until owner repair and restart`, async (t) => {
    const f = await fixture(t),
      input = request(f.session.id),
      file = f.dir + '/state/event-subscriptions.json';
    await f.call('events/subscribe', input);
    const active = [...f.bridge.events.records.values()][0],
      url = 'https://callback.example/other',
      broken = {
        ...active,
        url,
        id: 'sub_' + hash(['owner', url, 'session.settled', { session_id: f.session.id }]),
        obsoleteMetadata: 'private-value',
      },
      raw = JSON.stringify(invalid === 'active record' ? [active, broken] : [active]),
      reason =
        invalid === 'active record'
          ? 'INVALID_EVENT_SUBSCRIPTIONS'
          : 'EVENT_SUBSCRIPTIONS_NOT_PRIVATE';
    await fs.writeFile(file, raw);
    if (invalid === 'file privacy') await fs.chmod(file, 0o644);
    await f.restart();
    assert.equal(f.bridge.events.records.size, 0, 'Never activate a partial store');
    const health = await f.bridge.health();
    assert.deepEqual(health.events, { status: 'unavailable', reason });
    assert.doesNotMatch(JSON.stringify(health), /whsec_|callback\.example/);
    assert.equal((await f.bridge.read({ session_id: f.session.id })).session_id, f.session.id);
    assert.equal((await f.call('events/subscribe', input)).message.error.data.reason, reason);
    const before = f.sent.length;
    await f.settle();
    assert.equal(f.sent.length, before);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    await fs.writeFile(file, JSON.stringify([active]));
    await fs.chmod(file, 0o600);
    await f.restart();
    assert.equal((await f.bridge.health()).events, undefined);
    assert.equal(f.bridge.events.records.size, 1);
    await f.settle();
    assert.equal(f.sent.length, before + 1);
  });
