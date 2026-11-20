import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLfLines } from '../src/core/lf-lines.mjs';

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
