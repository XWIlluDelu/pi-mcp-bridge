// ChatGPT MCP Events uses signed outbound HTTPS, not MCP/SSE notifications.
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import { readBoundedBytes } from '../core/storage.mjs';

export class CallbackError extends Error {
  constructor(reason) {
    super('CallbackEndpointError');
    this.reason = reason;
  }
}
export function callbackUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('INVALID_CALLBACK_URL');
  const url = URL.parse(value);
  if (url?.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('INVALID_CALLBACK_URL');
  return url;
}
export function signingSecret(value) {
  if (typeof value !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error('INVALID_WEBHOOK_SECRET');
  const encoded = value.slice(6),
    bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 24 ||
    bytes.length > 64 ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  )
    throw new Error('INVALID_WEBHOOK_SECRET');
  return value;
}
export function publicAddress(address) {
  try {
    const ip = ipaddr.parse(address);
    // Reject mapped/transition/local/reserved ranges, not just RFC1918.
    return (
      ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3))
    );
  } catch {
    return false;
  }
}
function networkReason(error) {
  if (error instanceof CallbackError) return error.reason;
  if (['AbortError', 'TimeoutError'].includes(error.name)) return 'timeout';
  if (/CERT|TLS|SSL/.test(error.code ?? '')) return 'tls_error';
  return 'connection_refused';
}

// Resolve inside the actual HTTPS connection. Only its first verified address
// can be used, while Host, SNI and certificate checks keep the original name.
function lookupPublic(host, options, done) {
  dns.lookup(host, { all: true }, (error, addresses) => {
    if (error) return done(error);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
      return done(new CallbackError('blocked_address'));
    const [first] = addresses;
    if (options.all) done(null, [first]);
    else done(null, first.address, first.family);
  });
}

export async function postWebhook(urlValue, body, headers, { signal, readBody = false } = {}) {
  const url = callbackUrl(urlValue);
  const deadline = AbortSignal.timeout(10000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let response;
  try {
    signal.throwIfAborted();
    // Node bypasses lookup for IP literals.
    if (isIP(hostname) && !publicAddress(hostname)) throw new CallbackError('blocked_address');
    response = await new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: 'POST',
          agent: false,
          signal,
          lookup: lookupPublic,
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        },
        resolve,
      );
      request.once('error', reject);
      request.end(body);
    });
    const status = response.statusCode;
    if (!readBody || status < 200 || status >= 300) return { status };
    const bytes = await readBoundedBytes(
      response,
      4096,
      () => new CallbackError('response_too_large'),
    );
    return { status, body: bytes.toString('utf8') };
  } catch (error) {
    throw new CallbackError(signal.aborted ? 'timeout' : networkReason(error));
  } finally {
    response?.destroy();
  }
}
export function signedHeaders(subscription, id, body, now = new Date()) {
  const secrets = [subscription.secret];
  if (subscription.previousSecret && subscription.rotateUntil > now.getTime())
    secrets.push(subscription.previousSecret);
  return {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
    'webhook-signature': secrets.map((secret) => new Webhook(secret).sign(id, now, body)).join(' '),
    'X-MCP-Subscription-Id': subscription.id,
  };
}
export async function verifyCallback(subscription, post = postWebhook, signal) {
  const challenge = randomUUID();
  const id = 'verification_' + randomUUID();
  const body = JSON.stringify({ type: 'verification', challenge });
  const response = await post(subscription.url, body, signedHeaders(subscription, id, body), {
    signal,
    readBody: true,
  });
  if (response.status < 200 || response.status >= 300)
    throw new CallbackError(response.status >= 500 ? 'http_5xx' : 'http_4xx');
  let actual;
  try {
    actual = JSON.parse(response.body)?.challenge;
  } catch {}
  if (actual !== challenge) throw new CallbackError('challenge_failed');
}
