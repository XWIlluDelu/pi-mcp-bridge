import { z } from 'zod';
import packageInfo from '../package.json' with { type: 'json' };
import { publicSchemas, publicOutputSchemas, publicAnnotations } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { publicError } from './errors.mjs';
import { EventError } from './events.mjs';

export const MODERN_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [MODERN_VERSION];
const SERVER_INFO = { name: 'pi-session-bridge', version: packageInfo.version };
export const META = 'io.modelcontextprotocol/';
import { MCP_RESPONSE_LIMIT } from './response-budget.mjs';
export const MCP_INPUT_LIMIT = 8 * 1024 * 1024;
// Descriptions state the permission, the outcome contract and retry safety.
// Detailed semantics live in docs/api.md and in error recovery hints.
const descriptions = {
  list: 'List authorized sessions, newest activity first, with project, name and sampled runtime status (state, model, thinking level, capabilities). Filters combine. Also returns creatable_projects for create. Requires list permission; never starts Pi.',
  read: 'Read a Pi session in source order; requires read and never starts Pi. Default: the last three input turns with input, all assistant text, the latest thinking and one tool operation per turn. range:{recent,earliest} selects turns (-1 = all); content sets per-kind counts. Items carry refs: read({refs:[...]}) expands up to eight from one result. Continue with read({cursor}), optionally changing max_bytes. Omit view for the session’s default source; where a configured reader applies, results add stored summaries/memories as view:"adapted" with reader.coverage counts. view:"session" forces native context; view:"runtime" reads the captured request context. Stale cursors or refs need a fresh read.',
  search:
    'Find case-insensitive literal text in one session’s full effective context, beyond the default read selection; requires read and never starts Pi. Optional content restricts kinds (input, assistant, thinking, tool, summary, memory, system, command, native); view routes as in read. Returns snippets with refs for read({refs}); continue with read({cursor}).',
  models:
    'List the owner’s configured native model catalog without network refresh. Requires send, command or create on a configured project, or send/command on an in-scope session. Each model has provider, id, name, input, context_window and thinking_levels. Use list.status for a session’s current settings.',
  set_model:
    'Change a session’s model and/or thinking_level without sending a prompt; requires send. Works while busy: in-flight provider requests keep their selection. Returns the actual model and thinking_level after native adjustment. May cold-resume a saved session. An uncertain error may follow a partial change; check list.status before retrying.',
  compact:
    'Run native context compaction; requires send and a proven-idle session. interrupt:true also requires stop and may abort current work even if compaction fails. Returns status:completed with compaction metadata; read the summary with read. On timeout the outcome is unknown: check list/read before compacting again.',
  reload:
    'Reload Pi resources (extensions, settings) for an idle active owner; requires send. Preserves history and resets extension-local state. Returns completed with owner_version and read_compatible, rejected/RELOAD_BUSY while work is active, skipped/no_active_owner when nothing runs, or unknown/RELOAD_UNCONFIRMED (check list/read before retrying). Never interrupts or queues work.',
  send: 'Submit text and/or base64 images (PNG, JPEG, GIF, WebP; at most 32 images and 5 MiB decoded) to a session; requires send. mode: steer (default; starts when idle, steers when busy), follow_up (queues after current work) or idle_only (skips when busy). model/thinking_level require a proven-idle Bridge-owned RPC. Returns submission_id and the admission status, not model completion: started/queued/handled are native acknowledgements; dispatched means an external owner received it without admission evidence; unknown is uncertain, so query submission for a late acknowledgement. Every call is new input; never resubmit automatically.',
  submission:
    'Look up one send/create admission receipt by session_id and submission_id without contacting Pi; late native acknowledgements update it. Requires read or send, or create for a create receipt. Receipts hold status only, last at most one hour (newest 256) and are lost on restart; SUBMISSION_UNAVAILABLE does not mean the input failed.',
  command:
    'Run a shell command through Pi’s native bash path (omit the leading !); requires command. Returns status:completed with output, exitCode and cancelled once it ends. native_truncated reports Pi’s own truncation; response_complete:false means Bridge shortened the output to max_chars, with no continuation. Every call executes again; never retry an unknown outcome automatically.',
  stop: 'Cancel current execution and withdraw queued input; requires stop and never starts Pi. Returns withdrawn_text, with withdrawn_complete:false if shortened. Each call acts on whatever runs now, so repeating it can interrupt later work.',
  create:
    'Create a saved session in a configured project path (see list.creatable_projects); requires create. Optional text/images submit the first prompt with the same rules as send; without them no agent runs. fork_from copies a parent’s committed branch and also requires read on it. Returns the new session_id even after a partial failure, plus the nested send status and submission_id when prompted. Each call creates another session; never recreate automatically after unknown.',
  delete:
    'Interrupt the writer and move the session to recoverable trash; requires delete. Project files are untouched. Returns a restore_token for owner-side recovery. Each call is a new deletion attempt.',
  batch:
    'Run 1–10 operations of other tools as {op,args}, e.g. {"operations":[{"op":"list","args":{}}]}. Same-session items run in order and other sessions concurrently; each item needs its own permissions and fails independently. Results keep input order. A shared response budget may shorten query pages (with cursors) or command output (with completeness flags). Repeating a batch repeats its mutations.',
  health:
    'Diagnose the permission configuration; a healthy setup returns a short ok. Optional session_id limits the diagnosis to that session. Unscoped calls also report settings awaiting restart and unavailable event storage. Changes nothing.',
};
const toolNames = Object.keys(descriptions);
export function toolDefinitions() {
  return toolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(publicSchemas[name], { target: 'draft-7', io: 'input' }),
    ...(publicAnnotations[name] ? { annotations: publicAnnotations[name] } : {}),
    ...(publicOutputSchemas[name]
      ? {
          outputSchema: z.toJSONSchema(publicOutputSchemas[name], { target: 'draft-7' }),
        }
      : {}),
  }));
}
function toolError(code, extra = {}) {
  const result = {
    error: {
      code,
      ...(code === 'OWNER_READ_REFRESH_REQUIRED'
        ? {
            recovery:
              'Call reload for this session at an idle boundary, then retry read. If reload is unsupported, update the configured companion and use native /reload or a host-managed reopen once. Changing read arguments will not refresh the owner.',
          }
        : ['ATTACHMENT_PROTOCOL_MISMATCH', 'OWNER_COMPONENT_UPDATE_REQUIRED'].includes(code)
          ? {
              recovery:
                'Update Bridge and the session owner component together; use a safe native reload at an idle boundary where supported. Do not delete a live claim or start a fallback writer.',
            }
          : {}),
      ...extra,
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
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
    requested,
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
