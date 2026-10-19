import { batchSchema, publicOperationSchemas } from './tool-schemas.mjs';
import { rebudgetContextRead } from './context-read.mjs';
import { TOOL_RESULT_LIMIT, toolResultBytes } from './response-budget.mjs';

export const BATCH_RESPONSE_LIMIT = 196608; // UTF-8 bytes, inside the MCP envelope.
export const BATCH_INPUT_LIMIT = 6100000;
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const code = (error) =>
  /^[A-Z][A-Z_]{2,60}$/.test(error.message) ? error.message : 'OPERATION_FAILED';

export function preflightBatch(input) {
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success)
    return { error: { status: 'rejected', error: { code: 'INVALID_BATCH' }, results: [] } };
  if (size(input) > BATCH_INPUT_LIMIT)
    return { error: { status: 'rejected', error: { code: 'BATCH_INPUT_TOO_LARGE' }, results: [] } };
  return { operations: parsed.data.operations };
}

export async function executeBatch(bridge, input, { signal } = {}) {
  const { operations, error } = preflightBatch(input);
  if (error) return error;
  const lanes = new Map(),
    results = new Array(operations.length);
  const jobs = operations.map((item, index) => {
    const op = item?.op,
      schema = Object.hasOwn(publicOperationSchemas, op) ? publicOperationSchemas[op] : null;
    const parsed = schema?.safeParse(item?.args);
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['op', 'args'].includes(key)) ||
      !parsed?.success
    ) {
      results[index] = {
        index,
        op: typeof op === 'string' ? op.slice(0, 64) : null,
        error: {
          code: 'INVALID_OPERATION',
          ...(typeof op === 'string' && op.length > 64 ? { op_truncated: true } : {}),
        },
      };
      return Promise.resolve();
    }
    const args = parsed.data;
    // Creates with a source share its lane so a preceding parent mutation/read
    // has the same ordering as standalone operations. Independent creates share
    // the project's creation lane; no additional authorization is introduced.
    const lane =
      args.session_id ??
      args.fork_from ??
      (op === 'create' ? `project:${args.project}` : `independent:${index}`);
    const previous = lanes.get(lane) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        try {
          results[index] = {
            index,
            op,
            result: structuredClone(await bridge[op](args, { signal })),
          };
        } catch (error) {
          results[index] = {
            index,
            op,
            error: {
              code: code(error),
              ...(error?.uncertain
                ? { uncertain: true, recovery: 'SAME_REQUEST_ID', request_id: args.request_id }
                : {}),
            },
          };
        }
      });
    lanes.set(lane, job);
    return job;
  });
  await Promise.all(jobs);
  const response = { status: 'processed', response_max_bytes: BATCH_RESPONSE_LIMIT, results };
  // Resize captured reads, never reread after a later mutation. Account for
  // JSON escaping and text/structured duplication, not just the inner object.
  while (size(response) > BATCH_RESPONSE_LIMIT || toolResultBytes(response) > TOOL_RESULT_LIMIT) {
    const largest = results
      .filter((item) => item.result !== undefined)
      .sort((a, b) => size(b.result) - size(a.result))[0];
    if (!largest) throw new Error('BATCH_RESPONSE_LIMIT');
    if (largest.op === 'read') {
      const current = size(largest.result),
        smaller = rebudgetContextRead(
          largest.result,
          operations[largest.index].args,
          Math.floor(current * 0.65),
        );
      if (smaller && size(smaller) < current) {
        largest.result = smaller;
        continue;
      }
    }
    delete largest.result;
    const args = operations[largest.index].args;
    const mutation = ['send', 'command', 'stop', 'create', 'delete'].includes(largest.op);
    largest.recovery = {
      ...(mutation ? { request_id: args.request_id } : {}),
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.project ? { project: args.project } : {}),
    };
    largest.error = {
      code: 'BATCH_RESULT_OMITTED',
      retry: mutation ? 'SAME_REQUEST_ID' : 'READ_SEPARATELY',
    };
  }
  return response;
}
