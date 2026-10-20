import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareTrash } from '../src/trash.mjs';
import { opaqueId, syncDir } from '../src/storage.mjs';

async function fixture(t, sessionBase = os.tmpdir()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-trash-state-'));
  const sessions = await fs.mkdtemp(path.join(sessionBase, 'pi-trash-sessions-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(sessions, { recursive: true, force: true });
  });
  const config = { stateDir: root };
  const file = path.join(sessions, 'session.jsonl');
  const header = { type: 'session', version: 3, id: 'native-public-fixture', cwd: root };
  await fs.writeFile(file, JSON.stringify(header) + '\n', { mode: 0o600 });
  return { config, session: { file, header, id: opaqueId(`${file}\0${header.id}`) }, sessions };
}

async function records(f, token) {
  const indexPath = path.join(f.config.stateDir, 'trash', `${token}.restore.json`);
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.deepEqual(JSON.parse(await fs.readFile(index.metadata_path, 'utf8')), index);
  return index;
}

test('cross-filesystem state storage uses adjacent atomic rename and recoverable metadata', async (t) => {
  let shared;
  try {
    shared = await fs.stat('/dev/shm');
  } catch {
    return t.skip('/dev/shm unavailable');
  }
  if (shared.dev === (await fs.stat(os.tmpdir())).dev) return t.skip('requires two filesystems');
  const f = await fixture(t, '/dev/shm');
  // Reproduce the original operation failing before exercising the replacement.
  await assert.rejects(fs.rename(f.session.file, path.join(f.config.stateDir, 'old-trash.jsonl')), {
    code: 'EXDEV',
  });
  const trash = await prepareTrash(f.config, f.session),
    metadata = await records(f, trash.token);
  assert.equal(metadata.phase, 'prepared');
  assert.equal(await fs.readFile(f.session.file, 'utf8'), JSON.stringify(f.session.header) + '\n');
  assert.equal(path.dirname(metadata.trash_path), path.join(f.sessions, '.pi-mcp-trash'));
  await trash.move();
  await trash.cancel();
  assert.equal(trash.moved, true);
  await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
  await records(f, trash.token);
  // The moved file and its local recovery record survive loss of the index.
  await fs.rm(path.join(f.config.stateDir, 'trash'), { recursive: true });
  const local = JSON.parse(await fs.readFile(metadata.metadata_path, 'utf8'));
  await fs.rename(local.trash_path, local.original_path);
  assert.equal(await fs.readFile(f.session.file, 'utf8'), JSON.stringify(f.session.header) + '\n');
});

test('index preparation failure cleans local intent without moving the session', async (t) => {
  const f = await fixture(t);
  const io = {
    ...fs,
    open: async (file, ...args) => {
      if (path.dirname(file) === path.join(f.config.stateDir, 'trash'))
        throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
      return fs.open(file, ...args);
    },
  };
  await assert.rejects(prepareTrash(f.config, f.session, { io }), { code: 'EACCES' });
  assert.deepEqual(await fs.readdir(path.join(f.sessions, '.pi-mcp-trash')), []);
  assert.deepEqual(await fs.readdir(path.join(f.config.stateDir, 'trash')), []);
  assert.ok(await fs.stat(f.session.file));
});

test('prepared crash intent is not evidence of deletion; cancellation removes both records', async (t) => {
  const f = await fixture(t),
    trash = await prepareTrash(f.config, f.session);
  const metadata = await records(f, trash.token);
  assert.ok(await fs.stat(metadata.original_path));
  await assert.rejects(fs.stat(metadata.trash_path), { code: 'ENOENT' });
  await trash.cancel();
  await assert.rejects(trash.move(), /TRASH_CANCELLED/);
  assert.deepEqual(await fs.readdir(path.dirname(metadata.metadata_path)), []);
  assert.deepEqual(await fs.readdir(path.join(f.config.stateDir, 'trash')), []);
});

test('rename EXDEV is rejected without copy-delete and cancellation removes intents', async (t) => {
  const f = await fixture(t);
  const trash = await prepareTrash(f.config, f.session, {
    io: {
      ...fs,
      rename: async () => {
        throw Object.assign(new Error('fixture EXDEV'), { code: 'EXDEV' });
      },
    },
  });
  await assert.rejects(trash.move(), { code: 'EXDEV' });
  assert.equal(trash.moved, false);
  assert.ok(await fs.stat(f.session.file));
  await trash.cancel();
  assert.deepEqual(await fs.readdir(path.join(f.sessions, '.pi-mcp-trash')), []);
});

test('post-rename sync failure retains local recovery metadata and reports moved', async (t) => {
  const f = await fixture(t);
  let fail = false;
  const trash = await prepareTrash(f.config, f.session, {
    sync: async (dir) => {
      if (fail) throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' });
      await syncDir(dir);
    },
  });
  fail = true;
  await assert.rejects(trash.move(), { code: 'EIO' });
  assert.equal(trash.moved, true);
  await trash.cancel();
  const metadata = await records(f, trash.token);
  assert.ok(await fs.stat(metadata.trash_path));
  await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
});

test('replacement inode or native header identity is rejected before moving', async (t) => {
  for (const replacement of ['inode', 'header']) {
    const f = await fixture(t),
      trash = await prepareTrash(f.config, f.session);
    const content =
      JSON.stringify({
        ...f.session.header,
        id: replacement === 'header' ? 'other-native-id' : f.session.header.id,
      }) + '\n';
    if (replacement === 'inode') {
      await fs.writeFile(`${f.session.file}.replacement`, content);
      await fs.rename(`${f.session.file}.replacement`, f.session.file);
    } else await fs.writeFile(f.session.file, content);
    await assert.rejects(trash.move(), /RUNTIME_SESSION_CHANGED/);
    assert.equal(trash.moved, false);
    await trash.cancel();
    assert.equal(await fs.readFile(f.session.file, 'utf8'), content);
  }
});

test('symlink or public adjacent trash directory is rejected before intent creation', async (t) => {
  for (const kind of ['symlink', 'public']) {
    const f = await fixture(t),
      dir = path.join(f.sessions, '.pi-mcp-trash');
    if (kind === 'symlink') await fs.symlink(f.config.stateDir, dir);
    else {
      await fs.mkdir(dir, { mode: 0o755 });
      await fs.chmod(dir, 0o755);
    }
    await assert.rejects(prepareTrash(f.config, f.session), /INVALID_TRASH_DIRECTORY/);
    assert.ok(await fs.stat(f.session.file));
  }
});
