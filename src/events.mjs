import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { atomicJson, readPrivateFile, hash } from './storage.mjs';
import { permitted } from './permissions.mjs';
import { knownErrorCode } from './errors.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { settledResultSchema } from './settled-result.mjs';
import {
  callbackUrl,
  signingSecret,
  postWebhook,
  signedHeaders,
  verifyCallback,
  CallbackError,
} from './event-webhook.mjs';

const NAME = 'session.settled';
const OWNER = 'owner'; // The authenticated Bridge deployment is single-owner.
const MAX_SUBSCRIPTIONS = 32,
  MAX_DELIVERIES = 64;
const DEFAULT_TTL = 3600000,
  MAX_TTL = 86400000,
  ROTATION_MS = 300000;
const argsSchema = z.object({ session_id: z.string().regex(/^ps_[a-f0-9]{32}$/) }).strict();
const deliverySchema = z
  .object({
    mode: z.string(),
    url: z.string().max(4096),
    secret: z.string().max(100),
  })
  .strict();
const subscribeSchema = z
  .object({
    name: z.string(),
    arguments: argsSchema,
    delivery: deliverySchema,
    cursor: z.string().nullable().optional(),
    ttlMs: z.number().int().positive().safe().nullable().optional(),
  })
  .strict();
const unsubscribeSchema = z
  .object({
    name: z.string(),
    arguments: argsSchema,
    delivery: deliverySchema.omit({ secret: true }),
  })
  .strict();
const recordSchema = z
  .object({
    id: z.string(),
    owner: z.literal(OWNER),
    session_id: argsSchema.shape.session_id,
    url: z.string(),
    secret: z.string(),
    expiresAt: z.number().int().safe(),
    verifiedUntil: z.number().int().safe(),
    previousSecret: z.string().optional(),
    rotateUntil: z.number().int().safe().optional(),
  })
  .strict();

export const settledEventDefinition = {
  name: NAME,
  description:
    'A saved Pi session finishes a native agent run, including automatic continuations. Only Bridge-owned RPC execution is observed; external TUI/RPC/SDK owners are unsupported. This is session-wide settlement, not per-prompt success or process exit. Includes a bounded last assistant response when available; its stop_reason is native termination, not task success. If more detail is useful, call read with the supplied read object to open Session Context at this exact leaf, including when a memory reader is enabled. Subscribe before sending work. No replay.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', pattern: '^ps_[a-f0-9]{32}$' } },
    required: ['session_id'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      leaf_id: { type: ['string', 'null'] },
      aborted: { type: 'boolean' },
      result: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              entry_id: { type: 'string' },
              text: { type: 'string' },
              stop_reason: { type: ['string', 'null'] },
              truncated: { type: 'boolean' },
            },
            required: ['entry_id', 'text', 'stop_reason', 'truncated'],
            additionalProperties: false,
          },
        ],
      },
      read: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          view: { const: 'session' },
          leaf_id: { type: ['string', 'null'] },
          preset: { const: 'latest' },
        },
        required: ['session_id', 'view', 'leaf_id', 'preset'],
        additionalProperties: false,
      },
    },
    required: ['session_id', 'leaf_id', 'aborted', 'result', 'read'],
    additionalProperties: false,
  },
};
export class EventError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const invalid = () => {
  throw new EventError(-32602, 'InvalidParams');
};
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
function validateDestination(delivery, withSecret = true) {
  if (delivery.mode !== 'webhook')
    throw new EventError(-32026, 'Unsupported', { feature: 'deliveryMode' });
  try {
    callbackUrl(delivery.url);
    if (withSecret) signingSecret(delivery.secret);
  } catch {
    invalid();
  }
}
function identity(sessionId, url) {
  // The only argument is session_id: fixed property order is canonical here.
  return 'sub_' + hash([OWNER, url, NAME, { session_id: sessionId }]);
}
function requireName(name) {
  if (name !== NAME) throw new EventError(-32023, 'NotFound', { kind: 'event' });
}

