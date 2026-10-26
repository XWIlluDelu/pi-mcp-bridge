import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Webhook } from 'standardwebhooks';
import { Bridge } from '../src/bridge.mjs';
import { EventSubscriptions } from '../src/events.mjs';
import { ownerSocket } from '../src/owner-runtime.mjs';
import { READ_CONTRACT } from '../src/context-read.mjs';
import { hash } from '../src/storage.mjs';
import { CallbackError } from '../src/event-webhook.mjs';
import { dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const secret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
const request = (id, delivery = {}) => ({
  name: 'session.settled',
  arguments: { session_id: id },
  delivery: { mode: 'webhook', url: 'https://callback.example/chat', secret, ...delivery },
});
async function fixture(t, eventOptions = { retryDelays: [0, 0] }) {
  const dir = await fs.mkdtemp('/tmp/bridge-events-');
  const config = {
    stateDir: dir + '/state',
    sessionRoots: [dir + '/sessions'],
    folders: [{ path: dir }],
    defaults: { ...denyAllPermissions(), read: true },
  };
  let bridge = await new Bridge(config).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const made = await savedSession(bridge);
  const session = await bridge.session(made.session_id);
  let now = Date.now();
  const sent = [];
  let status = 204,
    challengeOK = true;
  const post = async (url, body, headers) => {
    const decoded = new Webhook(secret).verify(body, headers);
    sent.push({ url, body, headers, decoded });
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
    badChallenge: () => {
      challengeOK = false;
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

test('event protocol discovers, validates, verifies and durably refreshes a single-owner subscription', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  assert.deepEqual((await f.call('server/discover')).message.result.capabilities.events, {});
  assert.equal((await f.call('events/list')).message.result.events[0].name, 'session.settled');
  for (const bad of [
    { ...input, arguments: { session_id: f.session.id, project: '/ignored' } },
    { ...input, delivery: { ...input.delivery, url: 'http://callback.example' } },
    { ...input, ttlMs: -1 },
  ])
    assert.equal((await f.call('events/subscribe', bad)).message.error.code, -32602);
  assert.equal(f.sent.length, 0);
  f.badChallenge();
  assert.equal((await f.call('events/subscribe', input)).message.error.code, -32015);
  assert.equal(f.bridge.events.records.size, 0);
  // Use a second fixture to keep the unsuccessful receiver separate.
  const good = await fixture(t),
    params = request(good.session.id);
  const first = (await good.call('events/subscribe', params)).message.result;
  assert.equal(first.cursor, null);
  assert.equal(first.truncated, false);
  assert.equal(good.sent.length, 1);
  assert.equal(good.bridge.pool.instances.size, 0, 'subscribing must not start Pi');
  const repeated = (await good.call('events/subscribe', params)).message.result;
  assert.equal(repeated.id, first.id);
  assert.equal(good.sent.length, 1, 'callback consent is cached');
  const file = good.dir + '/state/event-subscriptions.json';
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await good.restart();
  assert.equal(good.bridge.events.records.size, 1);
  await good.settle();
  assert.equal(good.sent.at(-1).decoded.name, 'session.settled');
  const rotated = {
    ...params,
    delivery: { ...params.delivery, secret: 'whsec_' + Buffer.alloc(24, 1).toString('base64') },
  };
  assert.equal((await good.call('events/subscribe', rotated)).message.result.id, first.id);
  assert.equal(good.bridge.events.records.get(first.id).previousSecret, secret);
  // The original receiver can still verify the old-key signature during rotation.
  await good.settle();
  assert.equal(good.sent.at(-1).headers['webhook-signature'].split(' ').length, 2);
  good.advance(3600001);
  const before = good.sent.length;
  await good.settle();
  assert.equal(good.sent.length, before, 'expiration prevents delivery');
  // Verification cache expired; verify with the proposed replacement key.
  good.bridge.events.post = async (_url, body, headers) => {
    const decoded = new Webhook(rotated.delivery.secret).verify(body, headers);
    return { status: 200, body: JSON.stringify({ challenge: decoded.challenge }) };
  };
  assert.equal((await good.call('events/subscribe', rotated)).message.result.id, first.id);
  const stop = { ...params, delivery: { mode: 'webhook', url: params.delivery.url } };
  await good.call('events/unsubscribe', stop);
  await good.call('events/unsubscribe', stop);
  assert.equal(good.bridge.events.records.size, 0);
});

test('event discovery and subscriptions retain receive-time policy through executor waits', async (t) => {
  for (const method of ['events/list', 'events/subscribe'])
    for (const allowed of [true, false])
      await t.test(`${method}, initially ${allowed ? 'allowed' : 'denied'}`, async (t) => {
        const f = await fixture(t),
          input = method === 'events/list' ? {} : request(f.session.id),
          entered = Promise.withResolvers(),
          release = Promise.withResolvers(),
          capture = t.mock.method(f.bridge, 'captureRequestContext');
        f.config.defaults.read = allowed;
        const pending = f.call(method, input, {
          execute: async (run) => {
            entered.resolve();
            await release.promise;
            return run();
          },
        });
        await entered.promise;
        f.config.defaults.read = !allowed;
        release.resolve();
        const response = await pending;
        assert.equal(capture.mock.callCount(), 1);
        const isAllowed = (value) =>
          method === 'events/list'
            ? value.message.result.events.length === 1
            : value.message.result?.id !== undefined;
        assert.equal(isAllowed(response), allowed, JSON.stringify(response));
        assert.equal(isAllowed(await f.call(method, input)), !allowed);
        if (method === 'events/subscribe' && allowed) {
          const before = f.sent.length;
          await f.settle();
          assert.equal(f.sent.length, before, 'Delivery uses fresh authorization, not admission');
          assert.equal(f.bridge.events.records.size, 0);
        }
      });
});

test('delivery filters, retries exact occurrences, and stops on permanent responses, unsubscribe or revoked read access', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  await f.call('events/subscribe', input);
  const other = await savedSession(f.bridge);
  await f.settle(await f.bridge.session(other.session_id));
  assert.equal(f.sent.length, 1);
  f.status(503);
  await f.settle();
  const attempts = f.sent.slice(1);
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((x) => x.decoded.eventId)).size, 1);
  assert.equal(new Set(attempts.map((x) => x.body)).size, 1);
  assert.ok(attempts.every((x) => x.headers['webhook-id'] === x.decoded.eventId));
  for (const status of [410, 413, 302]) {
    f.status(status);
    const before = f.sent.length;
    await f.settle();
    assert.equal(f.sent.length, before + 1);
  }
  f.config.defaults.read = false;
  const before = f.sent.length;
  await f.settle();
  assert.equal(f.sent.length, before);
  assert.equal(f.bridge.events.records.size, 0);
  assert.equal((await f.call('events/subscribe', input)).message.error.code, -32024);
  assert.deepEqual((await f.call('events/list')).message.result.events, []);
  f.config.defaults.read = true;
  await f.call('events/subscribe', input);
  let started;
  const beginning = new Promise((resolve) => {
    started = resolve;
  });
  f.bridge.events.post = (_url, _body, _headers, { signal }) =>
    new Promise((_, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const delivering = f.settle();
  await beginning;
  const { secret: _, ...destination } = input.delivery;
  await f.call('events/unsubscribe', { ...input, delivery: destination });
  await delivering;
  assert.equal(f.bridge.events.deliveries.size, 0);
});

test('default delivery retries recover after a five-minute callback outage without changing the occurrence', async (t) => {
  const f = await fixture(t, {});
  await f.call('events/subscribe', request(f.session.id));
  const clock = retryClock(t, f),
    attempts = [],
    accepted = [];
  f.bridge.events.post = async (_url, body, headers) => {
    attempts.push({ body, headers });
    if (clock.elapsed < 300000) {
      if (attempts.length % 2 === 0) throw new CallbackError('timeout');
      return { status: 503, body: '' };
    }
    accepted.push(JSON.parse(body));
    return { status: 204, body: '' };
  };
  await f.settle();
  assert.equal(accepted.length, 1);
  assert.ok(clock.elapsed >= 300000 && clock.elapsed <= 480000);
  assert.ok(attempts.length > 4 && attempts.length <= 10);
  assert.ok(Math.max(...clock.waits) <= 120000);
  assert.equal(new Set(attempts.map((x) => x.body)).size, 1);
  assert.ok(attempts.every((x) => x.headers['webhook-id'] === accepted[0].eventId));
  assert.ok(
    Number(attempts.at(-1).headers['webhook-timestamp']) -
      Number(attempts[0].headers['webhook-timestamp']) >=
      300,
  );
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
  assert.ok(Math.max(...clock.waits) <= 120000);
  assert.equal(f.bridge.events.deliveries.size, 0);
  const exhaustedCount = attempts.length;
  status = 204;
  await f.restart();
  assert.equal(f.bridge.events.records.size, 1);
  assert.equal(f.bridge.events.deliveries.size, 0);
  assert.equal(attempts.length, exhaustedCount);
  f.bridge.events.post = post;
  await f.settle();
  assert.equal(attempts.length, exhaustedCount + 1);
  assert.notEqual(attempts.at(-1).headers['webhook-id'], attempts[0].headers['webhook-id']);
});

test('project-authorized subscriptions survive workspace cleanup but not permission revocation', async (t) => {
  const f = await fixture(t),
    project = f.dir + '/workspace';
  await fs.mkdir(project);
  const made = await savedSession(f.bridge, { project }),
    session = await f.bridge.session(made.session_id);
  f.config.defaults = denyAllPermissions();
  f.config.grants = [{ folder: project, list: true, read: true }];
  await f.call('events/subscribe', request(session.id));
  assert.equal(f.bridge.events.records.size, 1);
  await fs.rmdir(project);
  await f.settle(session);
  assert.equal(f.sent.at(-1).decoded.data.session_id, session.id);
  assert.equal(f.bridge.events.records.size, 1);
  const before = f.sent.length;
  f.config.grants[0].read = false;
  await f.settle(session);
  assert.equal(f.sent.length, before);
  assert.equal(f.bridge.events.records.size, 0);
});

test('a retry cannot authorize an old occurrence through a replacement native cwd', async (t) => {
  const f = await fixture(t),
    project = f.dir + '/original',
    replacement = f.dir + '/replacement';
  await fs.mkdir(project);
  await fs.mkdir(replacement);
  const made = await savedSession(f.bridge, { project }),
    session = await f.bridge.session(made.session_id);
  f.config.defaults = denyAllPermissions();
  f.config.grants = [{ folder: project, read: true }];
  await f.call('events/subscribe', request(session.id));
  const attempts = [];
  f.bridge.events.post = async (_url, body) => {
    attempts.push(JSON.parse(body));
    const lines = (await fs.readFile(session.file, 'utf8')).trimEnd().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: replacement });
    await fs.writeFile(session.file, lines.join('\n') + '\n');
    f.config.grants = [{ folder: replacement, read: true }];
    return { status: 503 };
  };
  await f.settle(session);
  assert.equal((await f.bridge.events.authorize(session.id)).header.cwd, replacement);
  const context = await f.bridge.captureRequestContext();
  assert.throws(() => f.bridge.check('read', session, context), /NOT_FOUND_OR_DENIED/);
  assert.equal(attempts.length, 1, 'new project permission cannot release the old captured result');
  assert.equal(attempts[0].data.result.text, 'Review [report](./report.md)');
  assert.equal(f.bridge.events.deliveries.size, 0);
});

