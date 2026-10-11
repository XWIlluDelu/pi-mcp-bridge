import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readLfLines } from '../src/lf-lines.mjs';

test('LF framing preserves Unicode separators across every UTF-8 byte boundary', () => {
  const payload = JSON.stringify({text:'Before\u2028between\u2029after 😀 汉字'});
  const bytes = Buffer.from(`${payload}\r\n${payload}\n`);
  for (let split = 0; split <= bytes.length; split++) {
    const input = new PassThrough(), lines = [];
    const reader = readLfLines(input, line => lines.push(line));
    input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
    assert.deepEqual(lines, [payload, payload]); reader.close();
  }
});

test('LF framing ignores unfinished frames and detaches on close', async () => {
  const input = new PassThrough(), lines = [];
  const reader = readLfLines(input, line => lines.push(line));
  input.end('complete\nunfinished');
  await new Promise(resolve => input.once('end', resolve));
  assert.deepEqual(lines, ['complete']);
  assert.equal(input.listenerCount('data'), 0);
  reader.close();
});
