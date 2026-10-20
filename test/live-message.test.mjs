import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMessageObserver } from '../src/live-message.mjs';

test('RPC text and thinking deltas reconstruct transient blocks and authoritative ends replace them', () => {
  const observer = new LiveMessageObserver('rpc_message_events');
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  const delta = (type, contentIndex, values = {}) =>
    observer.update({
      type: 'message_update',
      assistantMessageEvent: { type, contentIndex, ...values },
    });
  delta('thinking_start', 0);
  delta('thinking_delta', 0, { delta: 'reason' });
  delta('thinking_delta', 0, { delta: 'ing' });
  delta('text_start', 1);
  delta('text_delta', 1, { delta: 'hello' });
  delta('text_end', 1, { content: 'Hello, authoritative' });
  const live = observer.snapshot();
  assert.equal(live.transient, true);
  assert.equal(live.available, true);
  assert.equal(live.source, 'rpc_message_events');
  assert.deepEqual(live.message.content, [
    { index: 0, type: 'thinking', thinking: 'reasoning' },
    { index: 1, type: 'text', text: 'Hello, authoritative' },
  ]);
  observer.update({ type: 'message_end', message: { role: 'user' } });
  assert.notEqual(observer.snapshot().message, null);
  observer.update({ type: 'message_end', message: { role: 'assistant' } });
  assert.equal(observer.snapshot().message, null);
  delta('text_delta', 1, { delta: 'late ignored' });
  assert.equal(observer.snapshot().message, null);
});

test('extension cumulative events produce detached snapshots without assuming delta wire shape', () => {
  const observer = new LiveMessageObserver('extension_message_events'),
    message = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] };
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  observer.update({ type: 'message_update', message });
  message.content[0].text = 'later';
  const snapshot = observer.snapshot();
  assert.equal(snapshot.message.content[0].text, 'partial');
  snapshot.message.content[0].text = 'external mutation';
  assert.equal(observer.snapshot().message.content[0].text, 'partial');
  observer.update({ type: 'agent_settled' });
  assert.equal(observer.snapshot().message, null);
});

test('transient observation memory is bounded, Unicode-safe and explicitly truncated', () => {
  const observer = new LiveMessageObserver('rpc_message_events');
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  observer.update({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'x'.repeat(65535) + '😀overflow',
    },
  });
  const live = observer.snapshot();
  assert.equal(live.truncated, true);
  assert.equal(live.message.content[0].text.length, 65535);
  assert.equal(live.message.content[0].text.endsWith('�'), false);
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  assert.equal(observer.snapshot().truncated, false);
});