test('expired subscription records are pruned before loading active subscriptions', async (t) => {
  const f = await fixture(t);
  await f.call('events/subscribe', request(f.session.id));
  const active = [...f.bridge.events.records.values()][0],
    expired = {
      ...active,
      expiresAt: f.bridge.events.now() - 1,
    },
    raw = JSON.stringify([expired, active]),
    file = f.dir + '/state/event-subscriptions.json';
  await fs.writeFile(file, raw);
  await f.restart();
  assert.deepEqual(f.bridge.events.health(), { status: 'ok' });
  assert.equal(f.bridge.events.records.size, 1);
  await f.settle();
  assert.equal(f.sent.at(-1).decoded.name, 'session.settled');
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
    assert.ok(!JSON.stringify(health).includes(secret));
    assert.ok(!JSON.stringify(health).includes(url));
    assert.deepEqual((await f.bridge.read({ session_id: f.session.id })).items, []);
    assert.equal((await f.call('tools/list')).status, 200);
    const { secret: _, ...delivery } = input.delivery;
    for (const [method, params] of [
      ['events/list', {}],
      ['events/subscribe', input],
      ['events/unsubscribe', { ...input, delivery }],
    ]) {
      const response = await f.call(method, params);
      assert.equal(response.status, 500);
      assert.deepEqual(response.message.error, {
        code: -32603,
        message: 'EventSubscriptionsUnavailable',
        data: { reason },
      });
    }
    const before = f.sent.length;
    await f.settle();
    assert.equal(f.sent.length, before);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    if (invalid === 'file privacy') assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
    await fs.writeFile(file, JSON.stringify([active]));
    await fs.chmod(file, 0o600);
    await f.restart();
    assert.equal((await f.bridge.health()).events, undefined);
    assert.equal(f.bridge.events.records.size, 1);
    await f.settle();
    assert.equal(f.sent.length, before + 1);
  });

test('unsupported replay and external owners without this Bridge event capability are explicit', async (t) => {
  const f = await fixture(t),
    input = request(f.session.id);
  assert.equal(
    (await f.call('events/subscribe', { ...input, cursor: 'old' })).message.error.code,
    -32026,
  );
  const companion = {
    kind: 'tui',
    readContract: READ_CONTRACT,
    completionSocket: ownerSocket(f.config),
  };
  for (const record of [
    { ...companion, kind: 'host' },
    { ...companion, completionSocket: undefined },
    { ...companion, completionSocket: ownerSocket({ ...f.config, stateDir: f.dir + '/other' }) },
  ]) {
    t.mock.method(f.bridge.pool, 'forRead', async () => ({ attached: true, record }));
    const response = await f.call('events/subscribe', input);
    assert.equal(response.message.error.code, -32026);
    assert.equal(response.message.error.data.feature, 'externalOwner');
  }
  assert.equal(f.sent.length, 0);
});
