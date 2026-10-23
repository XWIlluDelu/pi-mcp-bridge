import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareContextRead } from '../src/context-read.mjs';
import { validateReadAdapters } from '../src/read-adapters.mjs';
import { CompatibilityServices } from '../src/compatibility-services.mjs';
import intercomModule from '../src/compatibility/intercom.mjs';
import { sdk } from './fixtures/pi.mjs';

const services = new CompatibilityServices();
await intercomModule.start({ id: intercomModule.id, services, onStop() {} });
const [intercom] = services.readInputs.snapshot();
const msg = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
const text = (value) => ({ type: 'text', text: value });
const custom = (id, parentId, customType, content = id) => ({
  type: 'custom_message',
  id,
  parentId,
  customType,
  content,
  display: true,
  timestamp: '2026-01-01T00:00:00Z',
});
const prepare = (entries, args = {}, readAdapters = [intercom]) =>
  prepareContextRead({ entries }, { session_id: 'fixture', ...args }, { ...sdk, readAdapters });

test('native input descriptors reject invalid and conflicting mappings independently of module loading', () => {
  assert.deepEqual(validateReadAdapters(), []);
  for (const adapters of [
    null,
    {},
    [{}],
    [{ id: 'bad', inputCustomTypes: [] }],
    [{ id: 'bad', inputCustomTypes: [''] }],
    [intercom, intercom],
    [intercom, { id: 'other', inputCustomTypes: ['intercom_message'] }],
    [{ ...intercom, transform: 'unsupported' }],
  ])
    assert.throws(() => validateReadAdapters(adapters), /INVALID_READ_ADAPTER/);
});

test('intercom inputs use native prompt selectors without rewriting message roles, payloads or state', () => {
  const entries = [
    msg('u', null, 'user', 'human'),
    msg('a', 'u', 'assistant', [text('human answer')]),
  ];
  for (let n = 0; n < 4; n++) {
    entries.push(custom('i' + n, entries.at(-1).id, 'intercom_message'));
    entries.push(msg('a' + n, 'i' + n, 'assistant', [text('answer-' + n)]));
  }
  const details = {
    from: { id: 'sender', name: 'Reviewer', cwd: '/project' },
    message: {
      id: 'delivery',
      timestamp: 1,
      brokerDeliveredAt: 2,
      receiverReceivedAt: 3,
      injectedAt: 4,
      content: { text: 'i3', attachments: [{ type: 'file', name: 'note', content: 'ATTACHMENT' }] },
      replyTo: 'prior',
    },
    bodyText: 'i3',
    replyCommand: 'intercom reply',
  };
  entries.find((e) => e.id === 'i3').details = details;
  entries.push(custom('notice', 'a3', 'other-extension', 'not an input'));
  entries.push({
    type: 'custom',
    id: 'state',
    parentId: 'notice',
    customType: 'intercom_message',
    data: { privateState: true },
  });
  const before = structuredClone(entries);
  const full = prepare(entries, { preset: 'full' });
  assert.equal(full.units.filter((u) => u.type === 'prompt').length, 5);
  const latest = prepare(entries);
  assert.deepEqual(
    latest.units.map((u) => u.source.entry_id),
    ['i3', 'a3', 'notice'],
  );
  const input = latest.units[0];
  assert.equal(input.type, 'prompt');
  assert.equal(input.prompt_id, 'i3');
  assert.equal(input.message.role, 'custom');
  assert.equal(input.message.customType, 'intercom_message');
  assert.equal(input.source.read_adapter, 'pi-intercom');
  assert.deepEqual(input.message.details, details);
  assert.equal(latest.units[1].prompt_id, 'i3');
  assert.equal(latest.omissions.prompts, 4);
  const recent = prepare(entries, { preset: 'recent' });
  assert.deepEqual(
    recent.units.filter((u) => u.type === 'prompt').map((u) => u.prompt_id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(
    prepare(entries, { select: { recent_prompts: 0, earliest_prompts: 1 } }).units.map(
      (u) => u.source.entry_id,
    ),
    ['u', 'a'],
  );
  const native = prepare(entries, {}, []);
  assert.equal(native.units.filter((u) => u.type === 'prompt').length, 1);
  assert.equal(native.units.find((u) => u.source.entry_id === 'i3').type, 'custom');
  assert.equal(native.units.find((u) => u.source.entry_id === 'a3').prompt_id, 'u');
  assert.ok(!JSON.stringify(full).includes('privateState'));
  assert.deepEqual(entries, before);
});

test('custom input mappings retain native context edits, branch boundaries and tool pairing', () => {
  const entries = [
    custom('i1', null, 'intercom_message', 'first input'),
    msg('call', 'i1', 'assistant', [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }]),
    custom('i2', 'call', 'intercom_message', 'HIDDEN_INPUT'),
    msg('result', 'i2', 'toolResult', [text('result')], { toolCallId: 'c' }),
    msg('answer', 'result', 'assistant', [text('latest answer')]),
    { type: 'context_edit', id: 'hide', parentId: 'answer', targetId: 'i2', replacement: null },
  ];
  const latest = prepare(entries, { select: { tools: -1 } });
  assert.deepEqual(
    latest.units.map((u) => u.source.entry_id),
    ['i2', 'answer'],
  );
  const boundary = latest.units[0];
  assert.equal(boundary.synthetic, true);
  assert.equal(boundary.reason, 'hidden_input');
  assert.equal(boundary.message.role, 'custom');
  assert.equal(boundary.source.read_adapter, intercom.id);
  assert.equal(latest.units[1].prompt_id, boundary.prompt_id);
  assert.ok(!JSON.stringify(latest).includes('HIDDEN_INPUT'));
  const full = prepare(entries, { preset: 'full' });
  assert.equal(full.units.find((u) => u.type === 'tool_result').prompt_id, 'i1');
  assert.equal(full.units.find((u) => u.type === 'tool_result').pairing, 'paired');
  const early = prepare(entries, { leaf_id: 'call' });
  assert.equal(early.units[0].prompt_id, 'i1');
  assert.ok(!JSON.stringify(early).includes('latest answer'));
});

test('core input classification accepts an independent adapter without intercom', () => {
  const adapter = { id: 'fixture', inputCustomTypes: ['fixture-input'] };
  const entries = [
    custom('in', null, 'fixture-input'),
    msg('out', 'in', 'assistant', [text('answer')]),
  ];
  const result = prepare(entries, {}, [adapter]);
  assert.equal(result.units[0].type, 'prompt');
  assert.equal(result.units[0].source.read_adapter, 'fixture');
  assert.equal(result.units[1].prompt_id, 'in');
});
