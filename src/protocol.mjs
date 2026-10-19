import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import packageInfo from '../package.json' with { type: 'json' };
import { publicSchemas } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';

export const MODERN_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = [
  MODERN_VERSION,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const SERVER_INFO = { name: 'pi-session-bridge', version: packageInfo.version };
export const META = 'io.modelcontextprotocol/';
import { MCP_RESPONSE_LIMIT } from './response-budget.mjs';
export { MCP_RESPONSE_LIMIT } from './response-budget.mjs';
export const MCP_INPUT_LIMIT = 8 * 1024 * 1024;
export const descriptions = {
  list: 'List authorized Pi sessions with project, name, recent activity and coarse runtime status. Filters combine; newest activity first. list permission is independent of read.',
  read: 'Read the effective Pi context as a chronological timeline grouped by prompt. Select summaries, earliest/recent prompts and each prompt’s text, thinking and tool records. Defaults select all. Continue next_cursor with the same selectors; sampling omissions differ from capacity pagination.',
  send: 'Send text to the session’s single reusable Pi instance. default maps to steer; idle_only rejects busy sessions; steer and follow_up select native queues. Required stable request_id identifies one submission, not completion. Omit text to recover its receipt. Never replay unknown work under a new ID.',
  command:
    'Execute a native Pi !command, not a model prompt, with independent command permission. Required request_id prevents repeated shell execution. Omit command to recover output; continue next_cursor with the same ID. timeout_ms is an acknowledgement budget, not a shell kill deadline. Unsupported hosts return BASH_UNSUPPORTED.',
  stop: 'Stop current execution and withdraw queued prompts while retaining the session and process. Requires only stop permission and request_id. An existing receipt is replayed without stopping a later run; without one, omitting cursor can execute stop. After a lost response, use the same ID with cursor:"" for receipt-only recovery from the first page; missing receipts return RECEIPT_NOT_FOUND without dispatch. Preserve the empty string, do not drop it with a truthy filter. Continue withdrawn text via next_cursor with the same ID. Unsupported hosts return STOP_UNSUPPORTED.',
  create:
    'Create a session in project (absolute project directory) and send its initial text prompt. Optional name and fork_from copy the parent’s committed tail without switching its owner. Requires target create permission and source read when forking. Omit text only to recover an existing request_id. A partial receipt retains the created session ID and send status.',
  delete:
    'Recoverably move an authorized session to Bridge trash, stopping its owned live runtime. Project files are retained. Repeat request_id to recover the receipt.',
  batch:
    'Wrap 1–10 operations (all tools except batch). Same-session operations execute serially through submission receipts; different sessions run concurrently. Each item keeps its own permissions and recovery semantics. Item failure does not cancel other items.',
  health:
    'Report effective independent grants, their sources and advisory combinations. Optional known session_id adds its permission report. Defaults to the sole permissions domain; does not change authorization.',
};
export const toolNames = [
  'list',
  'read',
  'send',
  'command',
  'stop',
  'create',
  'delete',
  'batch',
  'health',
];
export function objectSchema(schema) {
  while (schema?._def?.typeName === 'ZodEffects') schema = schema.innerType();
  return schema;
}
export function toolDefinitions() {
  return toolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: toJsonSchemaCompat(publicSchemas[name], { pipeStrategy: 'input' }),
  }));
}
export function publicError(error) {
  return /^[A-Z][A-Z_]{2,60}$/.test(error?.message) ? error.message : 'OPERATION_FAILED';
}
export function toolError(code, extra = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, ...extra } }) }],
  };
}
export async function callBridgeTool(
  bridge,
  name,
  input,
  { signal, requestId, execute = (run) => run() } = {},
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
  return execute(async () => {
    try {
      const result = await diagnostics.measure(
        'tool',
        {
          op: name,
          mcp_id_ref: diagnosticRef(requestId),
          mutation_ref: diagnosticRef(args.request_id),
          session_ref: diagnosticRef(args.session_id),
        },
        () =>
          name === 'batch'
            ? executeBatch(bridge, args, { signal })
            : bridge[name](args, { signal }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(
        publicError(error),
        error?.uncertain
          ? { uncertain: true, recovery: 'SAME_REQUEST_ID', request_id: args.request_id }
          : {},
      );
    }
  });
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const modernMessage = (body) =>
  ['protocolVersion', 'clientCapabilities', 'clientInfo'].some(
    (field) => body?.params?._meta?.[META + field] !== undefined,
  ) || body?.method === 'server/discover';
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
export function unsupportedVersion(id, requested) {
  return rpcError(id, -32022, 'Unsupported protocol version', {
    supported: SUPPORTED_VERSIONS,
    requested,
  });
}
// Applies to the entire serialized JSON-RPC envelope, including escaped text
// duplication, metadata and request ID. Never truncates JSON or mutation receipts.
export function boundMessage(message, limit = MCP_RESPONSE_LIMIT) {
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= limit) return message;
  const modern = message.result?.resultType !== undefined;
  const result = toolError('RESPONSE_TOO_LARGE', {
    retry: 'READ_SEPARATELY_OR_RECOVER_WITH_SAME_REQUEST_ID',
  });
  const replacement = {
    jsonrpc: '2.0',
    id: message.id,
    ...(message.result
      ? { result: modern ? complete(result) : result }
      : { error: { code: -32603, message: 'RESPONSE_TOO_LARGE' } }),
  };
  if (Buffer.byteLength(JSON.stringify(replacement), 'utf8') > limit)
    throw new Error('RESPONSE_BUDGET_TOO_SMALL');
  return replacement;
}
export async function dispatchModern(bridge, body, options = {}) {
  const id = body?.id;
  if (
    !object(body) ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string' ||
    !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) ||
    (typeof id === 'string' && Buffer.byteLength(id) > 1024)
  )
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
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: 'private',
      };
      break;
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
  return { status: 200, message: boundMessage({ jsonrpc: '2.0', id, result: complete(result) }) };
}

// Modern HTTP bindings require mirrored fields; reject duplicate headers too.
// No x-mcp-header tool parameters are advertised.
export function validateModernHeaders(body, getHeaders) {
  const expected = {
    'mcp-protocol-version': body?.params?._meta?.[META + 'protocolVersion'],
    'mcp-method': body?.method,
  };
  if (['tools/call', 'prompts/get', 'resources/read'].includes(body?.method))
    expected['mcp-name'] = body?.params?.[body.method === 'resources/read' ? 'uri' : 'name'];
  for (const [name, value] of Object.entries(expected)) {
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
