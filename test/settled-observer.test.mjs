import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { SessionManager, fauxAssistantMessage } from './fixtures/pi.mjs';
import { SettledObserver } from '../src/settled-observer.mjs';
import { ownerSocket } from '../src/owner-runtime.mjs';
import { hash } from '../src/storage.mjs';

test(
  'settlement freezes its boundary and an unresponsive Bridge does not block later local work',
  { timeout: 8000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-settled-observer-');
    const control = { stateDir: dir, attachmentDir: dir };
    const connections = new Set(),
      requests = [];
    const server = net.createServer({ allowHalfOpen: true }, (connection) => {
      connections.add(connection);
      connection.on('error', () => {});
      connection.on('close', () => connections.delete(connection));
      let body = '';
      connection.on('data', (chunk) => {
        body += chunk;
      });
      connection.on('end', () => {
        requests.push(JSON.parse(body));
        // The first request stalls; the next demonstrates normal recovery without
        // replaying the lost occurrence or retaining a background sender.
        if (requests.length > 1) connection.end(JSON.stringify({ data: {} }) + '\n');
      });
    });
    await new Promise((resolve) => server.listen(ownerSocket(control), resolve));
    t.after(async () => {
      for (const connection of connections) connection.destroy();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    });
    const manager = SessionManager.create(dir, dir);
    const observer = new SettledObserver(control, 'test-generation');
    observer.start(manager);
    manager.appendMessage(fauxAssistantMessage('FIRST_RESULT'));
    const first = observer.capture({ aborted: false }, manager);
    const started = Date.now();
    const sending = observer.send(first);
    manager.appendMessage(fauxAssistantMessage('LATER_RESULT'));
    await sending;
    assert.ok(Date.now() - started < 5000, 'The local IPC deadline must bound the wait');
    assert.equal(requests[0].leafId, first.leafId);
    assert.equal(requests[0].sessionCwdHash, hash(manager.getHeader().cwd));
    assert.equal(requests[0].result.text, 'FIRST_RESULT');
    assert.notEqual(requests[0].leafId, manager.getLeafId());

    // No observed start means no result, even though history has a recent answer.
    const next = observer.capture({ aborted: true }, manager);
    await observer.send(next);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].result, null);
    assert.equal(requests[1].aborted, true);
    assert.ok(requests[1].sequence > requests[0].sequence);
  },
);
