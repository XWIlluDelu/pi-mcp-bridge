// ChatGPT MCP Events uses signed outbound HTTPS, not MCP/SSE notifications.
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export class CallbackError extends Error {
  constructor(reason) {
    super('CallbackEndpointError');
    this.reason = reason;
  }
}
export function callbackUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('INVALID_CALLBACK_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_CALLBACK_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
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

// Fresh resolution for EVERY connection; pin that resolution in lookup while
// keeping the URL hostname for Host/SNI/certificate checks. No proxy or redirect.
export async function postWebhook(urlValue, body, headers, { signal, readBody = false } = {}) {
  const url = callbackUrl(urlValue);
  const deadline = AbortSignal.timeout(10000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let abort;
  try {
    signal.throwIfAborted();
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
          dns.lookup(hostname, { all: true }),
          new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
          }),
        ]);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
      throw new CallbackError('blocked_address');
    signal.throwIfAborted();
    const address = addresses[0];
    return await new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: 'POST',
          agent: false,
          signal,
          lookup: (_host, options, done) => {
            if (options.all) done(null, [address]);
            else done(null, address.address, address.family);
          },
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        },
        (response) => {
          response.on('error', reject);
          const status = response.statusCode;
          // Delivery is acknowledged by status alone. Only successful callback
          // verification needs a bounded body; discard other response streams.
          if (!readBody || status < 200 || status >= 300) {
            resolve({ status });
            response.destroy();
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 4096) response.destroy(new CallbackError('response_too_large'));
            else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  } catch (error) {
    throw new CallbackError(networkReason(error));
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
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
    actual = JSON.parse(response.body).challenge;
  } catch {}
  if (
    typeof actual !== 'string' ||
    Buffer.byteLength(actual) !== Buffer.byteLength(challenge) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(challenge))
  )
    throw new CallbackError('challenge_failed');
}
