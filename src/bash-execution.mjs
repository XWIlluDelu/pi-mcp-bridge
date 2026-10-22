// Native Pi bash results, not a second shell executor or result store.
import { fitDecodedText } from './data.mjs';
import { fitsResult, optionalResultFields } from './response-budget.mjs';
export function nativeBashResult(value) {
  if (
    !value ||
    typeof value.output !== 'string' ||
    typeof value.cancelled !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !(value.exitCode == null || Number.isSafeInteger(value.exitCode)) ||
    !(value.fullOutputPath == null || typeof value.fullOutputPath === 'string')
  )
    throw new Error('INVALID_BASH_RESULT');
  return {
    output: value.output,
    exitCode: value.exitCode ?? null,
    cancelled: value.cancelled,
    truncated: value.truncated,
    fullOutputPath: value.fullOutputPath ?? null,
  };
}
export function limitBashResult(value, maxChars = 12000) {
  const result = nativeBashResult(value);
  const units = fitDecodedText(result.output, maxChars, (output) => ({ output }));
  return {
    ...result,
    output: result.output.slice(0, units),
    output_complete: units === result.output.length,
  };
}
export function inlineBashResult(value) {
  if (typeof value?.output_complete !== 'boolean') throw new Error('INVALID_BASH_RESULT');
  return { ...nativeBashResult(value), output_complete: value.output_complete };
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
        truncated: record.truncated,
        output_complete: record.output_complete && output.length === record.output.length,
      },
      { fullOutputPath: record.fullOutputPath },
      resultBudget,
    );
  const units = fitDecodedText(
    record.output,
    args.max_chars ?? 12000,
    (output) => ({ output }),
    ({ output }) => fitsResult(render(output), resultBudget),
  );
  if (record.output && !units) throw new Error('BASH_BUDGET_TOO_SMALL');
  return render(record.output.slice(0, units));
}
