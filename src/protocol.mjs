import { z } from 'zod';
import packageInfo from '../package.json' with { type: 'json' };
import { publicSchemas, publicAnnotations } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { toolFailure } from './errors.mjs';
import { MCP_RESPONSE_LIMIT } from './response-budget.mjs';
import { EventError } from './events.mjs';

export const MODERN_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [MODERN_VERSION];
const SERVER_INFO = { name: 'pi-session-bridge', version: packageInfo.version };
export const META = 'io.modelcontextprotocol/';
export const MCP_INPUT_LIMIT = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
export const parseJson = (bytes) => JSON.parse(decoder.decode(bytes));
export async function readJson(stream, limit, tooLarge) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks, bytes));
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
  const requestContext = bridge.captureRequestContext?.();
  // A delayed/rejected executor must not leave an early policy failure unhandled.
  void requestContext?.catch(() => {});
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
function complete(result) {
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...result._meta, [META + 'serverInfo']: SERVER_INFO },
  };
}
function unsupportedVersion(id, requested) {
  return rpcError(id, -32022, 'Unsupported protocol version', {
    supported: SUPPORTED_VERSIONS,
    // A malformed version must still fit the MCP response budget.
    requested: requested.slice(0, 64),
  });
}
// Applies to the entire serialized JSON-RPC envelope, including escaped text
// duplication, metadata and request ID. Never truncates JSON.
function boundedResult(id, result) {
  const message = { jsonrpc: '2.0', id, result: complete(result) };
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= MCP_RESPONSE_LIMIT) return message;
  return {
    ...message,
    result: complete(
      toolError('RESPONSE_TOO_LARGE', {
        recovery:
          'OUTCOME_UNKNOWN; inspect list/read or request a smaller read. Do not automatically resubmit mutations.',
      }),
    ),
  };
}
export async function dispatchModern(bridge, body, options = {}) {
  const id = body?.id;
  if (!isRpcRequest(body) || id === undefined)
    return { status: 400, message: rpcError(null, -32600, 'Invalid request') };
  const meta = body.params?._meta;
  if (
    !object(meta) ||
    typeof meta[META + 'protocolVersion'] !== 'string' ||
    !object(meta[META + 'clientCapabilities']) ||
    (meta[META + 'clientInfo'] !== undefined &&
      (!object(meta[META + 'clientInfo']) ||
        typeof meta[META + 'clientInfo'].name !== 'string' ||
        typeof meta[META + 'clientInfo'].version !== 'string'))
  )
    return {
      status: 400,
      message: rpcError(
        id,
        -32602,
        'Required per-request protocol metadata is missing or malformed',
      ),
    };
  if (meta[META + 'protocolVersion'] !== MODERN_VERSION)
    return { status: 400, message: unsupportedVersion(id, meta[META + 'protocolVersion']) };
  let result;
  switch (body.method) {
    case 'server/discover':
      result = {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, events: {} },
        ttlMs: 0,
        cacheScope: 'private',
      };
      break;
    case 'events/list':
    case 'events/subscribe':
    case 'events/unsubscribe': {
      try {
        result = await bridge.events.handle(body.method, body.params, options);
      } catch (error) {
        return {
          status: error instanceof EventError && error.code !== -32603 ? 400 : 500,
          message:
            error instanceof EventError
              ? rpcError(id, error.code, error.message, error.data)
              : rpcError(id, -32603, 'REQUEST_FAILED'),
        };
      }
      break;
    }
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      if (body.params.cursor !== undefined)
        return { status: 400, message: rpcError(id, -32602, 'Invalid cursor') };
      result = { tools: toolDefinitions(), ttlMs: 0, cacheScope: 'private' };
      break;
    case 'tools/call':
      if (
        typeof body.params.name !== 'string' ||
        (body.params.arguments !== undefined && !object(body.params.arguments))
      )
        return { status: 400, message: rpcError(id, -32602, 'Malformed tool call') };
      if (!toolNames.includes(body.params.name))
        return { status: 400, message: rpcError(id, -32602, 'Unknown tool') };
      result = await callBridgeTool(bridge, body.params.name, body.params.arguments, {
        ...options,
        requestId: id,
      });
      break;
    default:
      return { status: 404, message: rpcError(id, -32601, 'Method not found') };
  }
  return { status: 200, message: boundedResult(id, result) };
}

export function modernHeaderFields(body) {
  const expected = {
    'mcp-protocol-version': body?.params?._meta?.[META + 'protocolVersion'],
    'mcp-method': body?.method,
  };
  if (['tools/call', 'prompts/get', 'resources/read'].includes(body?.method))
    expected['mcp-name'] = body?.params?.[body.method === 'resources/read' ? 'uri' : 'name'];
  return expected;
}

// Modern HTTP bindings require mirrored fields and reject duplicate headers.
export function validateModernHeaders(body, getHeaders) {
  for (const [name, value] of Object.entries(modernHeaderFields(body))) {
    const values = getHeaders(name);
    if (values.length !== 1 || typeof value !== 'string')
      return rpcError(body?.id, -32020, 'Header mismatch');
    let actual = values[0];
    if (name === 'mcp-name' && actual.startsWith('=?base64?') && actual.endsWith('?=')) {
      const encoded = actual.slice(9, -2);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        return rpcError(body?.id, -32020, 'Header mismatch');
      const bytes = Buffer.from(encoded, 'base64');
      try {
        actual = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return rpcError(body?.id, -32020, 'Header mismatch');
      }
    } else if (!/^[\x20-\x7e]+$/.test(actual) || actual.trim() !== actual)
      return rpcError(body?.id, -32020, 'Header mismatch');
    if (actual !== value) return rpcError(body?.id, -32020, 'Header mismatch');
  }
  return null;
}
