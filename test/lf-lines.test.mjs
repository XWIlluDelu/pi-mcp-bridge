import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLfLines } from '../src/lf-lines.mjs';

test('LF framing preserves Unicode separators across every UTF-8 byte boundary', () => {
  const payload = JSON.stringify({ text: 'Before\u2028between\u2029after 😀 汉字' });
  const bytes = Buffer.from(`${payload}\r\n${payload}\n`);
  for (let split = 0; split <= bytes.length; split++) {
    const input = new PassThrough(),
      lines = [];
    const reader = readLfLines(input, (line) => lines.push(line));
    input.write(bytes.subarray(0, split));
    input.write(bytes.subarray(split));
    assert.deepEqual(lines, [payload, payload]);
    reader.close();
  }
});

test('fragmented large frames, empty lines and multiple frames in one chunk retain exact content', () => {
  const input = new PassThrough(),
    lines = [],
    reader = readLfLines(input, (line) => lines.push(line));
  const payload = JSON.stringify({ text: '汉😀\u2028\u2029'.repeat(40000) }),
    bytes = Buffer.from(payload);
  for (let i = 0; i < bytes.length; i += 137) input.write(bytes.subarray(i, i + 137));
  assert.deepEqual(lines, []);
  input.write('\r');
  input.write('\n\nlast\n');
  assert.deepEqual(lines, [payload, '', 'last']);
  reader.close();
});

test('closing from a frame callback detaches immediately and discards the rest of that chunk', () => {
  const input = new PassThrough(),
    lines = [];
  const reader = readLfLines(input, (line) => {
    lines.push(line);
    reader.close();
  });
  input.write('one\ntwo\n');
  input.write('three\n');
  assert.deepEqual(lines, ['one']);
  assert.equal(input.listenerCount('data'), 0);
});

test('LF framing ignores unfinished frames and detaches on close', async () => {
  const input = new PassThrough(),
    lines = [];
  const reader = readLfLines(input, (line) => lines.push(line));
  input.end('complete\nunfinished');
  await new Promise((resolve) => input.once('end', resolve));
  assert.deepEqual(lines, ['complete']);
  assert.equal(input.listenerCount('data'), 0);
  reader.close();
});
