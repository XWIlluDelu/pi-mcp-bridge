import { z } from 'zod';
import packageInfo from '../../package.json' with { type: 'json' };
import { publicSchemas, publicAnnotations } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from '../core/diagnostics.mjs';
import { toolFailure } from '../core/errors.mjs';
import { readBoundedBytes } from '../core/storage.mjs';
import { MCP_RESPONSE_LIMIT } from './response-budget.mjs';
import { EventError } from '../events/events.mjs';

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const SUPPORTED_VERSIONS = [MODERN_VERSION];
const SERVER_INFO = { name: 'pi-session-bridge', version: packageInfo.version };
export const META = 'io.modelcontextprotocol/';
export const MCP_INPUT_LIMIT = 8 * 1024 * 1024;
export const MCP_EXTRA_CONTENT = Symbol('pi-mcp-bridge.extra-content');
const decoder = new TextDecoder('utf-8', { fatal: true });
export const parseJson = (bytes) => JSON.parse(decoder.decode(bytes));
export async function readJson(stream, limit, tooLarge) {
  return parseJson(await readBoundedBytes(stream, limit, () => new Error(tooLarge)));
}
// Concise tool descriptions grouped by layer: session lifecycle (*_session),
// in-session actions (read/send/command/stop/submission), and Bridge-level utilities.
const descriptions = {
  list_sessions:
    'List Pi sessions with status, model, context_usage, capabilities, and creatable_projects. With session_id+wait_ms, waits up to wait_ms for settlement.',
  create_session:
    'Create or fork (fork_from) a session in creatable_projects; optional name, initial prompt, model, thinking_level, and wait_ms.',
  update_session:
    'Update a session’s model, thinking_level, or display name without prompting (rename works offline).',
  maintain_session:
    'Run idle session maintenance: action="compact" (optional instructions, interrupt:true) or action="reload" (refresh extensions/settings).',
  delete_session:
    'Stop a session’s writer and move its file to recoverable trash (project files untouched).',
  read: 'Read or search session context (default: last 3 turns; set query for full-session literal search). Expand {refs,include_images?}; paginate {cursor}; content.system:true lists slash commands.',
  send: 'Send text/images to a session (mode: steer|follow_up|idle_only). Optional wait_ms (<=30000) waits for settlement; never auto-retry after unknown.',
  command: 'Run a shell command in Pi (omit !; exclude_from_context:true matches !!).',
  stop: 'Abort active work and withdraw queued input. Never starts Pi.',
  submission:
    'Check a send/create_session admission receipt (including late ACKs) without contacting Pi.',
  models: 'List configured Pi models (provider, id, context_window, thinking_levels).',
  batch: 'Run 1–10 operations in parallel across sessions (in order per session).',
  health: 'Diagnose permission grants, restart-pending settings, and event-store status.',
};
const toolNames = Object.keys(descriptions);
function compactSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(compactSchema);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'additionalProperties') continue;
    if (key === 'pattern' && (node.format === 'date-time' || node.format === 'uuid')) continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && value === -Number.MAX_SAFE_INTEGER) continue;
    out[key] = compactSchema(value);
  }
  return out;
}
let tools;
export function toolDefinitions() {
  return (tools ??= toolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: compactSchema(
      z.toJSONSchema(publicSchemas[name], { target: 'draft-7', io: 'input' }),
    ),
    ...(publicAnnotations[name] ? { annotations: publicAnnotations[name] } : {}),
  })));
}
const ownerRecovery =
  'Use a session owner that supports the current control protocol and operation. A safe native reload can update the endpoint at an idle boundary.';
