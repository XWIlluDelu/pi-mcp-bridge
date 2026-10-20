// Owner-local native TUI launcher. Never open the target before its handoff.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOwnerConfig } from './owner-config.mjs';
import { discover, validateExecutionCwd } from './data.mjs';
import { launchProfile, piCommand } from './rpc.mjs';

export async function openProfile(configFile, sessionId, hostEnv = process.env) {
  if (!/^ps_[a-f0-9]{32}$/.test(sessionId ?? '')) throw new Error('INVALID_SESSION_ID');
  configFile = path.resolve(configFile);
  const { config } = await readOwnerConfig(configFile);
  const session = (await discover(config)).find((item) => item.id === sessionId);
  if (!session) throw new Error('SESSION_NOT_FOUND');
  await validateExecutionCwd(session.cwd);
  const { env, toolArgs } = launchProfile(config, hostEnv);
  env.PI_MCP_OWNER_CONFIG = configFile;
  env.PI_MCP_ATTACH_DIR = config.attachmentDir ?? path.join(config.stateDir, 'ipc');
  const executable = await piCommand(config, env, session.cwd);
  // Owner piArgs may set a provider or load resources, but may not select or
  // fork any saved session before the safe /bridge-join reservation.
  const extra = config.piArgs ?? [];
  if (
    extra.some(
      (arg) =>
        /^(?:--(?:session(?:-id|-dir)?|continue|resume|fork|no-session|mode|print|export)|-[crp])(?:=|$)/.test(
          arg,
        ) ||
        arg.startsWith('@') ||
        arg === '--',
    )
  )
    throw new Error('UNSAFE_OPEN_PI_ARGS');
  // No --session TARGET: Pi migrates/opens it before loading extensions.
  return {
    command: executable.command,
    args: [
      ...executable.args,
      ...toolArgs,
      ...extra,
      '-e',
      fileURLToPath(new URL('./attach-extension.mjs', import.meta.url)),
      `/bridge-join ${sessionId}`,
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
