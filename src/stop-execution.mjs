// Native cancellation and request-local withdrawal; never teardown or a result store.
import { fitDecodedText } from './data.mjs';
import { fitsResult } from './response-budget.mjs';

export function withdrawalCollector(maxChars = 12000) {
  let current;
  return {
    get value() {
      return current && { ...current };
    },
    add(value) {
      let text,
        includesEditorDraft = false;
      if (typeof value?.text === 'string') {
        if (
          value.includesEditorDraft !== undefined &&
          typeof value.includesEditorDraft !== 'boolean'
        )
          throw new Error('INVALID_STOP_RECEIPT');
        text = value.text;
        includesEditorDraft = value.includesEditorDraft === true;
      } else {
        if (
          !Array.isArray(value?.steering) ||
          !Array.isArray(value.followUp) ||
          [...value.steering, ...value.followUp].some((part) => typeof part !== 'string')
        )
          throw new Error('INVALID_STOP_RECEIPT');
        // Native Escape grouping, not an inferred interleaving of the two queues.
        text = [...value.steering, ...value.followUp].join('\n\n');
      }
      const previous = current ?? { text: '', includesEditorDraft: false, complete: true };
      const addition = (previous.text && text ? '\n\n' : '') + text;
      const units = previous.complete
        ? fitDecodedText(addition, Math.max(0, maxChars - previous.text.length), (text) => ({
            text,
          }))
        : 0;
      current = {
        text: previous.text + addition.slice(0, units),
        includesEditorDraft: previous.includesEditorDraft || includesEditorDraft,
        complete: previous.complete && units === addition.length,
      };
      return this.value;
    },
  };
}
export function inlineWithdrawal(value) {
  if (
    typeof value?.text !== 'string' ||
    typeof value.includesEditorDraft !== 'boolean' ||
    typeof value.complete !== 'boolean'
  )
    throw new Error('INVALID_STOP_RECEIPT');
  return {
    text: value.text,
    includesEditorDraft: value.includesEditorDraft,
    complete: value.complete,
  };
}
export function withdrawalOutput(receipt, record, args, resultBudget) {
  const render = (withdrawn_text) => ({
    ...receipt,
    withdrawn_available: true,
    withdrawn_text,
    includes_editor_draft: record.includesEditorDraft,
    withdrawn_complete: record.complete && withdrawn_text.length === record.text.length,
  });
  const units = fitDecodedText(
    record.text,
    args.max_chars ?? 12000,
    (withdrawn_text) => ({ withdrawn_text }),
    ({ withdrawn_text }) => fitsResult(render(withdrawn_text), resultBudget),
  );
  if (record.text && !units) throw new Error('WITHDRAWAL_BUDGET_TOO_SMALL');
  return render(record.text.slice(0, units));
}
export function stopReceipt(value) {
  if (
    !value ||
    value.status !== 'accepted' ||
    !['native_ack', 'requested'].includes(value.acknowledgement) ||
    value.coverage !== 'agent_and_bash'
  )
    throw new Error('INVALID_STOP_RECEIPT');
  return {
    status: 'accepted',
    acknowledgement: value.acknowledgement,
    coverage: 'agent_and_bash',
    queue_policy: 'withdraw',
  };
}
export async function requestRpcStop(client, onWithdraw) {
  if (!['clearQueue', 'abort', 'abortBash'].every((name) => typeof client[name] === 'function'))
    throw new Error('STOP_UNSUPPORTED');
  const cleared = client.clearQueue();
  const cancellation = Promise.allSettled([client.abort(), client.abortBash()]);
  try {
    await onWithdraw(await cleared);
  } finally {
    // Capture failure cannot settle Stop while its dispatched aborts still run.
    await cancellation;
  }
  const results = await cancellation,
    failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  await onWithdraw(await client.clearQueue());
  return stopReceipt({
    status: 'accepted',
    acknowledgement: 'native_ack',
    coverage: 'agent_and_bash',
  });
}
