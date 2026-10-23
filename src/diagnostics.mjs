import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

import { knownErrorCode } from './errors.mjs';

const enums = {
  catalog_stage: [
    'modules',
    'storage',
    'runtime',
    'configuration',
    'projection',
    'subprocess',
    'response',
  ],
  catalog_reason: [
    'invalid_json',
    'permission_denied',
    'not_found',
    'native_failure',
    'invalid_configuration',
    'timeout',
    'process_failed',
    'invalid_response',
    'output_limit',
  ],
  ui_method: ['confirm', 'select', 'input', 'editor'],
  op: [
    'state',
    'models',
    'set_model',
    'set_thinking_level',
    'get_available_models',
    'get_available_thinking_levels',
    'compact',
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
    'warning',
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
const refs = new Set(['mcp_id_ref', 'session_ref']);
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
        record.code = value === 'busy' ? value : knownErrorCode(value, 'OTHER_ERROR');
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
