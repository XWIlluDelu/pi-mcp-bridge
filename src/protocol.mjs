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
  compact:
    'Manually compact through native Pi. Defaults to idle-only with send permission; refuses busy or unproven idle. Only explicit interrupt:true permits native abort-before-compaction and additionally requires stop permission. An interrupting call may abort the agent even if summarization later fails. It does not emulate stop-all or withdraw queues. Owned RPC supports idle compact; companions and supplied SDK/RPC bindings support explicit interrupt and reject unconfirmed idle without aborting. Returns bounded completion metadata, never summary text; use read for the native summary. Timeout means unknown; inspect list/read before deciding whether to submit again. Each call is a new operation. Native stop can cancel compaction where supported; no arbitrary slash command execution.',
  list: 'List authorized Pi sessions with project, name, recent activity and coarse runtime status, including current model identity and thinking_level when observed from a live owner (otherwise null). Never starts a runtime. creatable_projects contains only configured create-permitted projects represented on the returned page, deduplicated. It does not limit create targets. Filters combine; newest activity first. list permission is independent of read.',
  read: 'Read the effective Pi context as a chronological timeline grouped by prompt. Defaults to latest: last prompt, all assistant text and first/last 2 thinking blocks, without summary, extra earliest prompts, tool units or commands. preset:recent includes active summaries and last 3 prompts with first/last 3 thinking blocks; preset:full selects all. select overrides individual fields. Tool units include call arguments and paired result output, sampled first/last N per selected prompt. Returns sanitized readable units, not JSON fragments; images are honest descriptors without base64. Continue with cursor alone: session, selection and frozen leaf are inherited; explicit conflicting overrides reject. max_bytes may change. READ_BUDGET_TOO_SMALL asks for minimum_max_bytes; indivisible content larger than the maximum page is explicitly omitted. Sampling omissions differ from capacity pagination; live is transient and incomplete.',
  send: 'Send text and/or native images to the session’s native Pi owner. images are base64 PNG/JPEG/GIF/WebP blocks; no fixed image-count cap, total decoded size at most 5 MiB. Requires an image-capable model and owner. Optional model:{provider,id} and/or thinking_level apply session settings immediately before the prompt. Busy/queued/unsupported owners reject explicit settings; omitted fields follow native session behavior. default maps to steer; idle_only rejects busy sessions; steer and follow_up select native queues. Text or images are required. Returns status:started|queued|handled|skipped|rejected|unknown and reason only when needed, not model completion. Explicit settings may add verified model_selection:{model:{provider,id},thinking_level}; no requested/scope/status/actual wrapper. Every call is a new submission; no deduplication or result lookup. If unknown, inspect list/read before deciding whether to submit again.',
  command:
    'Execute a native Pi !command, not a model prompt, with independent command permission. command is required and every call executes a new operation. Returns bounded output with output_complete:false if cut short; no continuation or result lookup. Inspect list/read after an unknown outcome, do not automatically resubmit. timeout_ms is an acknowledgement budget, not a shell kill deadline. Unsupported hosts return BASH_UNSUPPORTED.',
  stop: 'Stop current execution and withdraw queued prompts while retaining saved history. A completed Bridge-owned prompt runtime may then release normally; external owners stay open. Requires only stop permission. Each call performs a new stop; never cold-starts Pi. Returns bounded withdrawn text with withdrawn_complete:false if cut short; no continuation or result lookup. Unsupported hosts return STOP_UNSUPPORTED.',
  create:
    'Create a session in project (absolute project directory) and send initial text and/or images. Images and optional model:{provider,id} and/or thinking_level use the same rules as send, including the first prompt. Optional name and fork_from copy the parent’s committed tail without switching its owner. Requires target create permission and source read when forking. Text or images are required. A partial result retains the created session ID and send status. Each call creates a new session; after an unknown result inspect list/read, do not automatically resubmit.',
  delete:
    'Recoverably move an authorized session to Bridge trash, stopping its owned live runtime. Project files are retained. Each call is a new deletion attempt; there is no result lookup.',
  batch:
    'Wrap 1–10 operations (all tools except batch). Same-session operations execute serially through submission results; different sessions run concurrently. Each item keeps its own permissions. Every mutation item is a new operation, including in repeated batches; no outer replay or deduplication. Item failure does not cancel other items. Results share preallocated UTF-8/JSON/wire budgets: command/stop may return a smaller prefix than max_chars, with accurate completeness flags; auxiliary command.fullOutputPath/delete.project may be omitted. Captured query pages may shrink or explicitly refuse; mutation results are retained.',
  health:
    'Report noteworthy permission combinations and the relevant source rules, deduplicating inherited issues. Healthy configurations return a short ok result, not normal permission tables. Optional known session_id limits diagnosis to that session without exposing its metadata. Takes no domain selector; does not change authorization.',
};
export const toolNames = [
  'list',
  'read',
  'compact',
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
  const context = bridge.captureRequestContext?.();
  // A delayed/rejected executor must not leave an early policy failure unhandled.
  void context?.catch(() => {});
  return execute(async () => {
    try {
      // Input methods register their existing Stop fence before awaiting policy I/O.
      const requestContext = context;
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(
        publicError(error),
        error?.minimum_max_bytes
          ? { minimum_max_bytes: error.minimum_max_bytes }
          : error?.uncertain
            ? {
                uncertain: true,
                recovery:
                  'OUTCOME_UNKNOWN; inspect list/read before deciding whether to submit again. No automatic replay.',
              }
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
// duplication, metadata and request ID. Never truncates JSON.
export function boundMessage(message, limit = MCP_RESPONSE_LIMIT) {
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') <= limit) return message;
  const modern = message.result?.resultType !== undefined;
  const result = toolError('RESPONSE_TOO_LARGE', {
    recovery:
      'OUTCOME_UNKNOWN; inspect list/read or request a smaller read. Do not automatically resubmit mutations.',
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
