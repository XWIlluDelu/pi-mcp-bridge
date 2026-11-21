import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

import { isOwnerMutation, knownErrorCode } from './errors.mjs';

const enums = {
  method: [
    'ping',
    'server/discover',
    'tools/list',
    'tools/call',
    'events/list',
    'events/subscribe',
    'events/unsubscribe',
  ],
  rpc_status: ['result', 'error'],
  callback_reason: [
    'connection_refused',
    'timeout',
    'tls_error',
    'http_4xx',
    'http_5xx',
    'challenge_failed',
    'blocked_address',
    'response_too_large',
  ],
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
    'set_thinking_level',
    'get_available_models',
    'health',
    'list',
    'list_sessions',
    'read',
    'update_session',
    'maintain_session',
    'submission',
    'command',
    'create',
    'create_session',
    'delete',
    'delete_session',
    'batch',
    'read_features',
    'snapshot',
    'get_state',
    'get_entries',
    'prompt',
    'abort',
    'abort_bash',
    'clear_queue',
  ],
  status: [
    'ok',
    'warning',
    'error',
    'accepted',
    'completed',
    'dispatched',
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
  mode: ['steer', 'follow_up', 'idle_only'],
};
const reference = /^[a-f0-9]{24}$/;
const refs = ['mcp_id_ref', 'session_ref'];
const formats = {
  mcp_id_ref: reference,
  session_ref: reference,
  callback_hostname: /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?[.]?$/,
  generation: /^[a-f0-9-]{36}$/,
};
const numbers = ['duration_ms', 'http_status', 'index'];
const flags = ['uncertain', 'late', 'allowed', 'response_finished'];

function approvedField(key, value) {
  if (key === 'op' && isOwnerMutation(value)) return true;
  if (Object.hasOwn(enums, key)) return enums[key].includes(value);
  if (numbers.includes(key)) return Number.isFinite(value);
  if (flags.includes(key)) return typeof value === 'boolean';
  if (key === 'rpc_code') return Number.isInteger(value) && value >= -32768 && value <= -32000;
  return typeof value === 'string' && Object.hasOwn(formats, key) && formats[key].test(value);
}

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
      if (key === 'code' && value !== undefined)
        record.code = value === 'busy' ? value : knownErrorCode(value, 'OTHER_ERROR');
      else if (approvedField(key, value)) record[key] = value;
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
    for (const key of refs) if (approvedField(key, fields[key])) next[key] = fields[key];
    return context.run(next, fn);
  }
  async function measure(stage, fields, fn) {
    if (!enabled) return fn();
    return withContext(fields, async () => {
      const started = performance.now();
      emit(stage + '.start', fields);
      let outcome;
      try {
        const result = await fn();
        outcome = {
          status: result?.status ?? 'ok',
          disposition: result?.disposition,
          code: result?.reason,
        };
        return result;
      } catch (error) {
        outcome = {
          status: 'error',
          code: error.code ?? error.message,
          uncertain: error.uncertain === true,
        };
        throw error;
      } finally {
        emit(stage + '.end', { ...fields, ...outcome, duration_ms: performance.now() - started });
      }
    });
  }
  function bind(fn) {
    const captured = context.getStore();
    return (...args) => context.run(captured, () => fn(...args));
  }
  return { emit, measure, withContext, capture: () => bind(emit), bind };
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
