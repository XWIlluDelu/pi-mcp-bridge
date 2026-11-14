import { nativeOwner } from './fixtures/native-owner.mjs';
import { append, message, text } from './fixtures/native-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';

import { reserveHostSession } from '../src/host-adapter.mjs';

import { buildSessionProjection } from './fixtures/pi.mjs';
import { prepareContextRead, assertReadSnapshot } from '../src/context-read.mjs';
import { readSchema } from '../src/read-schema.mjs';
import { captureSessionRead } from '../src/session-readers.mjs';

const body = 'MEMORY_CONTEXT 漢😀\n\n'.repeat(900);
async function fixture(t) {
  const f = await nativeOwner(t, {
    prefix: 'readers',
    async configure({ dir, config }) {
      const module = path.join(dir, 'adapter.mjs');
      await fs.writeFile(
        module,
        `
        import fs from 'node:fs/promises';
        const store = ${JSON.stringify(dir)} + '/memory.json';
        export default { id: 'fixture-memory', start({ services, onStop }) {
          onStop(services.sessionReaders.register('fixture-memory', {
            matches: ({ owner }) => !owner.available || owner.commands.includes('fixture-memory'),
            read: async ({ nativeRead }) => {
              const items = JSON.parse(await fs.readFile(store, 'utf8'));
              const snapshot = await nativeRead({ entry_ids: ['u', 'a', 'missing'] });
              if (!Object.hasOwn(snapshot.entry_relations, 'u') || snapshot.entry_relations.missing !== 'unknown')
                throw new Error('MISSING_NATIVE_BRANCH_EVIDENCE');
              return { native: true, items };
            },
          }));
        } };
      `,
      );
      config.compatibilityModules = [{ module }];
    },
  });
  const store = path.join(f.dir, 'memory.json');
  await fs.writeFile(store, JSON.stringify([{ id: 'memory', kind: 'memory', text: body }]));
  await append(f.session, [
    message('u', null, 'user', 'NATIVE_INPUT'),
    message('a', 'u', 'assistant', [text('NATIVE_ANSWER')]),
  ]);
  return { ...f, store };
}

test('native branch evidence uses the requested raw chain and treats incomplete ancestry as unknown', () => {
  const args = { session_id: 'branch-fixture', entry_ids: ['root', 'current', 'other', 'missing'] };
  const entries = [
    message('root', null, 'user', 'Shared input'),
    message('current', 'root', 'assistant', [text('Current answer')]),
    message('other', 'root', 'assistant', [text('Other answer')]),
  ];
  const capture = (rows, options = {}) =>
    prepareContextRead(
      { entries: rows, leafId: 'current' },
      { ...args, ...options },
      { buildSessionProjection },
    );
  assert.equal(
    readSchema.safeParse(args).success,
    false,
    'entry_ids is not a public read argument',
  );
  const native = capture(entries);
  assert.deepEqual(native.entry_relations, {
    current: 'on_branch',
    missing: 'unknown',
    other: 'off_branch',
    root: 'on_branch',
  });
  assert.equal(assertReadSnapshot(native, args), native);
  assert.throws(
    () => assertReadSnapshot({ ...native, entry_relations: undefined }, args),
    /INVALID_OWNER_READ/,
  );
  const broken = capture(entries.filter((entry) => entry.id !== 'root'));
  assert.deepEqual(broken.entry_relations, {
    current: 'on_branch',
    missing: 'unknown',
    other: 'unknown',
    root: 'unknown',
  });
  assert.equal(capture(entries, { leaf_id: 'other' }).entry_relations.current, 'off_branch');
  assert.throws(() => capture(entries, { entry_ids: [null] }), /INVALID_READ_ARGUMENTS/);
});

