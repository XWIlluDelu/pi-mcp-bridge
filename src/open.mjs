// Owner-local native TUI launcher. Never open the target before its handoff.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOwnerConfig, registryDirectory, validateLaunchArgs } from './core/owner-config.mjs';
import { discover, validateExecutionCwd } from './core/data.mjs';
import { resolvePiLaunch } from './runtime/pi-installation.mjs';

export async function openProfile(configFile, sessionId, hostEnv = process.env) {
  if (!/^ps_[a-f0-9]{32}$/.test(sessionId ?? '')) throw new Error('INVALID_SESSION_ID');
  configFile = path.resolve(configFile);
  const { config } = await readOwnerConfig(configFile);
  const session = (await discover(config)).find((item) => item.id === sessionId);
  if (!session) throw new Error('SESSION_NOT_FOUND');
  await validateExecutionCwd(session.cwd);
  const { installation, env, toolArgs } = await resolvePiLaunch(config, session.cwd, hostEnv);
  env.PI_MCP_OWNER_CONFIG = configFile;
  env.PI_MCP_ATTACH_DIR = registryDirectory(config);
  const extra = config.piArgs ?? [];
  await validateLaunchArgs(installation, extra, 'text');
  // The companion and join must reach Pi before owner flags can consume
  // a positional argument or end option parsing.
  return {
    command: installation.command,
    args: [
      '-e',
      fileURLToPath(new URL('./attach-extension.mjs', import.meta.url)),
      `/bridge-join ${sessionId}`,
      ...toolArgs,
      ...extra,
    ],
    cwd: session.cwd,
    env,
  };
}

export async function openSession(
  configFile,
  sessionId,
  { hostEnv = process.env, spawnProcess = spawn } = {},
) {
  const profile = await openProfile(configFile, sessionId, hostEnv);
  return spawnProcess(profile.command, profile.args, {
    cwd: profile.cwd,
    env: profile.env,
    stdio: 'inherit',
  });
}
async function main() {
  const [configFile, sessionId, ...rest] = process.argv.slice(2);
  if (!configFile || !sessionId || rest.length)
    throw new Error('Usage: node src/open.mjs OWNER_CONFIG SESSION_ID');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('NATIVE_TUI_REQUIRES_TERMINAL');
  const child = await openSession(configFile, sessionId);
  child.once('error', (error) => {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
