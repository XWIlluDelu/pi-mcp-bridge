// Native cancellation and request-local withdrawal; never teardown or a result store.
import { z } from 'zod';
import { parseAs } from '../mcp/schema.mjs';
import { fitTextField, renderTextField } from '../mcp/response-budget.mjs';

export function withdrawalCollector(maxChars = 12000) {
  let current;
  return {
    get value() {
      return current && { ...current };
    },
    add(value) {
      let text;
      if (typeof value?.text === 'string') {
        if (
          value.includesEditorDraft !== undefined &&
          typeof value.includesEditorDraft !== 'boolean'
        )
          throw new Error('INVALID_STOP_RECEIPT');
        text = value.text;
      } else {
        if (!Array.isArray(value?.steering) || !Array.isArray(value.followUp))
          throw new Error('INVALID_STOP_RECEIPT');
        const parts = [...value.steering, ...value.followUp];
        if (parts.some((part) => typeof part !== 'string')) throw new Error('INVALID_STOP_RECEIPT');
        text = parts.join('\n\n');
      }
      const previous = current ?? { text: '', includesEditorDraft: false, complete: true };
      const addition = (previous.text && text ? '\n\n' : '') + text;
      const part = previous.complete
        ? fitTextField(addition, 'text', Math.max(0, maxChars - previous.text.length))
        : '';
      current = {
        text: previous.text + part,
        includesEditorDraft:
          previous.includesEditorDraft ||
          (typeof value.text === 'string' && value.includesEditorDraft === true),
        complete: previous.complete && part.length === addition.length,
      };
      return this.value;
    },
  };
}
const withdrawal = z.object({
  text: z.string(),
  includesEditorDraft: z.boolean(),
  complete: z.boolean(),
});
export const inlineWithdrawal = (value) => parseAs(withdrawal, value, 'INVALID_STOP_RECEIPT');
export function withdrawalOutput(receipt, record, args, resultBudget) {
  const render = (withdrawn_text) => ({
    ...receipt,
    withdrawn_available: true,
    withdrawn_text,
    includes_editor_draft: record.includesEditorDraft,
    withdrawn_complete: record.complete && withdrawn_text.length === record.text.length,
  });
  return renderTextField(
    record.text,
    'withdrawn_text',
    args,
    resultBudget,
    render,
    'WITHDRAWAL_BUDGET_TOO_SMALL',
  );
}
const receipt = z.object({
  status: z.literal('accepted'),
  acknowledgement: z.enum(['native_ack', 'requested']),
  coverage: z.literal('agent_and_bash'),
});
export const stopReceipt = (value) => ({
  ...parseAs(receipt, value, 'INVALID_STOP_RECEIPT'),
  queue_policy: 'withdraw',
});
export async function requestStop(client, onWithdraw, beforeClear) {
  const methods = ['clearQueue', 'abort', 'abortBash'];
  if (methods.some((name) => typeof client[name] !== 'function'))
    throw new Error('STOP_UNSUPPORTED');
  beforeClear?.();
  // Issue all three requests, even if a native method fails synchronously.
  // A partial failure still waits for every dispatched cancellation to settle.
  const results = await Promise.allSettled(
    methods.map(async (name) => {
      const result = await client[name]();
      if (name === 'clearQueue') await onWithdraw(result);
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  beforeClear?.();
  await onWithdraw(await client.clearQueue());
  return stopReceipt({
    status: 'accepted',
    acknowledgement: 'native_ack',
    coverage: 'agent_and_bash',
  });
}
