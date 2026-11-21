#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOwnerConfig, registryDirectory } from '../src/core/owner-config.mjs';
import { loadHttpConfig } from '../src/mcp/http-config.mjs';
import { assertNativeDirectory, assertPrivateDirectory, ifMissing } from '../src/core/storage.mjs';
import { privateDirectory } from '../src/runtime/attachments.mjs';
import { resolvePiLaunch } from '../src/runtime/pi-installation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'pi-mcp-bridge');
  return path.join(os.homedir(), '.config', 'pi-mcp-bridge');
}

function defaultStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'pi-mcp-bridge');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'pi-mcp-bridge');
  return path.join(os.homedir(), '.local', 'state', 'pi-mcp-bridge');
}

function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), '.pi', 'agent');
}

async function canonicalEnsureDir(dir, mode = 0o700) {
  await fs.mkdir(dir, { recursive: true, mode });
  return fs.realpath(dir);
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (['force', 'allow-command', 'allow-delete', 'json'].includes(arg.slice(2))) {
      flags[arg.slice(2)] = true;
    } else if (i + 1 < args.length) {
      flags[arg.slice(2)] = args[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { flags, positionals };
}

export async function initConfig(args = []) {
  const { flags, positionals } = parseFlags(args);
  const configPath = path.resolve(positionals[0] ?? path.join(defaultConfigDir(), 'owner.json'));
  const configDir = await canonicalEnsureDir(path.dirname(configPath), 0o700);
  const resolvedConfig = path.join(configDir, path.basename(configPath));

  const existing = await fs.lstat(resolvedConfig).catch(ifMissing);
  if (existing && !flags.force) {
    throw new Error(
      `Config already exists at ${resolvedConfig}. Pass --force to overwrite or run "pi-mcp-bridge doctor ${resolvedConfig}".`,
    );
  }

  const projectInput = path.resolve(flags.project ?? process.cwd());
  const project = await fs.realpath(projectInput);
  const projectStat = await fs.stat(project);
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`);

  const sessionsInput = path.resolve(flags.sessions ?? path.join(defaultAgentDir(), 'sessions'));
  const sessionsDir = await canonicalEnsureDir(sessionsInput, 0o700);
  const stateDir = await canonicalEnsureDir(path.resolve(flags.state ?? defaultStateDir()), 0o700);

  // Unix domain socket paths are capped at 104 bytes on macOS (108 on Linux).
  // If stateDir/ipc would exceed the 100-byte safety ceiling, pick a short private attachmentDir.
  let attachmentDir;
  const defaultIpc = path.join(stateDir, 'ipc');
  if (Buffer.byteLength(path.join(defaultIpc, '2147483647-12345678.sock')) > 100) {
    const shortHomeIpc = path.join(os.homedir(), '.pi-mcp-ipc');
    const candidate =
      Buffer.byteLength(path.join(shortHomeIpc, '2147483647-12345678.sock')) <= 100
        ? shortHomeIpc
        : path.join('/tmp', `pm-ipc-${process.getuid?.() ?? 'u'}`);
    attachmentDir = await canonicalEnsureDir(candidate, 0o700);
  }

  const config = {
    stateDir,
    ...(attachmentDir ? { attachmentDir } : {}),
    sessionRoots: [sessionsDir],
    folders: [{ path: project }],
    defaults: {
      list: false,
      read: false,
      send: false,
      command: false,
      stop: false,
      create: false,
      delete: false,
    },
    grants: [
      {
        folder: project,
        list: true,
        read: true,
        send: true,
        stop: true,
        create: true,
        command: Boolean(flags['allow-command']),
        delete: Boolean(flags['allow-delete']),
      },
    ],
    herdr: false,
  };

  let tokenFile;
  if (flags['http-port']) {
    const port = Number(flags['http-port']);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid --http-port: ${flags['http-port']}`);
    tokenFile = path.join(configDir, 'bridge-token');
    const tokenExists = await fs.lstat(tokenFile).catch(ifMissing);
    if (!tokenExists || flags.force) {
      await fs.writeFile(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
      await fs.chmod(tokenFile, 0o600);
    }
    config.http = { port, tokenFile };
  }

  await fs.writeFile(resolvedConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(resolvedConfig, 0o600);

  const serverEntry = path.join(ROOT, 'src', 'server.mjs');
  const companionEntry = path.join(ROOT, 'src', 'attach-extension.mjs');
  const result = {
    configPath: resolvedConfig,
    project,
    sessionRoots: config.sessionRoots,
    stateDir,
    ...(tokenFile ? { httpPort: config.http.port, tokenFile } : {}),
    mcpClientConfig: {
      command: 'node',
      args: [serverEntry, resolvedConfig],
    },
    piCompanionExtension: companionEntry,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(`Created ${resolvedConfig}`);
  if (tokenFile) console.log(`Created HTTP token at ${tokenFile} (port ${config.http.port})`);
  console.log('\n1) Add to your MCP client (Claude Desktop, Claude Code, Cursor, Pi, etc.):');
  console.log(JSON.stringify(result.mcpClientConfig, null, 2));
  console.log('\n2) Optional: register live TUI companion in ~/.pi/agent/settings.json:');
  console.log(JSON.stringify({ extensions: [companionEntry] }, null, 2));
  console.log(`\n3) Verify setup:\n   pi-mcp-bridge doctor ${resolvedConfig}`);
  return result;
}

export async function runDoctor(args = []) {
  const { flags, positionals } = parseFlags(args);
  const configPath = path.resolve(positionals[0] ?? path.join(defaultConfigDir(), 'owner.json'));
  const checks = [];
  const record = (name, ok, detail, warn = false) =>
    checks.push({ name, status: ok ? 'ok' : warn ? 'warn' : 'fail', detail });

  const [major, minor] = process.versions.node.split('.').map(Number);
  record(
    'node',
    major > 22 || (major === 22 && minor >= 19),
    `v${process.versions.node} (requires >=22.19.0)`,
  );
  record(
    'platform',
    process.platform === 'linux' || process.platform === 'darwin',
    process.platform,
  );

  let loaded;
  try {
    loaded = await readOwnerConfig(configPath);
    record('owner.json', true, loaded.resolved);
  } catch (error) {
    record('owner.json', false, `${configPath}: ${error.code ?? error.message}`);
  }

  if (loaded) {
    const { config } = loaded;
    try {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(config.stateDir);
      record('stateDir', true, config.stateDir);
    } catch (error) {
      record('stateDir', false, `${config.stateDir}: ${error.message}`);
    }

    for (const root of config.sessionRoots) {
      try {
        await assertNativeDirectory(root);
        record('sessionRoot', true, root);
      } catch (error) {
        record('sessionRoot', false, `${root}: ${error.code ?? error.message}`);
      }
    }

    try {
      const { installation } = await resolvePiLaunch(config);
      record('pi', true, `${installation.command} (${installation.source})`);
    } catch (error) {
      record('pi', false, error.code ?? error.message);
    }

    if (config.http) {
      try {
        const http = await loadHttpConfig(configPath);
        record('http', true, `127.0.0.1:${http.port} (token verified)`);
      } catch (error) {
        record('http', false, error.code ?? error.message);
      }
    }

    const settingsFile = path.join(
      config.piRuntime?.agentDir ?? defaultAgentDir(),
      'settings.json',
    );
    const companionPath = path.join(ROOT, 'src', 'attach-extension.mjs');
    try {
      const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      const registered =
        Array.isArray(settings.extensions) &&
        settings.extensions.some((entry) => path.resolve(entry) === companionPath);
      record(
        'tui-companion',
        registered,
        registered
          ? `registered in ${settingsFile}`
          : `not registered in ${settingsFile} (optional; needed for live Pi TUI control)`,
        true,
      );
    } catch {
      record('tui-companion', false, `could not read ${settingsFile} (optional)`, true);
    }

    const ipcDir = registryDirectory(config);
    try {
      await privateDirectory(ipcDir);
      record('attachmentDir', true, ipcDir);
    } catch (error) {
      record('attachmentDir', false, `${ipcDir}: ${error.code ?? error.message}`);
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  if (flags.json) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const check of checks) {
      const tag = check.status === 'ok' ? 'OK  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
      console.log(`[${tag}] ${check.name}: ${check.detail}`);
    }
  }
  if (!ok) process.exitCode = 1;
  return { ok, checks };
}

function forward(script, scriptArgs) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', script), ...scriptArgs], {
    stdio: 'inherit',
  });
  const onSigint = () => child.kill('SIGINT');
  const onSigterm = () => child.kill('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  child.once('exit', (code, signal) => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function requireArgs(args, min, hint) {
  if (args.length < min || args.slice(0, min).some((a) => !a || a.startsWith('--'))) {
    throw new Error(`Missing required arguments.\nUsage: pi-mcp-bridge ${hint}`);
  }
}

function usage() {
  console.log(`pi-mcp-bridge — MCP bridge for native local Pi sessions

Usage:
  pi-mcp-bridge init [owner.json] [--project DIR] [--http-port PORT] [--force]
  pi-mcp-bridge doctor [owner.json] [--json]
  pi-mcp-bridge stdio <owner.json>
  pi-mcp-bridge http <owner.json>
  pi-mcp-bridge proxy <owner.json>
  pi-mcp-bridge open <owner.json> <session_id>
  pi-mcp-bridge release <owner.json> <session_id> [--interrupt]
  pi-mcp-bridge reset <owner.json> <session_id> --confirm-local-closed`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return initConfig(rest);
    case 'doctor':
      return runDoctor(rest);
    case 'stdio':
      requireArgs(rest, 1, 'stdio <owner.json>');
      return forward('server.mjs', rest);
    case 'http':
      requireArgs(rest, 1, 'http <owner.json>');
      return forward('http-server.mjs', rest);
    case 'proxy':
      requireArgs(rest, 1, 'proxy <owner.json>');
      return forward('stdio-proxy.mjs', rest);
    case 'open':
      requireArgs(rest, 2, 'open <owner.json> <session_id>');
      return forward('open.mjs', rest);
    case 'release':
    case 'reset':
      requireArgs(rest, 2, `${command} <owner.json> <session_id>`);
      return forward('owner-runtime.mjs', [rest[0], command, ...rest.slice(1)]);
    case '-h':
    case '--help':
    case undefined:
      usage();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
