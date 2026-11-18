import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { utf16String } from './schema.mjs';
import { atomicJson, readPrivateFile, hash } from './storage.mjs';
import { permitted } from './permissions.mjs';
import { sameSessionIdentity } from './data.mjs';
import { knownErrorCode } from './errors.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { settledResultSchema } from './settled-result.mjs';
import { ownerSocket } from './owner-runtime.mjs';
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
const listSchema = z.strictObject({});
const deliverySchema = z
  .object({
    mode: z.string(),
    url: utf16String(4096),
    secret: utf16String(100),
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

// Advertised schemas are generated from the same contracts used to validate.
const payloadSchema = z
  .object({
    session_id: z.string(),
    leaf_id: z.string().nullable(),
    aborted: z.boolean(),
    result: settledResultSchema,
    read: z
      .object({
        session_id: z.string(),
        view: z.literal('session'),
        leaf_id: z.string().nullable(),
        range: z.object({ recent: z.literal(1) }).strict(),
      })
      .strict(),
  })
  .strict();
function jsonSchema(schema) {
  const { $schema, ...value } = z.toJSONSchema(schema, { target: 'draft-7' });
  return value;
}
const settledEventDefinition = {
  name: NAME,
  description:
    'A saved Pi session finishes a native agent run, including automatic continuations. Supports Bridge-owned RPC and ordinary TUI/RPC companions configured for this Bridge; SDK hosts and registry-only companions are unsupported. This is session-wide settlement, not per-prompt success or process exit. Includes a bounded last assistant response when available; its stop_reason is native termination, not task success. If more detail is useful, call read with the supplied read object to open Session Context at this exact leaf, including when a memory reader is enabled. Subscribe before sending work. No replay.',
  delivery: ['webhook'],
  inputSchema: jsonSchema(argsSchema),
  payloadSchema: jsonSchema(payloadSchema),
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
function assertRoom(records, id) {
  if (!records.has(id) && records.size >= MAX_SUBSCRIPTIONS)
    throw new EventError(-32025, 'ResourceExhausted', {
      limit: 'subscriptions',
      max: MAX_SUBSCRIPTIONS,
    });
}

// Subscription records are durable; occurrences/retries are deliberately not a
// replay log. The Bridge's existing state-directory lock owns this store.
export class EventSubscriptions {
  supports(runtime) {
    return (
      !runtime?.attached ||
      (['tui', 'extension'].includes(runtime.record?.kind) &&
        runtime.record.completionSocket === ownerSocket(this.bridge.config))
    );
  }
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
    this.requests = new Map();
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
  activeRecords(now = this.now()) {
    return new Map([...this.records].filter(([, record]) => record.expiresAt > now));
  }
  change(fn) {
    const task = this.changes.then(async () => {
      this.bridge.assertOpen();
      this.assertAvailable();
      const next = this.activeRecords();
      const result = fn(next);
      if (result) {
        await atomicJson(this.file, [...next.values()]);
        this.records = next;
      }
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
    if (method === 'events/list') request = parse(listSchema, input);
    else {
      request = parse(method === 'events/unsubscribe' ? unsubscribeSchema : subscribeSchema, input);
      if (request.name !== NAME) throw new EventError(-32023, 'NotFound', { kind: 'event' });
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
    const id = identity(request.arguments.session_id, request.delivery.url);
    const run = () => {
      this.bridge.assertOpen();
      return method === 'events/subscribe'
        ? this.subscribe(id, request, requestContext)
        : this.unsubscribe(id);
    };
    const previous = this.requests.get(id) ?? Promise.resolve();
    const task = previous.then(run, run);
    this.requests.set(id, task);
    try {
      return await task;
    } finally {
      if (this.requests.get(id) === task) this.requests.delete(id);
    }
  }
  async unsubscribe(id) {
    // The authenticated owner can stop its subscription after read revocation.
    await this.change((next) => next.delete(id));
    this.cancelDeliveries(id);
    return {};
  }
  cancelDeliveries(id) {
    for (const delivery of this.deliveries.values())
      if (delivery.id === id) delivery.controller.abort();
  }
  async subscribe(id, request, requestContext) {
    let session;
    try {
      session = await this.authorize(request.arguments.session_id, requestContext);
    } catch (error) {
      if (error.message !== 'NOT_FOUND_OR_DENIED') throw error;
      throw new EventError(-32024, 'Forbidden');
    }
    // Never start a writer to subscribe. A companion must target this Bridge.
    const runtime = await this.bridge.pool.forRead(session);
    if (!this.supports(runtime))
      throw new EventError(-32026, 'Unsupported', { feature: 'externalOwner' });
    const active = this.activeRecords();
    assertRoom(active, id);
    const { url, secret } = request.delivery;
    const record = { id, owner: OWNER, session_id: session.id, url, secret, verifiedUntil: 0 };
    // Consent is cached per callback URL. Only the store update is serialized
    // across subscriptions; a slow receiver holds its own request lane.
    for (const candidate of active.values())
      if (candidate.url === url)
        record.verifiedUntil = Math.max(record.verifiedUntil, candidate.verifiedUntil);
    if (record.verifiedUntil <= this.now()) {
      if (process.env.PI_MCP_LOG_CALLBACK_HOST === '1')
        diagnostics.emit('events.callback_target', {
          callback_hostname: callbackUrl(url).hostname,
        });
      try {
        await verifyCallback(record, this.post, this.shutdown.signal);
      } catch (error) {
        throw new EventError(-32015, 'CallbackEndpointError', {
          reason: error instanceof CallbackError ? error.reason : 'connection_refused',
        });
      }
      record.verifiedUntil = this.now() + 300000;
    }
    return this.change((next) => {
      assertRoom(next, id);
      const previous = next.get(id);
      const now = this.now();
      record.expiresAt = now + Math.min(request.ttlMs ?? DEFAULT_TTL, MAX_TTL);
      // The same public ID can be subscribed again after its old lifetime ends.
      if (!previous) this.cancelDeliveries(id);
      else if (previous.secret !== record.secret) {
        record.previousSecret = previous.secret;
        record.rotateUntil = now + ROTATION_MS;
      } else if (previous.rotateUntil > now) {
        record.previousSecret = previous.previousSecret;
        record.rotateUntil = previous.rotateUntil;
      }
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
    const now = this.now();
    const records = [...this.records.values()].filter(
      (record) => record.session_id === session.id && record.expiresAt > now,
    );
    if (!records.length) return;
    const event = {
      eventId: 'evt_' + randomUUID(),
      name: NAME,
      timestamp: occurrence.timestamp,
      data: {
        session_id: session.id,
        leaf_id: occurrence.leafId,
        aborted: occurrence.aborted,
        // Validated at the owner control boundary (Bridge.settledForLocal).
        result: occurrence.result,
        read: {
          session_id: session.id,
          view: 'session',
          leaf_id: occurrence.leafId,
          range: { recent: 1 },
        },
      },
      cursor: null,
    };
    // Serialize ONCE. Each retry signs and transmits these exact bytes.
    const body = JSON.stringify(event);
    const session_ref = diagnosticRef(session.id);
    for (const record of records) {
      if (this.deliveries.size >= MAX_DELIVERIES) {
        diagnostics.emit('events.delivery_dropped', { session_ref });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
      const task = this.deliver(record.id, session, event.eventId, body, signal)
        .catch(() => {
          if (!signal.aborted) diagnostics.emit('events.delivery_failed', { session_ref });
        })
        .finally(() => this.deliveries.delete(task));
      this.deliveries.set(task, { id: record.id, controller });
    }
  }
  async deliver(id, session, eventId, body, signal) {
    const session_ref = diagnosticRef(session.id);
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (this.storeError || signal.aborted) return;
      let record = this.records.get(id);
      if (!record || record.expiresAt <= this.now()) return;
      // Authorization is refreshed for each outbound attempt, not frozen for a
      // subscription's lifetime. A stale file/header cannot retarget an event.
      try {
        if (!sameSessionIdentity(await this.authorize(session.id), session)) return;
      } catch (error) {
        if (!this.bridge.closing && error.message === 'NOT_FOUND_OR_DENIED')
          await this.change((next) => next.get(id) === record && next.delete(id));
        return;
      }
      // Unsubscribe/rotation may have finished during authorization.
      record = this.records.get(id);
      const now = this.now();
      if (!record || record.expiresAt <= now || signal.aborted) return;
      let response;
      try {
        response = await this.post(
          record.url,
          body,
          signedHeaders(record, eventId, body, new Date(now)),
          { signal: AbortSignal.any([signal, AbortSignal.timeout(record.expiresAt - now)]) },
        );
      } catch (error) {
        if (error instanceof CallbackError && error.reason === 'blocked_address') {
          diagnostics.emit('events.delivery_failed', { session_ref });
          return;
        }
      }
      if (response?.status >= 200 && response.status < 300) {
        diagnostics.emit('events.delivered', {
          session_ref,
          http_status: response.status,
        });
        return;
      }
      if (response && response.status !== 408 && response.status !== 429 && response.status < 500) {
        diagnostics.emit('events.delivery_failed', {
          session_ref,
          http_status: response.status,
        });
        return; // Includes 410, 413 and redirects; never follow or retry them.
      }
      if (attempt < this.retryDelays.length)
        await delay(this.retryDelays[attempt], undefined, { signal });
    }
    diagnostics.emit('events.delivery_failed', { session_ref });
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled([this.changes, ...this.requests.values(), ...this.deliveries.keys()]);
  }
}
