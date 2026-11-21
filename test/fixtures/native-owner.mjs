import { shortTempDir } from './temp-dir.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Bridge } from '../../src/core/bridge.mjs';
import {
  ownerAlive,
  processIdentity,
  readClaim,
  waitOwnerExit,
} from '../../src/runtime/attachments.mjs';
import { reserveHostSession } from '../../src/runtime/host-adapter.mjs';
import { buildSessionProjection } from './pi.mjs';
import { isolatedRuntime, nativePiCli } from './isolated-runtime.mjs';
import { denyAllPermissions } from './permissions.mjs';
import { savedSession } from './saved-session.mjs';
import { until } from './until.mjs';

const faux = new URL('./faux-extension.mjs', import.meta.url).pathname;
const companion = new URL('../../src/attach-extension.mjs', import.meta.url).pathname;
export const fauxArgs = ['-e', faux, '--provider', 'bridge-fixture', '--model', 'deterministic'];

export async function idleProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  void exited.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await once(child, 'spawn');
  return { child, exited, owner: await processIdentity(child.pid) };
}

export async function nativeOwner(
  t,
  { prefix = 'owner', configure, factory, reloadConfig = false, seed = true } = {},
) {
  const dir = await shortTempDir('pi-' + prefix + '-');
  const cwd = path.join(dir, 'project');
  const configFile = path.join(dir, 'owner.json');
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [
      { folder: cwd, list: true, read: true, send: true, stop: true, delete: true, create: true },
    ],
  };
  const cleanup = [];
  let bridge;
  t.after(async () => {
    const errors = [];
    try {
      for (const close of cleanup) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      try {
        await bridge?.close();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Native fixture cleanup failed');
  });
  await fs.mkdir(cwd);
  await fs.mkdir(config.piRuntime.agentDir);
  await fs.writeFile(
    path.join(config.piRuntime.agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await configure?.({ dir, cwd, config, cleanup });
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  bridge = await new Bridge(config, factory, reloadConfig ? { configFile } : undefined).init();
  const create = async () => bridge.session((await savedSession(bridge)).session_id);
  const session = seed ? await create() : null;
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    PI_OFFLINE: '1',
    PI_CODING_AGENT_DIR: config.piRuntime.agentDir,
    PI_MCP_ATTACH_DIR: config.attachmentDir,
    PI_MCP_OWNER_CONFIG: configFile,
  };
  return {
    dir,
    cwd,
    config,
    configFile,
    cleanup,
    create,
    session,
    id: session?.id,
    bridge,
    async reserveHost(target = session, owner) {
      const controller = await reserveHostSession({
        attachmentDir: bridge.pool.attachmentDir,
        session: target,
        buildSessionProjection,
        owner,
      });
      cleanup.push(() => controller.close());
      return controller;
    },
    env,
    mark: (name) => fs.writeFile(path.join(dir, name), 'yes'),
  };
}

export async function gatedExtension({ dir, config }, source, imports = '') {
  const extension = path.join(dir, 'fixture.mjs');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises';
    ${imports}
    const dir = ${JSON.stringify(dir)};
    const mark = name => fs.writeFile(dir + '/' + name, 'yes');
    async function wait(name) {
      while (!await fs.stat(dir + '/' + name).catch(() => null))
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    export default pi => {${source}};`,
  );
  config.piArgs.push('-e', extension);
}

export async function nativeTui(fixture, session, extraArgs = []) {
  const terminal = launchNativeTui(fixture, [
    ...fixture.config.piArgs,
    '--session',
    session.file,
    '-e',
    companion,
    ...fauxArgs,
    ...extraArgs,
  ]);
  const record = await terminal.ready(session);
  return { ...terminal, owner: record.owner };
}

export function launchNativeTui(fixture, args, env = fixture.env) {
  const command = [process.execPath, nativePiCli, ...args];
  const quote = (arg) => "'" + arg.replaceAll("'", "'\\''") + "'";
  const scriptArgs =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...command]
      : ['-qefc', command.map(quote).join(' '), '/dev/null'];
  const child = spawn(process.platform === 'darwin' ? '/usr/bin/script' : 'script', scriptArgs, {
    cwd: fixture.cwd,
    env: { ...env, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    record;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-65536);
    });
  fixture.cleanup.push(async () => {
    try {
      const live = record?.owner;
      if (live && (await ownerAlive(live))) {
        process.kill(live.pid, 'SIGTERM');
        await waitOwnerExit(live);
      }
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
  return {
    child,
    ready: (session) =>
      until(async () => {
        const current = await readClaim(fixture.config.attachmentDir, session);
        if (current?.kind === 'tui' && current.phase === 'ready') {
          record = current;
          return record;
        }
      }, 'native TUI registration'),
    type: (text) => child.stdin.write(text),
    waitFor: (text) => until(() => output.includes(text), text),
  };
}
