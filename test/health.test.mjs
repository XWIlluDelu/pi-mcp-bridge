import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { ACTIONS, permissionsHealth, permitted } from '../src/permissions.mjs';
import { Bridge } from '../src/bridge.mjs';
const open = () => Object.fromEntries(ACTIONS.map((action) => [action, true]));
const closed = () => Object.fromEntries(ACTIONS.map((action) => [action, false]));
const config = () => ({
  defaults: open(),
  folders: [{ path: '/projects/a' }, { path: '/projects/b' }],
});

test('healthy open defaults and a fully blocked exception return only ok', () => {
  const policy = { ...config(), grants: [{ folder: '/projects/gh-hunt', ...closed() }] };
  assert.deepEqual(permissionsHealth(policy), { domain: 'permissions', status: 'ok' });
  assert.deepEqual(permissionsHealth({ ...policy, defaults: closed() }), {
    domain: 'permissions',
    status: 'ok',
  });
});

test('session diagnostics preserve useful combinations without revealing project paths or global issues', () => {
  const policy = {
    ...config(),
    grants: [
      { folder: '/private/project', read: false },
      { session_id: 's', stop: true },
    ],
  };
  const report = permissionsHealth(policy, { session_id: 's', cwd: '/private/project' });
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['NO_PROGRESS_READ'],
  );
  assert.deepEqual(report.issues[0].scope, { session_id: 's' });
  assert.equal(report.issues[0].evidence.read.source, 'project');
  assert.equal(report.issues[0].evidence.send.source, 'default');
  assert.ok(!JSON.stringify(report).includes('/private/project'));
  assert.ok(!('create' in report.issues[0].evidence));
});

test('health snapshots each new request without mutating shared policy or opening Pi', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-health-');
  const policy = {
    stateDir: dir + '/state',
    sessionRoots: [dir + '/sessions'],
    folders: [{ path: dir }],
    defaults: open(),
  };
  const file = dir + '/owner.json';
  await fs.writeFile(file, JSON.stringify(policy), { mode: 0o600 });
  const bridge = await new Bridge(policy, () => assert.fail('health must not start Pi'), {
    configFile: file,
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await bridge.health(), { domain: 'permissions', status: 'ok' });
  await fs.writeFile(file, JSON.stringify({ ...policy, grants: [{ folder: dir, stop: false }] }));
  const report = await bridge.health();
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    ['NO_REMOTE_STOP'],
  );
  assert.equal(bridge.pool.instances.size, 0);
  assert.equal(permitted(bridge.config, 'stop', { id: 's', cwd: dir }), true);
  assert.equal(
    permitted((await bridge.captureRequestContext()).permissions, 'stop', { id: 's', cwd: dir }),
    false,
  );
});