const recoveryByCode = {
  OWNER_READ_REFRESH_REQUIRED:
    'Call maintain_session({session_id, action:"reload"}) at an idle boundary, then retry read. If reload is unsupported, update the configured companion and use native /reload or a host-managed reopen once. Changing read arguments will not refresh the owner.',
  ATTACHMENT_PROTOCOL_MISMATCH: ownerRecovery,
  OWNER_COMPONENT_UPDATE_REQUIRED: ownerRecovery,
};
function toolResult(result) {
  const extra = Array.isArray(result?.[MCP_EXTRA_CONTENT]) ? result[MCP_EXTRA_CONTENT] : [];
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }, ...extra],
    structuredContent: result,
  };
}
function toolError(code, extra = {}) {
  const recovery = recoveryByCode[code];
  return {
    isError: true,
    ...toolResult({ error: { code, ...(recovery ? { recovery } : {}), ...extra } }),
  };
}
export async function callBridgeTool(
  bridge,
  name,
  input,
  { requestId, execute = (run) => run() } = {},
) {
  const schema = Object.hasOwn(publicSchemas, name) ? publicSchemas[name] : null;
  if (!schema) return toolError('UNKNOWN_TOOL');
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success)
    return toolError('INVALID_ARGUMENTS', {
      issues: parsed.error.issues
        .map((issue) => ({ path: issue.path, message: issue.message }))
        .slice(0, 12),
    });
  const args = parsed.data;
  // Start at the authoritative receive boundary, not when a delayed executor runs.
  const requestContext = bridge.captureRequestContext();
  // A delayed/rejected executor must not leave an early policy failure unhandled.
  void requestContext.catch(() => {});
  return execute(async () => {
    try {
      // Input methods register their existing Stop fence before awaiting policy I/O.
      const result = await diagnostics.measure(
        'tool',
        {
          op: name,
          mcp_id_ref: diagnosticRef(requestId),
          session_ref: diagnosticRef(args.session_id),
        },
        () =>
          name === 'batch'
            ? executeBatch(bridge, args, { requestContext })
            : bridge[name](args, { requestContext }),
      );
      return toolResult(result);
    } catch (error) {
      const { code, ...details } = toolFailure(error);
      return toolError(code, details);
    }
  });
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function isRpcRequest(body) {
  return (
    object(body) &&
    body.jsonrpc === '2.0' &&
    typeof body.method === 'string' &&
    (body.params === undefined || object(body.params)) &&
    (body.id === undefined ||
      (typeof body.id === 'number' && Number.isSafeInteger(body.id)) ||
      (typeof body.id === 'string' && Buffer.byteLength(body.id) <= 1024))
  );
}
export function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
// The budget covers the full JSON-RPC envelope, including the duplicated text
// and the request ID. Keep the fallback within the same response contract.
function success(id, result, modern = true) {
  const envelope = (value) => ({
    jsonrpc: '2.0',
    id,
    result: modern
      ? {
          resultType: 'complete',
          ...value,
          _meta: { ...value._meta, [META + 'serverInfo']: SERVER_INFO },
        }
      : value,
  });
  let message = envelope(result);
  if (Buffer.byteLength(JSON.stringify(message)) > MCP_RESPONSE_LIMIT) {
    // If extra image content blocks pushed the envelope over the limit, fall back to text-only first.
    if (Array.isArray(result?.content) && result.content.length > 1) {
      message = envelope({ ...result, content: [result.content[0]] });
    }
    if (Buffer.byteLength(JSON.stringify(message)) > MCP_RESPONSE_LIMIT)
      message = envelope(
        toolError('RESPONSE_TOO_LARGE', {
          recovery:
            'OUTCOME_UNKNOWN; inspect list/read or request a smaller read. Do not automatically resubmit mutations.',
        }),
      );
  }
  return { status: 200, message };
}

export function isModernRequest(body, headers) {
  if (!body || typeof body !== 'object') return false;
  if (body.method === 'server/discover' || body.method?.startsWith?.('events/')) return true;
  if (body.params?._meta && Object.hasOwn(body.params._meta, META + 'protocolVersion')) return true;
  if (headers?.['mcp-protocol-version']?.[0] === MODERN_VERSION) return true;
  if (headers?.['mcp-method'] !== undefined) return true;
  return false;
}

export async function dispatchModern(bridge, body, options = {}) {
  if (!isRpcRequest(body) || body.id === undefined)
    return { status: 400, message: rpcError(null, -32600, 'Invalid request') };
  const { id, params, method } = body;
  const reject = (code, reason, data, status = 400) => ({
    status,
    message: rpcError(id, code, reason, data),
  });
  if (options.headers && !validModernHeaders(body, options.headers))
    return reject(-32020, 'Header mismatch');
  const meta = params?._meta;
  const version = meta?.[META + 'protocolVersion'];
  const client = meta?.[META + 'clientInfo'];
  if (
    !object(meta) ||
    typeof version !== 'string' ||
    !object(meta[META + 'clientCapabilities']) ||
    (client !== undefined &&
      (!object(client) || typeof client.name !== 'string' || typeof client.version !== 'string'))
  )
    return reject(-32602, 'Required per-request protocol metadata is missing or malformed');
  if (version !== MODERN_VERSION)
    return reject(-32022, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: version.slice(0, 64),
    });
  switch (method) {
    case 'server/discover':
      return success(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, events: {} },
        ttlMs: 0,
        cacheScope: 'private',
      });
    case 'events/list':
    case 'events/subscribe':
    case 'events/unsubscribe':
      try {
        return success(id, await bridge.events.handle(method, params, options));
      } catch (error) {
        if (error instanceof EventError)
          return reject(error.code, error.message, error.data, error.code === -32603 ? 500 : 400);
        return reject(-32603, 'REQUEST_FAILED', undefined, 500);
      }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      if (params.cursor !== undefined) return reject(-32602, 'Invalid cursor');
      return success(id, { tools: toolDefinitions(), ttlMs: 0, cacheScope: 'private' });
    case 'tools/call':
      if (
        typeof params.name !== 'string' ||
        (params.arguments !== undefined && !object(params.arguments))
      )
        return reject(-32602, 'Malformed tool call');
      if (!toolNames.includes(params.name)) return reject(-32602, 'Unknown tool');
      return success(
        id,
        await callBridgeTool(bridge, params.name, params.arguments, { ...options, requestId: id }),
      );
    default:
      return reject(-32601, 'Method not found', undefined, 404);
  }
}

