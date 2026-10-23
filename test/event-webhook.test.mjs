import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import {
  callbackUrl,
  signingSecret,
  publicAddress,
  postWebhook,
  signedHeaders,
  verifyCallback,
} from '../src/event-webhook.mjs';

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
function callbackReceiver(t, respond) {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(https, 'request', (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.end = (body) => {
      const response = respond(body);
      queueMicrotask(() => onResponse(response));
    };
    return request;
  });
}
test('Standard Webhooks signs exact bytes and both rotation keys; challenge must be echoed', async () => {
  const subscription = {
    id: 'sub_test',
    url: 'https://callback.example/event',
    secret,
    previousSecret: 'whsec_' + Buffer.alloc(24, 8).toString('base64'),
    rotateUntil: Date.now() + 60000,
  };
  const now = new Date(),
    body = '{"eventId":"evt_test","data":{"text":"你好"}}';
  const headers = signedHeaders(subscription, 'evt_test', body, now);
  const signed = 'evt_test.' + Math.floor(now.getTime() / 1000) + '.' + body;
  const signatures = [secret, subscription.previousSecret].map(
    (key) =>
      'v1,' +
      createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
        .update(signed)
        .digest('base64'),
  );
  assert.equal(headers['webhook-signature'], signatures.join(' '));
  assert.equal(headers['webhook-id'], 'evt_test');
  assert.equal(headers['X-MCP-Subscription-Id'], subscription.id);
  assert.equal(
    signedHeaders(subscription, 'evt_test', body, new Date(subscription.rotateUntil + 1))[
      'webhook-signature'
    ].split(' ').length,
    1,
  );
  await verifyCallback(subscription, async (_url, sent, h) => {
    const parsed = JSON.parse(sent);
    assert.equal(parsed.type, 'verification');
    assert.ok(h['webhook-id'].startsWith('verification_'));
    return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  });
  await assert.rejects(
    verifyCallback(subscription, async () => ({ status: 200, body: '{"challenge":"wrong"}' })),
    (e) => e.reason === 'challenge_failed',
  );
  await assert.rejects(
    verifyCallback(subscription, async () => ({ status: 302, body: '' })),
    (e) => e.reason === 'http_4xx',
  );
});

test('notification status is preserved without waiting for oversized unfinished response bodies', async (t) => {
  let status, response;
  callbackReceiver(t, () => {
    response = new PassThrough();
    response.statusCode = status;
    response.write(Buffer.alloc(8192));
    return response; // No EOF: delivery does not depend on reading the body.
  });
  for (status of [200, 410, 413]) {
    assert.deepEqual(await postWebhook('https://callback.example/event', '{}', {}), { status });
    assert.equal(response.destroyed, true);
  }
});

test('callback verification reads its challenge but bounds the successful response body', async (t) => {
  let oversized = false;
  callbackReceiver(t, (body) => {
    const { challenge } = JSON.parse(body),
      response = Readable.from([
        Buffer.from(
          JSON.stringify({
            challenge,
            ...(oversized ? { padding: 'x'.repeat(4096) } : {}),
          }),
        ),
      ]);
    response.statusCode = 200;
    return response;
  });
  const subscription = { id: 'sub_test', url: 'https://callback.example/event', secret };
  await verifyCallback(subscription);
  oversized = true;
  await assert.rejects(
    verifyCallback(subscription),
    (error) => error.reason === 'response_too_large',
  );
});

test('callback inputs and address policy reject nonpublic destinations, including mapped/transition IPv6', async () => {
  for (const value of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/#secret',
  ])
    assert.throws(() => callbackUrl(value));
  for (const value of ['x', 'whsec_YQ==', 'whsec_' + Buffer.alloc(65).toString('base64')])
    assert.throws(() => signingSecret(value));
  assert.equal(signingSecret(secret), secret);
  for (const value of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:0808:0808::1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(publicAddress(value), true, value);
  await assert.rejects(
    postWebhook('https://127.0.0.1/event', '{}', {}),
    (e) => e.reason === 'blocked_address',
  );
});

test('every HTTPS connection resolves again, pins a public address, preserves TLS hostname, and never follows redirects', async (t) => {
  let lookups = 0,
    requests = 0;
  t.mock.method(dns, 'lookup', async () => [
    { address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
  ]);
  t.mock.method(https, 'request', (url, options, onResponse) => {
    requests++;
    assert.equal(url.hostname, 'callback.example');
    assert.equal(options.agent, false);
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const req = new EventEmitter();
    req.end = (body) => {
      assert.equal(body, '{}');
      const response = Readable.from([Buffer.from('redirect')]);
      response.statusCode = 302;
      response.headers = { location: 'https://127.0.0.1/private' };
      queueMicrotask(() => onResponse(response));
    };
    return req;
  });
  assert.equal((await postWebhook('https://callback.example/event', '{}', {})).status, 302);
  await assert.rejects(
    postWebhook('https://callback.example/event', '{}', {}),
    (e) => e.reason === 'blocked_address',
  );
  assert.equal(lookups, 2);
  assert.equal(requests, 1);
});
