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
const SUPPORTED_VERSIONS = [MODERN_VERSION];
const SERVER_INFO = { name: 'pi-session-bridge', version: packageInfo.version };
export const META = 'io.modelcontextprotocol/';
export const MCP_INPUT_LIMIT = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
export const parseJson = (bytes) => JSON.parse(decoder.decode(bytes));
export async function readJson(stream, limit, tooLarge) {
  return parseJson(await readBoundedBytes(stream, limit, () => new Error(tooLarge)));
}
// Keep descriptions concise to minimize per-conversation token overhead.
// Detailed semantics live in docs/api.md and error recovery hints.
const descriptions = {
  list: 'List authorized Pi sessions (newest first) with status, model, thinking level, capabilities and creatable_projects. Requires list; never starts Pi.',
  read: 'Read a Pi session in source order (default: last 3 turns); requires read, never starts Pi. Expand item refs with read({refs:[...]}); continue pages with read({cursor}). Omit view for default source (including configured readers).',
  search:
    'Search literal case-insensitive text across a session’s full effective context; requires read, never starts Pi. Returns snippets with refs for read({refs}) and cursor for read({cursor}).',
  models:
    'List configured native Pi models (provider, id, context_window, thinking_levels) without network refresh. Requires send, command or create.',
  set_model:
    'Change a session’s model and/or thinking_level without sending a prompt (works while busy); requires send. Returns actual selection after native adjustment.',
  compact:
    'Run native context compaction on an idle session (requires send; interrupt:true also requires stop). Returns metadata; on unknown check list/read before retrying.',
  reload:
    'Reload Pi extensions and settings for an idle active owner; requires send. Never interrupts or queues work; check list/read before retrying after unknown.',
  send: 'Submit text and/or images to a session; requires send. mode: steer (default), follow_up or idle_only. Returns submission_id and admission status (not completion); check submission/list/read after unknown—never resubmit automatically.',
  submission:
    'Look up a send/create admission receipt (including late native ACKs) without contacting Pi. Requires read, send, or create for a create receipt.',
  command:
    'Run a native Pi shell command (omit leading !); requires command. Returns output, exitCode and cancelled. Never retry automatically after unknown.',
  stop: 'Cancel active work and withdraw queued input; requires stop, never starts Pi. Acts on current work each time.',
  create:
    'Create a saved session in a configured project (see list.creatable_projects); requires create. Optional text/images send the first prompt; fork_from copies a parent branch (also requires read). Never recreate automatically after unknown.',
  delete:
    'Stop the session’s writer and move the session file to recoverable trash (project files untouched); requires delete. Returns restore_token.',
  batch:
    'Run 1–10 operations as {op,args}. Same-session items run in order, different sessions concurrently; items fail independently. Repeating a batch repeats its mutations.',
  health:
    'Check permission policy warnings, settings awaiting restart, and event-store status. Optional session_id scopes to one session.',
};
const toolNames = Object.keys(descriptions);
let tools;
export function toolDefinitions() {
  return (tools ??= toolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(publicSchemas[name], { target: 'draft-7', io: 'input' }),
    ...(publicAnnotations[name] ? { annotations: publicAnnotations[name] } : {}),
  })));
}
const ownerRecovery =
  'Use a session owner that supports the current control protocol and operation. A safe native reload can update the endpoint at an idle boundary.';
const recoveryByCode = {
  OWNER_READ_REFRESH_REQUIRED:
    'Call reload for this session at an idle boundary, then retry read. If reload is unsupported, update the configured companion and use native /reload or a host-managed reopen once. Changing read arguments will not refresh the owner.',
  ATTACHMENT_PROTOCOL_MISMATCH: ownerRecovery,
  OWNER_COMPONENT_UPDATE_REQUIRED: ownerRecovery,
};
function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
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
function success(id, result) {
  const envelope = (value) => ({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      ...value,
      _meta: { ...value._meta, [META + 'serverInfo']: SERVER_INFO },
    },
  });
  let message = envelope(result);
  if (Buffer.byteLength(JSON.stringify(message)) > MCP_RESPONSE_LIMIT)
    message = envelope(
      toolError('RESPONSE_TOO_LARGE', {
        recovery:
          'OUTCOME_UNKNOWN; inspect list/read or request a smaller read. Do not automatically resubmit mutations.',
      }),
    );
  return { status: 200, message };
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
