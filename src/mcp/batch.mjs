import {
  batchOperationSchema,
  publicOperationSchemas,
  publicAnnotations,
} from './tool-schemas.mjs';
import { TOOL_RESULT_LIMIT, toolResultBytes, jsonBytes, fitsResult } from './response-budget.mjs';
import { toolFailure } from '../core/errors.mjs';

const BATCH_RESPONSE_LIMIT = 196608; // UTF-8 bytes, inside the MCP envelope.
const envelope = (results) => ({
  status: 'processed',
  response_max_bytes: BATCH_RESPONSE_LIMIT,
  results,
});

function planBatch(operations) {
  const frame = envelope(operations.map(() => null)),
    count = operations.length,
    share = Math.floor((BATCH_RESPONSE_LIMIT - jsonBytes(frame)) / count),
    wireShare = Math.floor((TOOL_RESULT_LIMIT - toolResultBytes(frame)) / count);
  return operations.map((item, index) => {
    const op = item?.op;
    const shape = batchOperationSchema.safeParse(item);
    const parsed =
      shape.success && publicOperationSchemas[shape.data.op].safeParse(shape.data.args);
    if (!parsed?.success)
      return {
        index,
        op: typeof op === 'string' ? op.slice(0, 64) : null,
        error: {
          code: 'INVALID_OPERATION',
          ...(typeof op === 'string' && op.length > 64 ? { op_truncated: true } : {}),
        },
      };
    // Costs are additive at each null placeholder, including MCP's escaped text
    // copy. Subtract the item wrapper before giving its renderer a budget.
    // At most 10 items leave >19 KiB JSON and >24 KiB duplicated wire per result.
    // Required metadata fits: two <=256-unit model strings cost <=6656 wire bytes;
    // reason <=128, entry ID <=128, UUIDs and safe counters leave ample room.
    // See models.mjs, prompt-input.mjs, compact.mjs, storage.mjs and trash.mjs.
    // Unbounded auxiliary filesystem paths are optional in budgeted renderers.
    const empty = { index, op, result: null };
    return {
      index,
      op,
      args: parsed.data,
      resultBudget: {
        maxBytes: share + 4 - (jsonBytes(empty) - 4),
        maxWireBytes:
          wireShare + toolResultBytes(null) - (toolResultBytes(empty) - toolResultBytes(null)),
      },
    };
  });
}

function fitQuery(op, result, args, budget) {
  if (fitsResult(result, budget)) return result;
  if (op === 'models' || op === 'list') {
    const key = op === 'models' ? 'models' : 'sessions',
      rows = result[key];
    let low = 1,
      high = rows.length - 1,
      best;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const page = {
        ...result,
        [key]: rows.slice(0, count),
        next_offset: (args.offset ?? 0) + count,
      };
      if (fitsResult(page, budget)) {
        best = page;
        low = count + 1;
      } else high = count - 1;
    }
    if (best) return best;
  }
  throw new Error('BATCH_QUERY_BUDGET_TOO_SMALL');
}

// Callers validate the outer batch shape; malformed items are retained for
// per-item errors and validated here against their own operation schema.
export async function executeBatch(bridge, { operations }, { requestContext } = {}) {
  const plan = planBatch(operations);
  requestContext ??= bridge.captureRequestContext();
  void requestContext.catch(() => {});
  const lanes = new Map(),
    readPins = [],
    inputs = new Set();
  const jobs = plan.map((item) => {
    const { index, op, args, resultBudget, error } = item;
    if (error) return { index, op, error };
    let sessionId = args.session_id;
    if (op === 'read' && !sessionId && (args.cursor || args.refs)) {
      try {
        sessionId = bridge.readCache.target(args);
      } catch (error) {
        return { index, op, error: toolFailure(error) };
      }
    }
    const pendingInput = ['send', 'command', 'compact', 'reload'].includes(op)
      ? bridge.registerInput(sessionId)
      : undefined;
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
    for (const input of inputs) bridge.inputs.delete(input);
  }
}
