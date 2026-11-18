import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gatedExtension } from './fixtures/native-owner.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { readClaim, claimFile, ownerAlive } from '../src/attachments.mjs';

test(
  'explicit owner interruption waits for native startup to unwind before releasing the writer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.cleanup.unshift(() => f.mark('finish-preparation'));
    await gatedExtension(
      f,
      `
      process.on('SIGTERM', () => void mark('sigterm'));
      pi.registerCommand('held-extension-input', { handler: () => {
        pi.sendUserMessage('UNFINISHED_EXTENSION_INPUT');
      } });
      pi.on('before_agent_start', async e => {
        if (e.prompt === 'UNFINISHED_EXTENSION_INPUT') {
          await mark('preparing');
          await wait('finish-preparation');
        }
      });
      pi.on('before_provider_request', () => mark('provider-called'));
    `,
    );
    const accepted = await f.bridge.send({ session_id: f.id, text: '/held-extension-input' });
    assert.equal(accepted.status, 'handled');
    await until(() => fs.stat(f.dir + '/preparing').catch(() => null));
    const runtime = f.bridge.pool.get(f.id),
      previous = runtime.ownerRecord,
      session = runtime.session;
    assert.equal((await runtime.state()).isStreaming, true);
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id }),
      /RUNTIME_BUSY/,
    );
    t.mock.method(runtime, 'state', () =>
      assert.fail('Interrupt only needs exact writer identity'),
    );
    const kill = t.mock.method(runtime.child, 'kill');
    const release = ownerRequest(f.config, {
      op: 'release',
      session_id: f.id,
      interrupt: true,
    });
    void release.catch(() => {});
    try {
      await until(() => fs.stat(f.dir + '/sigterm').catch(() => null));
      assert.equal(await ownerAlive(previous.owner), true);
      assert.equal(
        (await readClaim(f.config.attachmentDir, session)).generation,
        previous.generation,
      );
      assert.doesNotMatch(await fs.readFile(session.file, 'utf8'), /UNFINISHED_EXTENSION_INPUT/);
    } finally {
      await f.mark('finish-preparation');
    }
    assert.equal((await release).status, 'released');
    assert.deepEqual(
      kill.mock.calls.map(({ arguments: [signal] }) => signal),
      ['SIGTERM'],
    );
    assert.equal(await ownerAlive(previous.owner), false);
    assert.equal((await readClaim(f.bridge.pool.attachmentDir, session)).noColdReacquire, true);
    await assert.rejects(fs.stat(f.dir + '/provider-called'), { code: 'ENOENT' });
  },
);

test(
  'missing-history release rejects a changed claim and a replacement history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      session = await f.bridge.session(f.id),
      runtime = await f.bridge.pool.resolve(session),
      file = claimFile(f.bridge.pool.attachmentDir, session),
      original = await fs.readFile(file, 'utf8'),
      record = JSON.parse(original),
      history = await fs.readFile(session.file),
      signals = [];
    const kill = runtime.child.kill.bind(runtime.child);
    t.mock.method(runtime.child, 'kill', (signal) => {
      signals.push(signal);
      return kill(signal);
    });
    await fs.unlink(session.file);
    try {
      for (const changed of [
        { ...record, generation: 'another-generation' },
        { ...record, owner: { ...record.owner, start: 'another-process-start' } },
      ]) {
        const bytes = JSON.stringify(changed);
        await fs.writeFile(file, bytes);
        await assert.rejects(
          ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt: true }),
          /RUNTIME_SESSION_CHANGED/,
        );
        assert.equal(await fs.readFile(file, 'utf8'), bytes);
      }
      await fs.writeFile(file, original);
      const lines = history.toString().split('\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), id: 'replacement-native-session' });
      const bytes = lines.join('\n');
      await fs.writeFile(session.file, bytes);
      await assert.rejects(
        ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt: true }),
        /NOT_FOUND_OR_DENIED/,
      );
      assert.equal(await fs.readFile(session.file, 'utf8'), bytes);
      assert.equal(await ownerAlive(record.owner), true);
      assert.equal(runtime.child.stdin.writableEnded, false);
      assert.deepEqual(signals, []);
    } finally {
      await fs.writeFile(file, original);
      await fs.writeFile(session.file, history);
    }
  },
);
