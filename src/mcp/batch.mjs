import {
  batchOperationSchema,
  inputOperations,
  publicOperationSchemas,
  publicAnnotations,
} from './tool-schemas.mjs';
import {
  TOOL_RESULT_LIMIT,
  resultSize,
  fitsResult,
  largestFittingSize,
} from './response-budget.mjs';
import { toolFailure } from '../core/errors.mjs';

const BATCH_RESPONSE_LIMIT = 196608; // UTF-8 bytes, inside the MCP envelope.
const envelope = (results) => ({
  status: 'processed',
  response_max_bytes: BATCH_RESPONSE_LIMIT,
  results,
});

function itemBudget(operations) {
  const frame = resultSize(envelope(operations.map(() => null)));
  const empty = resultSize(null);
  const bytes = Math.floor((BATCH_RESPONSE_LIMIT - frame.bytes) / operations.length);
  const wire = Math.floor((TOOL_RESULT_LIMIT - frame.wireBytes) / operations.length);
  // Replace the null placeholders in both the batch envelope and the item wrapper.
  return (index, op) => {
    const wrapper = resultSize({ index, op, result: null });
    return {
      maxBytes: bytes + 2 * empty.bytes - wrapper.bytes,
      maxWireBytes: wire + 2 * empty.wireBytes - wrapper.wireBytes,
    };
  };
}

function fitQuery(op, result, args, budget) {
  if (fitsResult(result, budget)) return result;
  if (op === 'models' || op === 'list') {
    const key = op === 'models' ? 'models' : 'sessions',
      rows = result[key];
    const page = (count) => ({
      ...result,
      [key]: rows.slice(0, count),
      next_offset: (args.offset ?? 0) + count,
    });
    const count = largestFittingSize(rows.length - 1, (size) => fitsResult(page(size), budget));
    if (count) return page(count);
  }
  throw new Error('BATCH_QUERY_BUDGET_TOO_SMALL');
}

// Callers validate the outer batch shape; malformed items are retained for
// per-item errors and validated here against their own operation schema.
export async function executeBatch(bridge, { operations }, { requestContext } = {}) {
  const budgetFor = itemBudget(operations);
  requestContext ??= bridge.captureRequestContext();
  void requestContext.catch(() => {});
  const lanes = new Map(),
    readPins = [],
    inputs = new Set();
  const jobs = operations.map((item, index) => {
    const op = item?.op;
    const shape = batchOperationSchema.safeParse(item);
    const parsed = shape.success && publicOperationSchemas[op].safeParse(shape.data.args);
    if (!parsed?.success)
      return {
        index,
        op: typeof op === 'string' ? op.slice(0, 64) : null,
        error: {
          code: 'INVALID_OPERATION',
          ...(typeof op === 'string' && op.length > 64 ? { op_truncated: true } : {}),
        },
      };
    const args = parsed.data;
    let sessionId = args.session_id;
    try {
      if (op === 'read' && !sessionId && (args.cursor || args.refs))
        sessionId = bridge.readCache.target(args);
    } catch (error) {
      return { index, op, error: toolFailure(error) };
    }
    const resultBudget = budgetFor(index, op);
    const pendingInput = inputOperations.has(op) ? bridge.registerInput(sessionId) : undefined;
    if (pendingInput) inputs.add(pendingInput);
    const lane = sessionId ?? args.fork_from ?? index;
    const previous = lanes.get(lane) ?? Promise.resolve();
    const job = previous.then(async () => {
      try {
        const result = await bridge[op](args, {
          requestContext,
          resultBudget,
          readPins,
          pendingInput,
          // An explicit ordered restart is not withdrawn by its own Stop.
          retainedInputs: op === 'stop' ? inputs : undefined,
        });
        return {
          index,
          op,
          result: publicAnnotations[op] ? fitQuery(op, result, args, resultBudget) : result,
        };
      } catch (error) {
        return { index, op, error: toolFailure(error) };
      }
    });
    lanes.set(lane, job);
    return job;
  });
  try {
    const results = await Promise.all(jobs);
    await requestContext;
    return envelope(results);
  } finally {
    for (const release of readPins) release();
    for (const input of inputs) bridge.mutations.delete(input);
  }
}
