import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding } from '../src/host-bindings.mjs';
import { processIdentity } from '../src/attachments.mjs';
import { RpcClient } from './fixtures/pi.mjs';
import { makeServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const body = 'MEMORY_CONTEXT 漢😀\n\n'.repeat(900);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-session-reader-')),
    store = path.join(dir, 'store'),
    module = path.join(dir, 'adapter.mjs'),
    extension = path.join(dir, 'memory-extension.mjs');
  await fs.mkdir(store);
  // Fixture storage format, not a design for any actual memory extension.
  await fs.writeFile(
    module,
    `import fs from 'node:fs/promises'; import path from 'node:path';
    export default {id:'fixture-memory', start({id,services,onStop},options) {
      onStop(services.sessionReaders.register(id, {
        matches: async ({session,owner}) => owner.available
          ? owner.commands.includes('fixture-memory')
          : fs.stat(path.join(options.store,session.native_id+'.json')).then(()=>true,e=>{
              if(e.code==='ENOENT')return false;throw e;
            }),
        read: async ({session,nativeRead}) => {
          const native = await nativeRead();
          const stored = JSON.parse(await fs.readFile(path.join(options.store,session.native_id+'.json'),'utf8'));
          return [...stored, ...native.units.filter(u=>u.type==='text').map(u=>({
            role:'assistant',content:u.block.text,details:{native_source:u.source},
          }))];
        },
      }));
    }};`,
  );
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises'; import path from 'node:path';
    export default function(pi) {
      pi.registerTool({name:'fixture_memory',label:'Fixture memory',description:'Fixture',
        parameters:{type:'object',properties:{}},
        execute:async()=>{throw new Error('READ_MUST_NOT_EXECUTE_TOOL')}});
      pi.registerCommand('fixture-memory',{handler:async()=>{throw new Error('READ_MUST_NOT_EXECUTE_COMMAND')}});
      pi.on('context',()=>{throw new Error('READ_MUST_NOT_REPLAY_HOOK')});
      pi.on('session_start',async(_event,ctx)=>{
        await fs.writeFile(path.join(${JSON.stringify(store)},ctx.sessionManager.getSessionId()+'.json'),
          JSON.stringify([{role:'system',content:${JSON.stringify(body)},details:{origin:'fixture-store'}}]));
      });
    };`,
  );
  const config = {
    ...isolatedRuntime(path.join(dir, 'agent')),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    defaults: denyAllPermissions(),
    grants: [{ folder: dir, read: true }],
    compatibilityModules: [{ module, options: { store } }],
  };
  const bridge = await new Bridge(config).init();
  bridge.pool.onIdleCandidate = undefined;
  const server = makeServer(bridge),
    client = new Client({ name: 'session-reader-fixture', version: '1' }),
    [remote, local] = InMemoryTransport.createLinkedPair();
  await server.connect(local);
  await client.connect(remote);
  const controllers = [];
  t.after(async () => {
    await client.close();
    await server.close();
    for (const controller of controllers) await controller.close();
    await bridge.close();
    assert.equal(bridge.compatibilityServices.sessionReaders.readers.size, 0);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const create = async () => {
    const made = await savedSession(bridge),
      session = await bridge.session(made.session_id);
    await fs.appendFile(
      session.file,
      [
        {
          type: 'message',
          id: 'u',
          parentId: null,
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'NATIVE_INPUT', timestamp: 0 },
        },
        {
          type: 'message',
          id: 'a',
          parentId: 'u',
          timestamp: '2026-01-01T00:00:00Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'NATIVE_ANSWER' }],
            timestamp: 0,
          },
        },
      ]
        .map(JSON.stringify)
        .join('\n') + '\n',
    );
    return session;
  };
  const call = async (args) => {
    const response = await client.callTool({ name: 'read', arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.ok(
      Buffer.byteLength(JSON.stringify(response.structuredContent)) <= (args.max_bytes ?? 24000),
    );
    return response.structuredContent;
  };
  return { dir, store, extension, config, bridge, client, controllers, create, call };
}

test('RPC host read routing sees the target session extension through public command registration', async (t) => {
  let native;
  t.after(() => native?.stop());
  const f = await fixture(t),
    target = await f.create(),
    plain = await f.create();
  const pidFile = path.join(f.dir, 'pid');
  const extension = path.join(f.dir, 'identity.mjs');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs'; export default () => fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
  );
  native = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.dir,
    env: { HOME: f.dir, PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir, PI_OFFLINE: '1' },
    args: [
      '--offline',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-tools',
      '--session',
      target.file,
      '-e',
      extension,
      '-e',
      f.extension,
    ],
  });
  await native.start();
  await native.getState();
  const controller = await reserveHostSession({
    attachmentDir: f.config.attachmentDir,
    session: target,
    owner: await processIdentity(Number(await fs.readFile(pidFile, 'utf8'))),
  });
  f.controllers.push(controller);
  await controller.ready(createRpcHostBinding(native));
  const features = await (await f.bridge.pool.forRead(target)).readFeatures();
  assert.equal(features.available, true);
  assert.ok(features.commands.includes('fixture-memory'));
  assert.deepEqual(features.tools, []);
  const page = await f.call({ session_id: target.id, max_bytes: 4096 });
  assert.equal(page.view, 'adapted');
  assert.equal(page.reader.id, 'fixture-memory');
  assert.equal((await f.call({ session_id: plain.id })).view, 'native');
});

test('one read entry routes live and saved session evidence, pages frozen context, and keeps explicit native view', async (t) => {
  const f = await fixture(t),
    withMemory = await f.create(),
    withoutMemory = await f.create(),
    saved = await f.create();
  for (const [session, piArgs] of [
    [withMemory, ['--offline', '-e', f.extension]],
    [withoutMemory, ['--offline', '--no-extensions']],
  ]) {
    const runtime = await new PiRpc({ ...f.config, piArgs }, session, {
      compatibility: f.bridge.compatibilityServices,
    }).start();
    f.bridge.pool.instances.set(session.id, f.bridge.pool.watchRuntime(runtime));
  }
  const runtime = f.bridge.pool.get(withMemory.id),
    fileBefore = await fs.readFile(withMemory.file);
  let probes = 0;
  const readFeatures = runtime.readFeatures.bind(runtime);
  t.mock.method(runtime, 'readFeatures', async () => {
    probes++;
    return readFeatures();
  });
  const liveFeatures = await readFeatures();
  assert.ok(liveFeatures.commands.includes('fixture-memory'));
  assert.deepEqual(liveFeatures.tools, [], 'Disabling tools does not unload the memory extension');
  assert.ok(
    !(await f.bridge.pool.get(withoutMemory.id).readFeatures()).commands.includes('fixture-memory'),
  );
  const first = await f.call({ session_id: withMemory.id, max_bytes: 4096 });
  assert.equal(first.view, 'adapted');
  assert.deepEqual(first.reader, { id: 'fixture-memory' });
  assert.equal(first.selection, null);
  assert.ok(first.next_cursor);
  assert.equal(probes, 2);
  await f.call({ cursor: first.next_cursor, preset: 'latest', select: {}, max_bytes: 4096 });
  const changedSelection = await f.client.callTool({
    name: 'read',
    arguments: { cursor: first.next_cursor, preset: 'full' },
  });
  assert.equal(JSON.parse(changedSelection.content[0].text).error.code, 'STALE_CURSOR');
  // Continuations cannot reread a changed backing store or query a new owner.
  await fs.writeFile(path.join(f.store, withMemory.header.id + '.json'), 'invalid-json');
  const pages = [first];
  while (pages.at(-1).next_cursor)
    pages.push(await f.call({ cursor: pages.at(-1).next_cursor, max_bytes: 4096 }));
  assert.equal(probes, 2);
  const items = pages.reverse().flatMap((page) => page.items);
  assert.equal(
    items
      .filter((i) => i.source.reader_index === 0 && i.message?.content)
      .map((i) => i.message.content)
      .join(''),
    body,
  );
  assert.ok(
    items.every((i) => Number.isInteger(i.source.reader_index) && i.source.entry_id === undefined),
  );
  assert.equal(
    items.find((i) => i.message?.role === 'assistant').message.details.native_source.entry_id,
    'a',
  );
  assert.deepEqual(await fs.readFile(withMemory.file), fileBefore);
  const native = await f.call({ session_id: withMemory.id, view: 'native' });
  assert.equal(native.view, 'native');
  assert.ok(JSON.stringify(native).includes('NATIVE_ANSWER'));
  const failed = await f.client.callTool({
    name: 'read',
    arguments: { session_id: withMemory.id },
  });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).error.code, 'SESSION_READER_FAILED');
  await fs.writeFile(
    path.join(f.store, withMemory.header.id + '.json'),
    JSON.stringify([{ role: 'system', content: 'PERSISTED_MEMORY' }]),
  );
  const selected = f.bridge.compatibilityServices.sessionReaders.readers.get('fixture-memory'),
    read = selected.read;
  const requests = [];
  selected.read = async (ctx) => {
    requests.push(ctx.request);
    return read(ctx);
  };
  for (const args of [
    {},
    { preset: 'latest' },
    { select: {} },
    { preset: 'recent' },
    { select: { recent_prompts: 1 } },
    { leaf_id: 'a' },
  ]) {
    const adapted = await f.call({ session_id: withMemory.id, ...args });
    assert.equal(adapted.view, 'adapted');
    assert.ok(JSON.stringify(adapted).includes('PERSISTED_MEMORY'));
    assert.ok(JSON.stringify(adapted).includes('NATIVE_ANSWER'));
    for (const [key, value] of Object.entries(args)) assert.deepEqual(requests.at(-1)[key], value);
  }
  await runtime.gracefulExit();
  const persisted = await f.call({ session_id: withMemory.id });
  assert.equal(persisted.view, 'adapted');
  assert.ok(JSON.stringify(persisted).includes('PERSISTED_MEMORY'));
  assert.equal(f.bridge.pool.get(withMemory.id), null, 'Saved routing does not start Pi');
  for (const session of [withoutMemory, saved]) {
    const native = await f.call({ session_id: session.id });
    assert.equal(native.view, 'native');
    assert.equal(native.reader, undefined);
    assert.ok(JSON.stringify(native).includes('NATIVE_ANSWER'));
  }
  assert.equal(f.bridge.pool.instances.has(saved.id), false);
  // Cursor authorization remains live even though adapter/owner access is frozen.
  f.config.grants = [];
  const denied = await f.client.callTool({
    name: 'read',
    arguments: { cursor: first.next_cursor },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'NOT_FOUND_OR_DENIED');
});

test('host session read routing uses current capabilities and refuses changed or conflicting sources', async (t) => {
  const f = await fixture(t),
    session = await f.create();
  await fs.writeFile(
    path.join(f.store, session.header.id + '.json'),
    JSON.stringify([{ role: 'system', content: 'HOST_CONTEXT' }]),
  );
  const controller = await reserveHostSession({ attachmentDir: f.config.attachmentDir, session });
  f.controllers.push(controller);
  let features = {
      available: true,
      tools: ['fixture_memory'],
      commands: ['fixture-memory'],
      leaf_id: 'a',
    },
    snapshots = 0;
  await controller.ready({
    state: () => ({ sessionFile: session.file, sessionId: session.header.id }),
    readFeatures: () => features,
    snapshot: async () => {
      snapshots++;
      return { sessionFile: session.file, sessionId: session.header.id, entries: [], leafId: null };
    },
    submit: () => assert.fail('Read must not submit work'),
    release: async () => ({ released: true }),
  });
  assert.equal((await f.call({ session_id: session.id })).items[0].message.content, 'HOST_CONTEXT');
  assert.equal(snapshots, 1);
  const readers = f.bridge.compatibilityServices.sessionReaders;
  const unregister = readers.register('conflict', { matches: () => true, read: () => [] });
  const conflicting = await f.client.callTool({
    name: 'read',
    arguments: { session_id: session.id },
  });
  assert.equal(JSON.parse(conflicting.content[0].text).error.code, 'SESSION_READER_CONFLICT');
  unregister();
  const selected = readers.readers.get('fixture-memory'),
    original = selected.read;
  selected.read = async (ctx) => {
    const result = await original(ctx);
    features = { ...features, commands: [] };
    return result;
  };
  const changed = await f.client.callTool({ name: 'read', arguments: { session_id: session.id } });
  assert.equal(JSON.parse(changed.content[0].text).error.code, 'READ_SOURCE_CHANGED');
  features = { ...features, available: false, commands: [] };
  selected.read = original;
  assert.equal((await f.call({ session_id: session.id })).view, 'adapted');
  assert.equal(snapshots, 3);

  await controller.release();
  await controller.close();
  selected.read = async (ctx) => {
    assert.equal(ctx.owner.available, false);
    const result = await original(ctx);
    const newOwner = await reserveHostSession({
      attachmentDir: f.config.attachmentDir,
      session,
    });
    f.controllers.push(newOwner);
    await newOwner.ready({
      state: () => ({ sessionFile: session.file, sessionId: session.header.id }),
      readFeatures: () => ({ available: true, tools: [], commands: [], leaf_id: 'a' }),
      snapshot: () => assert.fail('Source recheck must not acquire another snapshot'),
      submit: () => assert.fail('Read must not submit work'),
    });
    return result;
  };
  const replaced = await f.client.callTool({ name: 'read', arguments: { session_id: session.id } });
  assert.equal(JSON.parse(replaced.content[0].text).error.code, 'READ_SOURCE_CHANGED');
});
