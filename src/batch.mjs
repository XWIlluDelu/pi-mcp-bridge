import { batchSchema, batchOperationSchema, publicOperationSchemas } from './tool-schemas.mjs';
import { TOOL_RESULT_LIMIT, toolResultBytes, jsonBytes, fitsResult } from './response-budget.mjs';
import { publicError } from './errors.mjs';

export const BATCH_RESPONSE_LIMIT = 196608; // UTF-8 bytes, inside the MCP envelope.
const envelope = (results) => ({
  status: 'processed',
  response_max_bytes: BATCH_RESPONSE_LIMIT,
  results,
});

export function preflightBatch(input) {
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success)
    return { error: { status: 'rejected', error: { code: 'INVALID_BATCH' }, results: [] } };
  return { operations: parsed.data.operations };
}

function planBatch(operations) {
  const frame = envelope(operations.map(() => null)),
    count = operations.length,
    share = Math.floor((BATCH_RESPONSE_LIMIT - jsonBytes(frame)) / count),
    wireShare = Math.floor((TOOL_RESULT_LIMIT - toolResultBytes(frame)) / count);
  return operations.map((item, index) => {
    const op = item?.op,
      schema = batchOperationSchema.safeParse(item).success ? publicOperationSchemas[op] : null,
      parsed = schema?.safeParse(item?.args);
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
    for (let count = rows.length - 1; count > 0; count--) {
      const page = {
        ...result,
        [key]: rows.slice(0, count),
        next_offset: (args.offset ?? 0) + count,
      };
      if (fitsResult(page, budget)) return page;
    }
  }
  throw new Error('BATCH_QUERY_BUDGET_TOO_SMALL');
}

export async function executeBatch(bridge, input, { requestContext } = {}) {
  const { operations, error } = preflightBatch(input);
  if (error) return error;
  const plan = planBatch(operations);
  requestContext ??= bridge.captureRequestContext?.();
  void requestContext?.catch?.(() => {});
  const lanes = new Map(),
    readPins = [],
    inputs = new Set(),
    results = new Array(operations.length);
  const jobs = plan.map((item) => {
    const { index, op, args, resultBudget, error } = item;
    if (error) {
      results[index] = { index, op, error };
      return Promise.resolve();
    }
    let sessionId = args.session_id;
    if (op === 'read' && !sessionId && args.cursor) {
      try {
        sessionId = bridge.readCache.identity(args.cursor).session_id;
      } catch (error) {
        results[index] = { index, op, error: { code: publicError(error) } };
        return Promise.resolve();
      }
    }
    const pendingInput = ['send', 'command', 'compact'].includes(op)
      ? bridge.registerInput(sessionId)
      : undefined;
    if (pendingInput) inputs.add(pendingInput);
    const lane = sessionId ?? args.fork_from ?? `independent:${index}`;
    const previous = lanes.get(lane) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        try {
          let result = structuredClone(
            await bridge[op](args, {
              requestContext,
              resultBudget,
              readPins,
              pendingInput,
              // An explicit ordered restart is not withdrawn by its own Stop.
              // Exemption never clears cancellation by an external Stop.
              retainedInputs: op === 'stop' ? inputs : undefined,
            }),
          );
          if (['read', 'models', 'list', 'health'].includes(op))
            result = fitQuery(op, result, args, resultBudget);
          results[index] = { index, op, result };
        } catch (error) {
          results[index] = {
            index,
            op,
            error: {
              code: publicError(error),
              ...(error.minimum_max_bytes ? { minimum_max_bytes: error.minimum_max_bytes } : {}),
              ...(error?.uncertain
                ? {
                    uncertain: true,
                    recovery: 'OUTCOME_UNKNOWN; inspect list/read. Do not automatically resubmit.',
                  }
                : {}),
            },
          };
        }
      });
    lanes.set(lane, job);
    return job;
  });
  try {
    await Promise.all(jobs);
    await requestContext;
    return envelope(results);
  } finally {
    for (const release of readPins) release();
    for (const input of inputs) bridge.inputs.delete(input);
  }
}
