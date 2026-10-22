import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { findHerdr, HerdrControl } from '../src/herdr-control.mjs';
import { HerdrRpcTransport } from '../src/herdr-rpc-transport.mjs';
import { ownerAlive, readClaim } from '../src/attachments.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const exec = promisify(execFile);
test('Herdr discovery uses executable PATH/local installation, not a cached availability flag', async (t) => {
  const dir = await fs.mkdtemp('/tmp/bridge-herdr-discovery-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, PATH: dir };
  assert.equal(await findHerdr(env), null);
  const bin = path.join(dir, '.local/bin');
  await fs.mkdir(bin, { recursive: true });
  const file = path.join(bin, 'herdr');
  await fs.writeFile(file, '', { mode: 0o600 });
  assert.equal(await findHerdr(env), null);
  await fs.chmod(file, 0o700);
  assert.equal(await findHerdr(env), file);
  await fs.unlink(file);
  assert.equal(await findHerdr(env), null);
});

test('missing Herdr starts directly; an installed Herdr failure cleans reservation without fallback', async (t) => {
  const dir = await fs.mkdtemp('/tmp/bridge-herdr-selection-');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = bin;
  process.env.HOME = dir;
  const config = {
    ...isolatedRuntime(dir),
    herdr: true,
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    defaults: denyAllPermissions(),
  };
  const bridge = await new Bridge(config).init();
  t.after(async () => {
    Object.assign(process.env, environment);
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  bridge.pool.onIdleCandidate = undefined;
  const seed = await savedSession(bridge),
    session = await bridge.session(seed.session_id);
  const direct = await bridge.pool.resolve(session);
  assert.equal(direct.child instanceof HerdrRpcTransport, false);
  await direct.stop();
  await fs.writeFile(path.join(bin, 'herdr'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  t.mock.method(HerdrControl, 'open', async () => {
    throw new Error('HERDR_UNAVAILABLE');
  });
  const rejected = new PiRpc({ ...config, attachmentDir: bridge.pool.attachmentDir }, session);
  await assert.rejects(rejected.start(), /HERDR_UNAVAILABLE/);
  assert.ok(rejected.child instanceof HerdrRpcTransport);
  assert.equal(rejected.child.pid, undefined);
  assert.equal(await readClaim(bridge.pool.attachmentDir, session), null);
  await assert.rejects(fs.stat(rejected.child.directory), { code: 'ENOENT' });
});

test(
  'real Herdr: cold start, hot placement changes, reuse, native EOF and explicit cleanup',
  {
    skip: !process.env.BRIDGE_TEST_HERDR,
    timeout: 60000,
  },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/bridge-herdr-native-');
    const bin = path.join(dir, 'bin'),
      wrapper = path.join(bin, 'herdr');
    await fs.mkdir(bin);
    // A named daemon isolates this test from every user pane and production daemon.
    const name = 'bridge-test-' + path.basename(dir);
    await fs.writeFile(
      wrapper,
      '#!/bin/sh\nexec ' +
        JSON.stringify(process.env.BRIDGE_TEST_HERDR) +
        ' --session ' +
        name +
        ' "$@"\n',
      { mode: 0o700 },
    );
    const oldPath = process.env.PATH;
    const serviceEnv = {
      INVOCATION_ID: process.env.INVOCATION_ID,
      LISTEN_FDS: process.env.LISTEN_FDS,
      BRIDGE_TEST_SECRET: process.env.BRIDGE_TEST_SECRET,
    };
    const secret = 'synthetic-provider-key-for-environment-test';
    const argsFile = path.join(dir, 'systemd-argv');
    const systemdRun = (await exec('which', ['systemd-run'])).stdout.trim();
    await fs.writeFile(
      path.join(bin, 'systemd-run'),
      '#!/bin/sh\nprintf "%s\\0" "$@" >> ' +
        JSON.stringify(argsFile) +
        '\nexec ' +
        JSON.stringify(systemdRun) +
        ' "$@"\n',
      { mode: 0o700 },
    );
    process.env.PATH = bin + ':' + oldPath;
    process.env.INVOCATION_ID = 'bridge-parent-invocation';
    process.env.LISTEN_FDS = '17';
    process.env.BRIDGE_TEST_SECRET = secret;
    let bridge;
    t.after(async () => {
      try {
        await bridge?.close();
      } finally {
        try {
          await exec(wrapper, ['server', 'stop'], { timeout: 10000 }).catch(() => {});
          await exec(process.env.BRIDGE_TEST_HERDR, ['session', 'delete', name, '--json'], {
            timeout: 10000,
          });
        } finally {
          process.env.PATH = oldPath;
          for (const [key, value] of Object.entries(serviceEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
    });
    const config = {
      ...isolatedRuntime(dir),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: dir }],
      defaults: denyAllPermissions(),
      herdr: false,
    };
    const configFile = path.join(dir, 'owner.json');
    const save = async (herdr) =>
      fs.writeFile(configFile, JSON.stringify({ ...config, herdr }), { mode: 0o600 });
    await save(false);
    bridge = await new Bridge(config, undefined, { configFile }).init();
    // Keep this test in charge of its idle writers, rather than racing auto-release.
    bridge.pool.onIdleCandidate = undefined;
    const seed = await savedSession(bridge);
    const session = await bridge.session(seed.session_id);
    const direct = await bridge.pool.resolve(session);
    assert.equal(direct.child instanceof HerdrRpcTransport, false);
    await save(true);
    await bridge.captureRequestContext();
    assert.equal(await bridge.pool.resolve(session), direct);
    await direct.gracefulExit();
    const runtime = await bridge.pool.resolve(session),
      child = runtime.child;
    assert.ok(child instanceof HerdrRpcTransport);
    const argv = (await fs.readFile(argsFile, 'utf8')).split('\0');
    assert.ok(argv.includes('--setenv=BRIDGE_TEST_SECRET'));
    assert.equal(
      argv.some((arg) => arg.includes(secret)),
      false,
    );
    assert.equal(argv.includes('--setenv=INVOCATION_ID'), false);
    assert.equal(argv.includes('--setenv=LISTEN_FDS'), false);
    assert.equal(
      argv
        .filter((arg) => arg.startsWith('--setenv='))
        .some((arg) => arg.slice('--setenv='.length).includes('=')),
      false,
    );
    const unit = argv.find((arg) => arg.startsWith('--unit=pi-bridge-herdr-')).slice(7);
    const pid = (
      await exec('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'])
    ).stdout.trim();
    const daemonEnvironment = (await fs.readFile('/proc/' + pid + '/environ', 'utf8')).split('\0');
    assert.ok(daemonEnvironment.includes('BRIDGE_TEST_SECRET=' + secret));
    assert.equal(daemonEnvironment.includes('INVOCATION_ID=bridge-parent-invocation'), false);
    assert.equal(daemonEnvironment.includes('LISTEN_FDS=17'), false);
    assert.equal((await runtime.state()).sessionId, session.header.id);
    const identity = runtime.childIdentity,
      directory = child.directory,
      pane = child.pane;
    assert.ok(await ownerAlive(identity));
    const info = await child.control.request('pane.process_info', { pane_id: pane });
    assert.equal(info.process_info.pane_id, pane);
    const shell = await runtime.command({ type: 'bash', command: 'printf "%s" "$HERDR_PANE_ID"' });
    assert.equal(shell.output, pane);
    await save(false);
    await bridge.captureRequestContext();
    assert.equal(await bridge.pool.resolve(session), runtime);
    await runtime.gracefulExit();
    assert.equal(await ownerAlive(identity), false);
    assert.equal(await readClaim(bridge.pool.attachmentDir, session), null);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    await assert.rejects(child.control.request('pane.process_info', { pane_id: pane }));
    const next = await bridge.pool.resolve(session);
    assert.equal(next.child instanceof HerdrRpcTransport, false);
    await next.stop();
    await save(true);
    const final = await bridge.pool.resolve(session),
      finalChild = final.child;
    await final.stop();
    // Reproduce the observed EOF race: a scope sampled active has already been
    // collected by the time systemctl tries to signal it.
    const scopeActive = finalChild.scopeActive.bind(finalChild);
    let staleActive = true;
    t.mock.method(finalChild, 'scopeActive', () => {
      if (staleActive) {
        staleActive = false;
        return true;
      }
      return scopeActive();
    });
    await finalChild.terminateScope();
    assert.equal(await ownerAlive(final.childIdentity), false);
    assert.equal(await readClaim(bridge.pool.attachmentDir, session), null);
    await assert.rejects(fs.stat(finalChild.directory), { code: 'ENOENT' });
    // Losing the private transport must terminate the actual writer, not merely
    // forget its PID and release a live claim.
    const disconnected = await bridge.pool.resolve(session),
      lost = disconnected.child;
    const lostDirectory = lost.directory;
    lost.channels.control.destroy();
    await disconnected.observeExit().promise;
    await disconnected.observeExit().closed;
    await disconnected.stop();
    assert.equal(await ownerAlive(disconnected.childIdentity), false);
    assert.equal(await readClaim(bridge.pool.attachmentDir, session), null);
    await assert.rejects(fs.stat(lostDirectory), { code: 'ENOENT' });
    // Final stdout/stderr can exceed socket buffers and arrive after the exit
    // record on another channel. close must mean both streams were drained.
    const bytes = 256 * 1024;
    const drain = new HerdrRpcTransport(wrapper, {
      command: process.execPath,
      args: [
        '-e',
        `process.stdin.resume(); process.stdin.on('end', () => {
        process.stdout.write('o'.repeat(${bytes}));
        process.stderr.write('e'.repeat(${bytes}));
      });`,
      ],
      cwd: dir,
      env: { PATH: oldPath },
    });
    const failures = [];
    drain.on('error', (error) => failures.push(error));
    let outputBytes = 0,
      errorBytes = 0;
    drain.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
    });
    drain.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
    });
    const closed = new Promise((resolve, reject) => {
      drain.once('close', resolve);
      drain.once('exitError', reject);
    });
    await drain.ready;
    drain.stdin.end();
    await closed;
    assert.deepEqual(failures, []);
    assert.equal(outputBytes, bytes);
    assert.equal(errorBytes, bytes);
    const snapshot = await finalChild.control.request('session.snapshot');
    assert.equal(snapshot.snapshot.panes.length, 0);
  },
);
