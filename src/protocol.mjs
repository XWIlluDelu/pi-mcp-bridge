import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import packageInfo from '../package.json' with { type: 'json' };
import { publicSchemas, publicOutputSchemas, publicAnnotations } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { publicError } from './errors.mjs';
import { EventError } from './events.mjs';

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
  models:
    'List the owner’s native configured model catalog without network refresh or loading sessions/extensions. Requires effective send/command/create on a configured project, or send/command on an in-scope session. Returns models and next_offset; each model has only provider, id, name, input, context_window and effort (supported thinking levels). Null metadata means unknown. Excludes models registered only by extensions or live sessions. Use list.status for current session settings and set_model to change them.',
  set_model:
    'Change a session’s model and/or thinking_level without sending a prompt. Requires send permission and at least one setting. Model-only changes preserve current effort with Pi’s compatible fallback if unsupported. Busy sessions are supported: issued provider requests keep their selection; later calls use the current choice. Returns actual model and thinking_level, including native adjustment. May cold-resume a saved session; unsupported owners reject. Global defaults stay unchanged. An uncertain error may follow a partial change; inspect list.status before another call.',
  compact:
    'Compact native context with send permission and proven-idle admission. Explicit interrupt:true additionally requires stop and may abort the agent even if compaction fails; it does not withdraw queues. Ordinary companions and supplied host bindings require explicit interrupt because they cannot prove idle admission. Returns completion metadata; summary text requires read. Timeout leaves the outcome unknown: inspect list/read before submitting another compaction.',
  list: 'List authorized sessions with project, name, activity and sampled runtime status. Filters combine; newest activity first. Live model/thinking values are null when unobserved. Never starts Pi. The independent creatable_projects catalog includes configured destinations with project-level list and create permission, including empty projects, regardless of session filters or pagination. A known hidden destination remains usable with create permission. Listing requires no read permission.',
  read: 'Understand a Pi session, then expand useful evidence. read({session_id}) returns a brief latest task/result, summaries and compact tool activity with refs; preset:recent adds three prompts, full covers the whole effective source. Default routing uses an enabled matching reader (for example memory); view:session forces Session Context, view:runtime reads a captured Runtime Context. read({refs:[...]}) expands up to eight references from one snapshot; source_context references open historical session context. Use search to locate text beyond a preview. detail:full returns selected source units directly. Continue with cursor alone, optionally changing max_bytes. Runtime captures have a capture time and may precede the latest answer; they do not accept preset/select/leaf_id. Reading never starts Pi, calls a model or reruns hooks. References/cursors are bounded and can become stale; fresh read/search obtains new ones.',
  search:
    'Find evidence inside one authorized Pi session using case-insensitive literal text. Searches the selected reader’s full effective content, not only previously returned pages. Default routing matches read; view:session searches Session Context, view:runtime searches the captured Runtime Context. Optional types filters returned item kinds. Returns matching snippets and refs for read({refs:[...]}). Continue search results with read({cursor:...}). Does not search other sessions or reconstruct content absent from the source, and never starts Pi or calls a model.',
  send: 'Submit text and/or native images with send permission. Images require an image-capable owner and base64 PNG/JPEG/GIF/WebP blocks, at most 5 MiB decoded total. default steers while busy; idle_only skips busy input; steer and follow_up use native queues. Explicit model/thinking settings require proven-idle Bridge-owned RPC and may add verified model_selection. Returns submission_id with the admission outcome, not model completion. started/queued/handled are native acknowledgements; dispatched with admission:unobservable confirms an external owner invoked Pi without an admission callback. unknown means dispatch/outcome is uncertain: query submission with the returned ID for a late ACK. Every send is new input, including identical calls; do not automatically resubmit.',
  submission:
    'Look up one send/create admission receipt by session_id and submission_id, without starting or contacting Pi. Late native RPC acknowledgements update the same receipt. Requires current read/send permission, or create permission for that create receipt. Metadata only: no prompt/output, per-prompt completion, deduplication or replay. Records last at most one hour, bounded to the newest 256 submissions, and disappear on Bridge restart. SUBMISSION_UNAVAILABLE does not mean the input failed. Use list for current session activity and read for content; session.settled events provide a leaf_id to read a fixed run boundary.',
  command:
    'Execute a native Pi shell command with independent command permission; omit the leading !. Returns captured output and native result metadata. native_truncated reports Pi’s own truncation; response_complete reports whether Bridge returned all of that native output, not whether the command completed. A shortened response is a prefix with no continuation; use read with command selection for native history. Internal acknowledgement expiry does not kill the shell. Unsupported owners return BASH_UNSUPPORTED. Every call executes again; do not automatically retry an unknown outcome.',
  stop: 'Cancel current execution and withdraw queued input with stop permission, retaining saved history. Never cold-starts Pi. Returns withdrawn_text and withdrawn_complete:false if shortened, with no continuation. Already-dispatched native input hooks may continue after cancellation. External owners stay open; idle owned RPCs may release normally. Unsupported owners return STOP_UNSUPPORTED. Each call acts on current work, so repeating it can interrupt a later run.',
  create:
    'Create a session in an exact configured absolute project path and send initial text and/or images. Image and model/thinking rules match send. Optional fork_from copies the parent’s committed branch without switching its owner. Requires target create permission and source read for a fork. Retains the chosen child session_id and nested send outcome after partial failure; submission_id identifies the initial send receipt when available. Query submission for a late native ACK. Each create makes another session; do not automatically recreate after an unknown result.',
  delete:
    'With delete permission, interrupt the target writer and move the session to recoverable Bridge trash, including during release or handoff. Project files remain. Returns a restore_token for owner-managed recovery; there is no remote restore or result lookup. Each call is another deletion attempt.',
  batch:
    'Run 1–10 operations as {op,args}, for example {"operations":[{"op":"list","args":{}}]}. Supports every tool except batch. Same-session items run in order through their normal return boundary, not model completion; different sessions run concurrently. Each item needs its own permissions. Results retain input order, and an item failure does not cancel later items. Shared response budgets may shorten output/query pages with completeness flags or cursors; mutation results are retained. Repeating a batch repeats its mutations.',
  health:
    'Report noteworthy permission combinations and source rules; healthy configurations return a short ok result. Optional known session_id limits diagnosis without exposing session metadata. Unscoped health also reports fixed setting names awaiting restart and unavailable event storage. Does not change grants or block core operations.',
};
export const toolNames = [
  'list',
  'read',
  'search',
  'models',
  'set_model',
  'compact',
  'send',
  'submission',
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
    ...(publicOutputSchemas[name]
      ? {
          annotations: publicAnnotations[name],
          outputSchema: toJsonSchemaCompat(publicOutputSchemas[name], { pipeStrategy: 'output' }),
        }
      : {}),
  }));
}
export function toolError(code, extra = {}) {
  const result = {
    error: {
      code,
      ...(code === 'OWNER_READ_REFRESH_REQUIRED'
        ? {
            recovery:
              'Update the session owner companion at an idle boundary (native /reload where supported), then retry read. Changing read arguments will not refresh the owner.',
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
