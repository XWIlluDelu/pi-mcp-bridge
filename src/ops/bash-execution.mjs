// Native Pi bash results, not a second shell executor or result store.
import { z } from 'zod';
import { parseAs } from '../mcp/schema.mjs';
import { fitTextField, renderTextField, optionalResultFields } from '../mcp/response-budget.mjs';

const nativeResult = z.object({
  output: z.string(),
  exitCode: z.int().nullable().default(null),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  fullOutputPath: z.string().nullable().default(null),
});
const inlineResult = nativeResult.extend({ output_complete: z.boolean() });
export const nativeBashResult = (value) => parseAs(nativeResult, value, 'INVALID_BASH_RESULT');
export const inlineBashResult = (value) => parseAs(inlineResult, value, 'INVALID_BASH_RESULT');

export function limitBashResult(value, maxChars = 12000) {
  const result = nativeBashResult(value);
  const output = fitTextField(result.output, 'output', maxChars);
  return { ...result, output, output_complete: output.length === result.output.length };
}
export function bashOutput(receipt, record, args, resultBudget) {
  const render = (output) =>
    optionalResultFields(
      {
        ...receipt,
        output_available: true,
        output,
        exitCode: record.exitCode,
        cancelled: record.cancelled,
        // Native output may already be truncated (for example, a tail).
        // Completeness describes only Bridge's delivery of that native output.
        native_truncated: record.truncated,
        response_complete: record.output_complete && output.length === record.output.length,
      },
      { fullOutputPath: record.fullOutputPath },
      resultBudget,
    );
  return renderTextField(
    record.output,
    'output',
    args,
    resultBudget,
    render,
    'BASH_BUDGET_TOO_SMALL',
  );
}
