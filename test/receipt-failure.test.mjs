import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Journal } from '../src/journal.mjs';
import { bashCapture } from '../src/bash-execution.mjs';
import { withdrawalCapture } from '../src/stop-execution.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

function persistenceFailure(error) {
  assert.equal(error.message, 'RECEIPT_PERSIST_FAILED');
  assert.equal(error.uncertain, true);
  assert.equal(error.cause?.code, 'EIO');
  return true;
}

const ioFailure = () =>
  Object.assign(new Error('Synthetic receipt persistence failure'), { code: 'EIO' });

// Inject at the filesystem boundary rather than replacing Journal.save/put, so
// the real transition serialization, write-failure latch and recovery all run.
function failTerminalPersistence(t, journal, id, phase) {
  let failed = false;
  const target = journal.file(id);
  const matches = async () =>
    JSON.parse(await fs.readFile(target, 'utf8')).receipt.status === 'accepted';
  if (phase === 'rename') {
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === target && !failed) {
        const value = JSON.parse(await fs.readFile(from, 'utf8'));
        if (value.receipt.status === 'accepted') {
          failed = true;
          throw ioFailure();
        }
      }
      return rename(from, to);
    });
  } else {
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === path.dirname(target) && !failed && (await matches())) {
        failed = true;
        t.mock.method(handle, 'sync', async () => {
          throw ioFailure();
        });
      }
      return handle;
    });
  }
  return () => failed;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-receipt-failure-'));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  const config = {
    ...isolatedRuntime(dir),
    principal: 'receipt-failure-fixture',
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: project }],
    defaults: { ...denyAllPermissions(), create: true, send: true, command: true, stop: true },
  };
  const calls = { starts: 0, send: 0, command: 0, stop: 0 };
  const factory = async (session) => {
    calls.starts++;
    const generation = 'receipt-failure-generation';
    return {
      alive: true,
      generation,
      state: async () => ({ isStreaming: false, pendingMessageCount: 0 }),
      command: async () => {
        calls.send++;
        return { disposition: 'started' };
      },
      executeBash: async ({ recovery_id }) => {
        calls.command++;
        await bashCapture(
          bridge.pool.attachmentDir,
          session,
          generation,
          recovery_id,
        )({
          output: 'Native command completed once',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          fullOutputPath: null,
        });
      },
      stopExecution: async ({ recovery_id }) => {
        calls.stop++;
        await withdrawalCapture(
          bridge.pool.attachmentDir,
          session,
          generation,
          recovery_id,
        )({
          text: 'Withdrawn input',
          includesEditorDraft: false,
        });
        return { acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
      },
      stop: async function () {
        this.alive = false;
      },
    };
  };
  let bridge = await new Bridge(config, factory).init();
  t.after(async () => {
    try {
      await bridge.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  return {
    config,
    project,
    calls,
    get bridge() {
      return bridge;
    },
    async restart({ unresolvedPersistence = false } = {}) {
      if (unresolvedPersistence) {
        await assert.rejects(bridge.close(), {
          message: 'RECEIPT_PERSIST_FAILED',
          uncertain: true,
        });
      } else await bridge.close();
      // Error reporting must not strand the owner lock or its native runtime.
      await assert.rejects(fs.stat(path.join(config.stateDir, 'bridge.lock')), { code: 'ENOENT' });
      bridge = await new Bridge(config, factory).init();
    },
  };
}

for (const phase of ['rename', 'directory-sync']) {
  test(`Journal terminal ${phase} failure is uncertainty, not a native rejection; a later save repairs it`, async (t) => {
    const f = await fixture(t);
    const journal = new Journal(f.config);
    const failed = failTerminalPersistence(t, journal, 'generic', phase);
    let saves,
      actions = 0;
    await journal.run('generic', 'send', 'session', { text: 'one action' }, async (save) => {
      actions++;
      saves = save;
      await assert.rejects(save({ status: 'accepted' }), persistenceFailure);
      // The caller may persist uncertainty after losing a durable ACK, but may
      // not claim the already-admitted action was rejected.
      return save({ status: 'unknown', reason: 'RECEIPT_PERSIST_FAILED' });
    });
    assert.equal(failed(), true);
    assert.equal(
      (
        await journal.run('generic', 'send', 'session', undefined, () => {
          actions++;
        })
      ).status,
      'unknown',
    );
    assert.equal(actions, 1);
    assert.equal((await saves({ status: 'accepted' })).status, 'accepted');
    assert.equal(
      (
        await journal.run('generic', 'send', 'session', undefined, () => {
          actions++;
        })
      ).status,
      'accepted',
    );
    assert.equal(actions, 1);
  });

  for (const operation of ['create', 'send', 'command', 'stop']) {
    test(`${operation}: accepted native work survives terminal ${phase} failure without a false rejection or restart replay`, async (t) => {
      const f = await fixture(t);
      const seed = operation === 'create' ? null : await savedSession(f.bridge);
      if (operation === 'stop')
        await f.bridge.pool.resolve(await f.bridge.session(seed.session_id));
      const request_id = operation + '-write-failure';
      const args =
        operation === 'create'
          ? { project: f.project, request_id, text: 'Initial prompt' }
          : {
              session_id: seed.session_id,
              request_id,
              ...(operation === 'send' ? { text: 'Submit once' } : {}),
              ...(operation === 'command' ? { command: 'Synthetic native command' } : {}),
            };
      const failed = failTerminalPersistence(t, f.bridge.journal, request_id, phase);
      let receipt, failure;
      try {
        receipt = await f.bridge[operation](args);
      } catch (error) {
        persistenceFailure(error);
        failure = error;
      }
      assert.equal(failed(), true);
      // APIs may surface the precise uncertain persistence error or durably
      // replace it with an unknown receipt. Neither may claim native refusal.
      if (receipt) assert.equal(receipt.status, 'unknown');
      if (operation === 'create') {
        assert.ok(receipt);
        assert.equal(receipt.created, true);
        assert.equal(receipt.send.status, 'unknown');
        assert.ok(receipt.session_id);
        assert.equal((await f.bridge.sessions()).length, 1);
      }
      assert.equal(f.calls[operation === 'create' ? 'send' : operation], 1);
      const expectedCalls = { ...f.calls };
      const recovery =
        operation === 'create'
          ? { project: f.project, request_id }
          : { session_id: seed.session_id, request_id };
      if (failure) {
        // A failed fsync cannot be called durable merely because its renamed
        // bytes are readable. The in-process latch refuses replay until repair.
        await assert.rejects(f.bridge[operation](recovery), { code: 'EIO' });
      } else assert.deepEqual(await f.bridge[operation](recovery), receipt);
      assert.deepEqual(f.calls, expectedCalls);
      const persisted = JSON.parse(
        await fs.readFile(f.bridge.journal.file(request_id), 'utf8'),
      ).receipt;
      assert.ok(['unknown', 'accepted'].includes(persisted.status));
      await f.restart({ unresolvedPersistence: Boolean(failure) });
      const recovered = await f.bridge[operation](recovery);
      assert.equal(recovered.status, persisted.status);
      assert.notEqual(recovered.status, 'rejected');
      assert.deepEqual(f.calls, expectedCalls);
      if (operation === 'create') {
        assert.deepEqual(recovered, receipt);
        assert.equal((await f.bridge.sessions()).length, 1);
      }
      if (operation === 'command') {
        assert.equal(recovered.output_available, true);
        assert.equal(recovered.output, 'Native command completed once');
      }
      if (operation === 'stop') {
        assert.equal(recovered.withdrawn_available, true);
        assert.equal(recovered.withdrawn_text, 'Withdrawn input');
      }
    });
  }
}