async function dispatchLegacy(bridge, body, options = {}) {
  if (!isRpcRequest(body))
    return { status: 400, message: rpcError(null, -32600, 'Invalid request') };
  const { id, params = {}, method } = body;
  // Standard MCP notifications (e.g. notifications/initialized, notifications/cancelled) have no id.
  if (id === undefined) return { status: 202, message: null };
  const reject = (code, reason, data, status = 400) => ({
    status,
    message: rpcError(id, code, reason, data),
  });
  const headerVersion = options.headers?.['mcp-protocol-version'];
  if (headerVersion !== undefined) {
    if (headerVersion.length !== 1 || !LEGACY_VERSIONS.includes(headerVersion[0]))
      return reject(-32022, 'Unsupported protocol version', {
        supported: [...SUPPORTED_VERSIONS, ...LEGACY_VERSIONS],
        requested: String(headerVersion[0] ?? '').slice(0, 64),
      });
  }
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return success(
        id,
        {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
        false,
      );
    }
    case 'ping':
      return success(id, {}, false);
    case 'tools/list':
      if (params.cursor !== undefined) return reject(-32602, 'Invalid cursor');
      return success(id, { tools: toolDefinitions() }, false);
    case 'tools/call':
      if (
        typeof params.name !== 'string' ||
        (params.arguments !== undefined && !object(params.arguments))
      )
        return reject(-32602, 'Malformed tool call');
      if (!toolNames.includes(params.name)) return reject(-32602, 'Unknown tool');
      return success(
        id,
        await callBridgeTool(bridge, params.name, params.arguments, { ...options, requestId: id }),
        false,
      );
    default:
      return reject(-32601, 'Method not found', undefined, 404);
  }
}

// Unified MCP dispatcher: supports both 2026-07-28 per-request stateless MCP
// (ChatGPT/Dots/Events) and standard MCP initialize-based clients (Claude, Cursor, Pi).
export function dispatchMcp(bridge, body, options = {}) {
  return isModernRequest(body, options.headers)
    ? dispatchModern(bridge, body, options)
    : dispatchLegacy(bridge, body, options);
}

function modernHeaderFields(body) {
  const expected = {
    'mcp-protocol-version': body?.params?._meta?.[META + 'protocolVersion'],
    'mcp-method': body?.method,
  };
  // Bridge serves no prompts or resources; tools/call is its only named method.
  if (body?.method === 'tools/call') expected['mcp-name'] = body.params?.name;
  return expected;
}

const plainHeader = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const encodedPrefix = '=?base64?';
export function forwardedMcpHeaders(body) {
  const headers = modernHeaderFields(body);
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') delete headers[name];
    else if (name === 'mcp-name' && (!plainHeader.test(value) || value.startsWith(encodedPrefix)))
      headers[name] = encodedPrefix + Buffer.from(value).toString('base64') + '?=';
  }
  return headers;
}

// Modern HTTP bindings require mirrored fields and reject duplicate headers.
function validModernHeaders(body, headers) {
  return Object.entries(modernHeaderFields(body)).every(([name, value]) => {
    const actual = headers[name]?.[0];
    if (headers[name]?.length !== 1 || typeof value !== 'string') return false;
    if (name !== 'mcp-name' || !actual.startsWith(encodedPrefix) || !actual.endsWith('?='))
      return plainHeader.test(actual) && actual === value;
    const encoded = actual.slice(encodedPrefix.length, -2);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      return false;
    try {
      return decoder.decode(Buffer.from(encoded, 'base64')) === value;
    } catch {
      return false;
    }
  });
}