// Subscription records are durable; occurrences/retries are deliberately not a
// replay log. The Bridge's existing state-directory lock owns this store.
export class EventSubscriptions {
  constructor(
    bridge,
    {
      post = postWebhook,
      now = Date.now,
      // Keep a bounded retry opportunity across brief callback outages.
      retryDelays = [1000, 2000, 4000, 8000, 16000, 30000, 60000, 120000, 120000],
    } = {},
  ) {
    this.bridge = bridge;
    this.file = path.join(bridge.config.stateDir, 'event-subscriptions.json');
    this.post = post;
    this.now = now;
    this.retryDelays = retryDelays;
    this.records = new Map();
    this.deliveries = new Map();
    this.changes = Promise.resolve();
    this.shutdown = new AbortController();
  }
  async init() {
    let text;
    try {
      ({ text } = await readPrivateFile(this.file, 1024 * 1024, {
        pathError: 'INVALID_EVENT_SUBSCRIPTIONS',
        privacyError: 'EVENT_SUBSCRIPTIONS_NOT_PRIVATE',
      }));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.disableStore(knownErrorCode(error.code ?? error.message, 'INVALID_EVENT_SUBSCRIPTIONS'));
      return;
    }
    try {
      const records = JSON.parse(text),
        next = new Map(),
        now = this.now();
      if (!Array.isArray(records)) throw new Error();
      for (const value of records) {
        // A known expired lifetime ends the record's obligations; do not decode
        // retired endpoint metadata or count it against active subscriptions.
        if (Number.isSafeInteger(value?.expiresAt) && value.expiresAt <= now) continue;
        const record = recordSchema.parse(value);
        callbackUrl(record.url);
        signingSecret(record.secret);
        if (record.previousSecret) signingSecret(record.previousSecret);
        if (
          record.id !== identity(record.session_id, record.url) ||
          next.has(record.id) ||
          next.size >= MAX_SUBSCRIPTIONS
        )
          throw new Error();
        next.set(record.id, record);
      }
      this.records = next;
    } catch {
      this.disableStore('INVALID_EVENT_SUBSCRIPTIONS');
    }
  }
  disableStore(reason) {
    this.records.clear();
    this.storeError = reason;
    diagnostics.emit('events.store_unavailable', { code: reason });
  }
  health() {
    return this.storeError ? { status: 'unavailable', reason: this.storeError } : { status: 'ok' };
  }
  assertAvailable() {
    if (this.storeError)
      throw new EventError(-32603, 'EventSubscriptionsUnavailable', { reason: this.storeError });
  }
  async change(fn) {
    const task = this.changes.then(async () => {
      this.bridge.assertOpen();
      this.assertAvailable();
      const next = new Map([...this.records].filter(([, r]) => r.expiresAt > this.now()));
      const result = await fn(next);
      await atomicJson(this.file, [...next.values()]);
      this.records = next;
      return result;
    });
    this.changes = task.catch(() => {});
    return task;
  }
  async authorize(sessionId, requestContext) {
    const context = await (requestContext ?? this.bridge.captureRequestContext());
    const session = await this.bridge.session(sessionId, context);
    this.bridge.check('read', session, context);
    return session;
  }
  async handle(method, params, { execute = (run) => run() } = {}) {
    this.assertAvailable();
    const { _meta, ...input } = params;
    let request;
    if (method === 'events/list') {
      request = parse(z.object({ cursor: z.string().optional() }).strict(), input);
      if (request.cursor !== undefined) invalid(); // One descriptor, no pagination.
    } else {
      request = parse(method === 'events/unsubscribe' ? unsubscribeSchema : subscribeSchema, input);
      requireName(request.name);
      validateDestination(request.delivery, method !== 'events/unsubscribe');
      if (request.cursor != null)
        throw new EventError(-32026, 'Unsupported', { feature: 'replay' });
    }
    // Capture only after validation, before executor waits. Outbound deliveries
    // deliberately call authorize without this context to read current policy.
    const context =
      method === 'events/unsubscribe' ? undefined : this.bridge.captureRequestContext();
    void context?.catch(() => {});
    return execute(() => this.executeRequest(method, request, context));
  }
  async executeRequest(method, request, requestContext) {
    if (method === 'events/list') {
      const context = await requestContext;
      const sessions = await this.bridge.sessions(context);
      return {
        events: sessions.some((s) => permitted(context.permissions, 'read', s))
          ? [settledEventDefinition]
          : [],
      };
    }
    if (method === 'events/unsubscribe') {
      // Same authenticated owner can always stop its subscription after revocation.
      const id = identity(request.arguments.session_id, request.delivery.url);
      await this.change((next) => {
        next.delete(id);
      });
      for (const delivery of this.deliveries.values())
        if (delivery.id === id) delivery.controller.abort();
      return {};
    }
    let session;
    try {
      session = await this.authorize(request.arguments.session_id, requestContext);
    } catch {
      throw new EventError(-32024, 'Forbidden');
    }
    // Never start a writer to subscribe. Reject currently attached owners.
    const runtime = await this.bridge.pool.forRead(session);
    if (runtime?.attached)
      throw new EventError(-32026, 'Unsupported', { feature: 'externalOwner' });
    const id = identity(session.id, request.delivery.url);
    return this.change(async (next) => {
      if (!next.has(id) && next.size >= MAX_SUBSCRIPTIONS)
        throw new EventError(-32025, 'ResourceExhausted', {
          limit: 'subscriptions',
          max: MAX_SUBSCRIPTIONS,
        });
      const previous = next.get(id);
      const record = {
        id,
        owner: OWNER,
        session_id: session.id,
        url: request.delivery.url,
        secret: request.delivery.secret,
        expiresAt: 0,
        verifiedUntil: 0,
      };
      // Consent is cached per owner + exact callback URL, not per event/filter.
      const verified = [...next.values()].some(
        (r) => r.url === record.url && r.verifiedUntil > this.now(),
      );
      if (!verified) {
        // Explicit, temporary hostname-only troubleshooting; never emit the URL.
        if (process.env.PI_MCP_LOG_CALLBACK_HOST === '1')
          diagnostics.emit('events.callback_target', {
            callback_hostname: callbackUrl(record.url).hostname,
          });
        try {
          await verifyCallback(record, this.post, this.shutdown.signal);
        } catch (error) {
          throw new EventError(-32015, 'CallbackEndpointError', {
            reason: error instanceof CallbackError ? error.reason : 'connection_refused',
          });
        }
      }
      record.verifiedUntil = verified
        ? Math.max(
            ...[...next.values()].filter((r) => r.url === record.url).map((r) => r.verifiedUntil),
          )
        : this.now() + 300000;
      record.expiresAt = this.now() + Math.min(request.ttlMs ?? DEFAULT_TTL, MAX_TTL);
      if (previous?.secret && previous.secret !== record.secret) {
        record.previousSecret = previous.secret;
        record.rotateUntil = this.now() + ROTATION_MS;
      } else if (previous?.rotateUntil > this.now()) {
        record.previousSecret = previous.previousSecret;
        record.rotateUntil = previous.rotateUntil;
      }
      this.bridge.assertOpen();
      next.set(id, record);
      return {
        id,
        refreshBefore: new Date(record.expiresAt).toISOString(),
        cursor: null,
        truncated: false,
      };
    });
  }
  observe(session, occurrence) {
    if (this.storeError || this.shutdown.signal.aborted || this.bridge.closing) return;
    const event = {
      eventId: 'evt_' + randomUUID(),
      name: NAME,
      timestamp: occurrence.timestamp,
      data: {
        session_id: session.id,
        leaf_id: occurrence.leafId,
        aborted: occurrence.aborted,
        result: settledResultSchema.parse(occurrence.result),
        read: {
          session_id: session.id,
          view: 'session',
          leaf_id: occurrence.leafId,
          preset: 'latest',
        },
      },
      cursor: null,
    };
    // Serialize ONCE. Each retry signs and transmits these exact bytes.
    const body = JSON.stringify(event);
    for (const record of this.records.values()) {
      if (record.session_id !== session.id || record.expiresAt <= this.now()) continue;
      if (this.deliveries.size >= MAX_DELIVERIES) {
        diagnostics.emit('events.delivery_dropped', { session_ref: diagnosticRef(session.id) });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
      const task = this.deliver(record.id, session, event.eventId, body, signal)
        .catch(() => {
          if (!signal.aborted)
            diagnostics.emit('events.delivery_failed', { session_ref: diagnosticRef(session.id) });
        })
        .finally(() => this.deliveries.delete(task));
      this.deliveries.set(task, { id: record.id, controller });
    }
  }
  async deliver(id, session, eventId, body, signal) {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (this.storeError || signal.aborted) return;
      let record = this.records.get(id);
      if (!record || record.expiresAt <= this.now()) return;
      // Authorization is refreshed for each outbound attempt, not frozen for a
      // subscription's lifetime. A stale file/header cannot retarget an event.
      try {
        const current = await this.authorize(session.id);
        if (current.file !== session.file || current.header.id !== session.header.id) return;
      } catch (error) {
        if (!this.bridge.closing && error.message === 'NOT_FOUND_OR_DENIED')
          await this.change((next) => {
            if (next.get(id) === record) next.delete(id);
          });
        return;
      }
      // Unsubscribe/rotation may have finished during authorization.
      record = this.records.get(id);
      if (!record || record.expiresAt <= this.now() || signal.aborted) return;
      let response;
      try {
        response = await this.post(
          record.url,
          body,
          signedHeaders(record, eventId, body, new Date(this.now())),
          { signal: AbortSignal.any([signal, AbortSignal.timeout(record.expiresAt - this.now())]) },
        );
      } catch (error) {
        if (error instanceof CallbackError && error.reason === 'blocked_address') {
          diagnostics.emit('events.delivery_failed', { session_ref: diagnosticRef(session.id) });
          return;
        }
      }
      if (response?.status >= 200 && response.status < 300) {
        diagnostics.emit('events.delivered', {
          session_ref: diagnosticRef(session.id),
          http_status: response.status,
        });
        return;
      }
      if (response && response.status !== 408 && response.status !== 429 && response.status < 500) {
        diagnostics.emit('events.delivery_failed', {
          session_ref: diagnosticRef(session.id),
          http_status: response.status,
        });
        return; // Includes 410, 413 and redirects; never follow or retry them.
      }
      if (attempt < this.retryDelays.length)
        await delay(this.retryDelays[attempt], undefined, { signal });
    }
    diagnostics.emit('events.delivery_failed', { session_ref: diagnosticRef(session.id) });
  }
  async close() {
    this.shutdown.abort();
    await this.changes;
    await Promise.allSettled([...this.deliveries.keys()]);
  }
}
