import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { loadSession, readSessionIdentity, discover } from '../src/data.mjs';
import { hash } from '../src/storage.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-discovery-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    principal: 'fixture',
    defaults: denyAllPermissions(),
    attachmentDir: path.join(dir, 'ipc'),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'p', path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
  };
  let starts = 0;
  const runtime = {
    alive: true,
    command: async () => ({ disposition: 'started' }),
    stop: async () => {
      runtime.alive = false;
    },
    state: async () => ({ isStreaming: false, isCompacting: false }),
  };
  const bridge = await new Bridge(config, async () => {
    starts++;
    return runtime;
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const made = await savedSession(bridge, { folder_id: 'p', request_id: 'create' }),
    session = await bridge.session(made.session_id);
  return { dir, cwd, config, bridge, session, runtime, starts: () => starts };
}
test('warm known-ID lookup and listing avoid discovery but revalidate identity and current permissions', async (t) => {
  const f = await fixture(t);
  await f.bridge.list({ session_id: f.session.id });
  let scans = 0;
  const discover = f.bridge.sessions.bind(f.bridge);
  t.mock.method(f.bridge, 'sessions', async () => {
    scans++;
    return discover();
  });
  assert.equal((await f.bridge.session(f.session.id)).id, f.session.id);
  assert.equal((await f.bridge.list({ session_id: f.session.id })).sessions.length, 1);
  assert.equal(scans, 0);
  const header = { ...f.session.header, cwd: '/unavailable' };
  await fs.writeFile(f.session.file, JSON.stringify(header) + '\n');
  assert.equal((await f.bridge.session(f.session.id)).cwd, null);
  assert.deepEqual((await f.bridge.list({ session_id: f.session.id })).sessions, []);
  assert.equal(scans, 0);
  await fs.writeFile(f.session.file, JSON.stringify({ ...header, id: 'replacement' }) + '\n');
  await assert.rejects(f.bridge.session(f.session.id), /NOT_FOUND_OR_DENIED/);
  assert.equal(scans, 1);
  const replacement = (await f.bridge.sessions())[0];
  assert.notEqual(replacement.id, f.session.id);
  await fs.unlink(f.session.file);
  await assert.rejects(f.bridge.session(replacement.id), /NOT_FOUND_OR_DENIED/);
});
test('history larger than 32 MiB remains locatable, readable, sendable and deletable', async (t) => {
  const f = await fixture(t),
    line =
      JSON.stringify({
        type: 'message',
        id: 'big',
        parentId: null,
        message: { role: 'user', content: 'x'.repeat(32 * 1024 * 1024) },
      }) + '\n';
  await fs.appendFile(f.session.file, line);
  const identity = await f.bridge.session(f.session.id);
  assert.equal(identity.id, f.session.id);
  assert.equal('entries' in identity, false);
  assert.equal((await f.bridge.list()).sessions[0].session_id, f.session.id);
  const context = await f.bridge.read({ session_id: f.session.id, max_bytes: 4096 });
  assert.equal(context.items[0].source.entry_id, 'big');
  assert.ok(context.next_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 4096);
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, request_id: 'send', text: 'public fixture' }))
      .status,
    'accepted',
  );
  assert.equal(f.starts(), 1);
  assert.equal(
    (await f.bridge.delete({ session_id: f.session.id, request_id: 'delete' })).status,
    'deleted',
  );
});
test('identity discovery ignores unrelated transcript bodies, content parse follows authorization', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.session.file, 'not JSON at all\n');
  assert.equal((await discover(f.config))[0].id, f.session.id);
  f.config.grants = [{ session_id: f.session.id, read: false, delete: true }];
  assert.deepEqual((await f.bridge.list()).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: f.session.id }), /NOT_FOUND_OR_DENIED/);
  f.config.grants.push({ session_id: f.session.id, list: true, read: true, send: true });
  await assert.rejects(f.bridge.read({ session_id: f.session.id }), /INVALID_SESSION/);
  const before = await fs.readFile(f.session.file, 'utf8');
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, request_id: 'corrupt-send', text: 'fixture' }))
      .reason,
    'INVALID_SESSION',
  );
  assert.equal(f.starts(), 0);
  assert.equal(await fs.readFile(f.session.file, 'utf8'), before);
  const other = await f.bridge.create({
    project: f.cwd,
    text: 'first',
    request_id: 'denied-create',
  });
  assert.equal(other.status, 'rejected');
  assert.equal(
    (await f.bridge.delete({ session_id: f.session.id, request_id: 'delete-corrupt' })).status,
    'deleted',
  );
});
test('missing cwd retains explicit read/delete grants, no folder inheritance and no new runtime', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.cwd, f.cwd + '-moved');
  const identity = await readSessionIdentity(f.session.file);
  assert.equal(identity.cwd, null);
  assert.equal(identity.header.cwd, f.cwd);
  assert.deepEqual((await f.bridge.list()).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: f.session.id }), /NOT_FOUND_OR_DENIED/);
  f.config.grants.push({
    session_id: f.session.id,
    list: true,
    read: true,
    send: true,
    delete: true,
  });
  assert.deepEqual((await f.bridge.read({ session_id: f.session.id })).items, []);
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, request_id: 'send', text: 'fixture' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal(f.starts(), 0);
  assert.equal(
    (await f.bridge.create({ project: f.cwd, text: 'first', request_id: 'create-moved' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal((await fs.readdir(f.config.sessionRoots[0])).length, 1);
  assert.equal(
    (await f.bridge.delete({ session_id: f.session.id, request_id: 'delete' })).status,
    'deleted',
  );
});
test('existing owned runtime remains controllable after cwd disappears', async (t) => {
  const f = await fixture(t);
  f.config.grants.push({ session_id: f.session.id, send: true });
  await f.bridge.send({ session_id: f.session.id, request_id: 'start', text: 'fixture' });
  await fs.rename(f.cwd, f.cwd + '-moved');
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, request_id: 'again', text: 'fixture' }))
      .status,
    'accepted',
  );
  assert.equal(f.starts(), 1);
});
test('create freshly rejects a directory replaced by file or symlink', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.cwd, f.cwd + '-moved');
  await fs.writeFile(f.cwd, 'fixture');
  assert.equal(
    (await f.bridge.create({ project: f.cwd, text: 'first', request_id: 'file' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  await fs.unlink(f.cwd);
  await fs.symlink(f.cwd + '-moved', f.cwd);
  assert.equal(
    (await f.bridge.create({ project: f.cwd, text: 'first', request_id: 'link' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal((await fs.readdir(f.config.sessionRoots[0])).length, 1);
});
test('identity discovery reads a small header prefix and still supports bounded longer headers', async (t) => {
  const f = await fixture(t),
    header = f.session.header,
    open = fs.open;
  let bytes = 0,
    reads = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === f.session.file) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...args) => {
        const result = await read(...args);
        bytes += result.bytesRead;
        reads++;
        return result;
      });
    }
    return handle;
  });
  await fs.appendFile(f.session.file, 'x'.repeat(128 * 1024)); // Body need not parse during discovery.
  assert.deepEqual((await readSessionIdentity(f.session.file)).header, header);
  assert.ok(bytes <= 4096, `small header read ${bytes} bytes`);
  assert.equal(reads, 1);
  // A public control header may span chunks, including split UTF-8 characters.
  const longer = { ...header, fixture: '漢😀'.repeat(2400) };
  await fs.writeFile(f.session.file, JSON.stringify(longer) + '\n' + 'x'.repeat(128 * 1024));
  bytes = 0;
  reads = 0;
  assert.deepEqual((await readSessionIdentity(f.session.file)).header, longer);
  assert.ok(reads > 1);
  assert.ok(bytes <= Buffer.byteLength(JSON.stringify(longer)) + 4096);
  await fs.writeFile(f.session.file, JSON.stringify(header)); // A single-header file need not end in LF.
  assert.deepEqual((await readSessionIdentity(f.session.file)).header, header);
});
test('stream parser preserves LF framing, exact revisions and validates header independently', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(
    f.session.file,
    JSON.stringify({
      type: 'message',
      id: 'u',
      parentId: null,
      message: { role: 'user', content: 'line\u2028paragraph\u2029ok' },
    }) + '\n',
  );
  const loaded = await loadSession(f.session.file);
  assert.equal(loaded.entries[0].message.content, 'line\u2028paragraph\u2029ok');
  assert.equal(loaded.revision, hash(await fs.readFile(f.session.file, 'utf8')));
  await fs.writeFile(
    f.session.file,
    '{"type":"session","id":"oversized-header","cwd":"' + 'x'.repeat(65536),
  );
  await assert.rejects(readSessionIdentity(f.session.file), /INVALID_SESSION_HEADER/);
  assert.deepEqual(await discover(f.config), []);
});

test('bridge restart with missing configured cwd preserves explicit saved-history access', async (t) => {
  const f = await fixture(t);
  f.config.grants = [{ session_id: f.session.id, list: true, read: true, delete: true }];
  await f.bridge.close();
  await fs.rename(f.cwd, f.cwd + '-moved');
  const restarted = await new Bridge(f.config).init();
  try {
    assert.deepEqual((await restarted.read({ session_id: f.session.id })).items, []);
    assert.equal(
      (await restarted.delete({ session_id: f.session.id, request_id: 'delete-after-restart' }))
        .status,
      'deleted',
    );
  } finally {
    await restarted.close();
  }
});
