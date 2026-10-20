import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

const codes = new Set([
  'IMAGE_INPUT_UNSUPPORTED',
  'MODEL_IMAGE_INPUT_UNSUPPORTED',
  'MODEL_SELECTION_UNSUPPORTED',
  'MODEL_SELECTION_PENDING',
  'MODEL_SELECTION_BUSY',
  'MODEL_SELECTION_IDLE_UNCONFIRMED',
  'MODEL_SELECTION_FAILED',
  'MODEL_SELECTION_CHANGED',
  'MODEL_UNAVAILABLE',
  'THINKING_LEVEL_UNSUPPORTED',
  'THINKING_SUPPORT_UNKNOWN',
  'MODEL_REQUIRES_PROMPT',
  'MODELS_UNSUPPORTED',
  'COMPACT_UNSUPPORTED',
  'COMPACTION_PENDING',
  'INVALID_COMPACT_RESULT',
  'COMPACT_BUSY',
  'COMPACT_IDLE_UNCONFIRMED',
  'RELOAD_BUSY',
  'RELOAD_IDLE_UNCONFIRMED',
  'RELOAD_NOT_RUNNING',
  'RELOAD_UNSUPPORTED',
  'RELOAD_OWNER_CHANGED',
  'RECOVERY_PERSIST_FAILED',
  'HOST_RELEASE_UNSUPPORTED',
  'HOST_RELEASE_FAILED',
  'HOST_NOT_READY',
  'HOST_SUBMIT_UNCERTAIN',
  'NOT_FOUND_OR_DENIED',
  'ACK_TIMEOUT',
  'WRITE_UNKNOWN',
  'RUNTIME_DISCONNECTED',
  'RUNTIME_START_FAILED',
  'PI_EXECUTABLE_NOT_FOUND',
  'PI_EXECUTABLE_NOT_EXECUTABLE',
  'RUNTIME_STOP_FAILED',
  'RUNTIME_SESSION_CHANGED',
  'LIVE_OWNER_UNREACHABLE',
  'PROMPT_ADMISSION_PENDING',
  'PI_REJECTED',
  'ATTACHMENT_REQUEST_TOO_LARGE',
  'REQUEST_ID_CONFLICT',
  'RECEIPT_NOT_FOUND',
  'CONFIG_RESTART_REQUIRED',
  'INVALID_OWNER_CONFIG',
  'STALE_CURSOR',
  'ENTRY_NOT_FOUND',
  'BRIDGE_CLOSING',
  'ENOENT',
  'EPIPE',
  'ECONNRESET',
  'ECONNREFUSED',
  'REQUEST_NOT_ADMITTED',
  'PI_ACCEPTANCE_UNOBSERVABLE',
  'OWNER_STILL_ALIVE',
  'ATTACHMENT_REGISTRY_BUSY',
  'SESSION_FILE_ALIAS_NOT_ALLOWED',
  'SESSION_TOO_LARGE',
  'EXECUTION_CWD_UNAVAILABLE',
  'INVALID_SESSION',
  'INVALID_SESSION_TREE',
  'INVALID_SESSION_HEADER',
  'INVALID_TRASH_DIRECTORY',
  'TRASH_FILESYSTEM_MISMATCH',
  'EXDEV',
  'EACCES',
  'EIO',
  'INVALID_RUNTIME_ENTRIES',
  'INVALID_ATTACHMENT_RECORD',
  'INVALID_ATTACHMENT_RESPONSE',
  'PROCESS_IDENTITY_UNAVAILABLE',
  'busy',
  'STOP_UNSUPPORTED',
  'STOP_IN_PROGRESS',
  'RECEIPT_PERSIST_FAILED',
  'INVALID_STOP_RECEIPT',
  'WITHDRAWAL_RECOVERY_MISSING',
  'BASH_UNSUPPORTED',
  'BASH_IN_PROGRESS',
  'INVALID_BASH_RESULT',
  'BASH_RECOVERY_MISSING',
  'HANDOFF_PENDING',
  'HANDOFF_CANCELLED',
  'HANDOFF_REQUESTER_GONE',
  'COLD_REACQUIRE_BLOCKED',
  'RUNTIME_BUSY',
  'RUNTIME_IDLE_UNCONFIRMED',
  'RUNTIME_SHUTTING_DOWN',
  'RUNTIME_EXIT_ABNORMAL',
  'OWNER_READ_REFRESH_REQUIRED',
  'INVALID_READ_ARGUMENTS',
  'INVALID_CURSOR',
]);
const enums = {
  op: [
    'state',
    'models',
    'set_model',
    'set_thinking_level',
    'get_available_models',
    'get_available_thinking_levels',
    'compact',
    'reload',
    'health',
    'list',
    'read',
    'send',
    'stop',
    'bash',
    'command',
    'create',
    'delete',
    'batch',
    'new_session',
    'get_state',
    'get_entries',
    'prompt',
    'abort',
    'abort_bash',
    'clear_queue',
    'shutdown',
    'release',
  ],
  status: [
    'ok',
    'error',
    'accepted',
    'unknown',
    'rejected',
    'skipped',
    'created',
    'deleted',
    'processed',
  ],
  kind: ['saved', 'rpc', 'attached'],
  transport: ['stdio', 'http'],
  disposition: ['started', 'queued', 'handled'],
  mode: ['default', 'idle_only', 'steer', 'follow_up'],
};
const refs = new Set(['mutation_ref', 'mcp_id_ref', 'session_ref']);
export const diagnosticRef = (value) =>
  value === undefined
    ? undefined
    : createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function createDiagnostics({ enabled = false, write = () => {} } = {}) {
  const context = new AsyncLocalStorage(),
    runId = randomUUID();
  function emit(event, fields = {}) {
    if (!enabled) return;
    const record = {
      time: new Date().toISOString(),
      run_id: runId,
      pid: process.pid,
      event,
      ...context.getStore(),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (enums[key]?.includes(value) || (refs.has(key) && /^[a-f0-9]{24}$/.test(value)))
        record[key] = value;
      else if (['duration_ms', 'http_status', 'index'].includes(key) && Number.isFinite(value))
        record[key] = value;
      else if (
        ['uncertain', 'late', 'allowed', 'response_finished'].includes(key) &&
        typeof value === 'boolean'
      )
        record[key] = value;
      else if (key === 'generation' && typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value))
        record[key] = value;
      else if (key === 'code' && value !== undefined)
        record.code = codes.has(value) ? value : 'OTHER_ERROR';
    }
    try {
      write(JSON.stringify(record) + '\n');
    } catch {
      /* Diagnostics must not affect operations. */
    }
  }
  function withContext(fields, fn) {
    if (!enabled) return fn();
    // Only internal trace/correlation fields enter ambient context.
    const next = { ...context.getStore(), trace_id: context.getStore()?.trace_id ?? randomUUID() };
    for (const key of refs) if (/^[a-f0-9]{24}$/.test(fields[key] ?? '')) next[key] = fields[key];
    return context.run(next, fn);
  }
  async function measure(stage, fields, fn) {
    if (!enabled) return fn();
    return withContext(fields, async () => {
      const started = performance.now();
      emit(stage + '.start', fields);
      try {
        const result = await fn();
        emit(stage + '.end', {
          ...fields,
          duration_ms: performance.now() - started,
          status: result?.status ?? 'ok',
          disposition: result?.disposition,
          code: result?.reason,
        });
        return result;
      } catch (error) {
        emit(stage + '.end', {
          ...fields,
          duration_ms: performance.now() - started,
          status: 'error',
          code: error.code ?? error.message,
          uncertain: error.uncertain === true,
        });
        throw error;
      }
    });
  }
  function capture() {
    const captured = context.getStore();
    return (event, fields) => context.run(captured, () => emit(event, fields));
  }
  function bind(fn) {
    const captured = context.getStore();
    return (...args) => context.run(captured, () => fn(...args));
  }
  return { emit, measure, withContext, capture, bind };
}
const enabled = process.env.PI_MCP_LOG === '1';
if (enabled) process.stderr.on('error', () => {});
export const diagnostics = createDiagnostics({
  enabled,
  write: (line) => {
    // Bound queued diagnostic output if the collector stalls; never block a tool.
    if (!process.stderr.destroyed && process.stderr.writableLength < 65536)
      process.stderr.write(line);
  },
});