test('readers reuse one native capture for branch selection and may omit its content', async () => {
  let acquired = 0;
  const args = { session_id: 'reader-fixture' };
  const native = {
    leaf_id: 'captured',
    units: [{ type: 'text', source: { entry_id: 'captured' } }],
    entry_relations: { captured: 'on_branch' },
  };
  const context = {
    owner: { leaf_id: 'older' },
    nativeRead: async () => {
      acquired++;
      return native;
    },
  };
  for (const includeNative of [true, false]) {
    const result = await captureSessionRead(
      {
        id: 'fixture',
        read: async ({ nativeRead }) => {
          assert.equal(await nativeRead({ entry_ids: ['captured', 'captured'] }), native);
          assert.equal(await nativeRead({ entry_ids: ['captured'] }), native);
          assert.equal(await nativeRead(), native);
          return { native: includeNative, items: [] };
        },
      },
      context,
      args,
    );
    assert.equal(result.leaf_id, 'captured');
    assert.equal(result.units.length, includeNative ? 1 : 0);
  }
  assert.equal(acquired, 2);
  await assert.rejects(
    captureSessionRead(
      {
        id: 'fixture',
        read: async ({ nativeRead }) => {
          await nativeRead({ entry_ids: ['captured'] });
          await nativeRead({ entry_ids: ['another'] });
        },
      },
      context,
      args,
    ),
    /SESSION_READER_FAILED/,
  );
  assert.equal(acquired, 3, 'changing the requested facts must not silently reacquire');
});

test('a reader capture survives store changes and later pages reauthorize', async (t) => {
  const f = await fixture(t);
  const overview = await f.bridge.read({ session_id: f.id, max_bytes: 4096 });
  assert.equal(overview.reader.id, 'fixture-memory');
  const memory = overview.items.find((item) => item.type === 'memory');
  const native = await f.bridge.read({ session_id: f.id, view: 'session' });
  assert.match(JSON.stringify(native.items), /NATIVE_ANSWER/);
  await fs.writeFile(f.store, 'invalid-json');
  const expanded = await f.bridge.read({ refs: [memory.ref], max_bytes: 4096 });
  assert.match(JSON.stringify(expanded.items), /MEMORY_CONTEXT/);
  const request = { cursor: expanded.next_cursor };
  assert.ok(request.cursor);
  await f.bridge.read(request);
  f.config.grants = [];
  await assert.rejects(f.bridge.read(request), /NOT_FOUND_OR_DENIED/);
});

test('reader routing rechecks live capabilities and the owner that appears during a saved capture', async (t) => {
  const f = await fixture(t),
    { session, bridge } = f;
  let features = { available: true, tools: [], commands: ['fixture-memory'], leaf_id: 'a' };
  let captures = 0;
  async function owner(snapshot) {
    const controller = await reserveHostSession({
      buildSessionProjection,
      attachmentDir: f.config.attachmentDir,
      session,
    });
    f.cleanup.push(() => controller.close());
    const state = () => ({ sessionFile: session.file, sessionId: session.header.id });
    await controller.ready({
      state,
      readFeatures: () => features,
      snapshot:
        snapshot ??
        (() => {
          captures++;
          return { ...state(), entries: [], leafId: null };
        }),
      submit: () => assert.fail('Read must not submit work'),
      release: async () => ({ released: true }),
    });
    return controller;
  }
  const controller = await owner();
  const read = () => bridge.read({ session_id: session.id });
  assert.equal((await read()).reader.id, 'fixture-memory');
  assert.equal(captures, 1);
  const readers = bridge.compatibilityServices.sessionReaders;
  const unregister = readers.register('conflict', {
    matches: () => true,
    read: () => ({ items: [] }),
  });
  await assert.rejects(read(), /SESSION_READER_CONFLICT/);
  unregister();

  const reader = readers.readers.get('fixture-memory'),
    original = reader.read;
  reader.read = async (ctx) => {
    const result = await original(ctx);
    features = { ...features, commands: [] };
    return result;
  };
  await assert.rejects(read(), /READ_SOURCE_CHANGED/);
  await controller.release();
  await controller.close();
  reader.read = async (ctx) => {
    assert.equal(ctx.owner.available, false);
    const result = await original(ctx);
    await owner(() => assert.fail('Source recheck must not reacquire history'));
    return result;
  };
  await assert.rejects(read(), /READ_SOURCE_CHANGED/);
});
