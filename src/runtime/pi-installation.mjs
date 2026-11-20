// One external installation supplies both execution and native data APIs.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
const packageName = '@earendil-works/pi-coding-agent';

async function executable(file) {
  const stat = await fs.stat(file).catch((error) => {
    throw new Error(
      ['ENOENT', 'ENOTDIR'].includes(error.code)
        ? 'PI_EXECUTABLE_NOT_FOUND'
        : 'PI_EXECUTABLE_NOT_EXECUTABLE',
    );
  });
  if (!stat.isFile()) throw new Error('PI_EXECUTABLE_NOT_EXECUTABLE');
  await fs.access(file, constants.X_OK).catch(() => {
    throw new Error('PI_EXECUTABLE_NOT_EXECUTABLE');
  });
}
async function manifest(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
}
function packageEntry(root, field) {
  if (typeof field !== 'string' || path.isAbsolute(field))
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  const file = path.resolve(root, field),
    relative = path.relative(root, file);
  if (relative.startsWith('..' + path.sep) || relative === '..')
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  return file;
}
function importEntry(exports) {
  return typeof exports === 'string' ? exports : exports?.import;
}
async function inspectPackage(command, physical) {
  let directory = path.dirname(physical),
    found;
  while (true) {
    const value = await manifest(directory).catch(() => null);
    if (value?.name === packageName) {
      found = { root: directory, value };
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!found) return null;
  const { root, value } = found;
  const cliPath = packageEntry(root, value.bin?.pi);
  const sdkEntry = packageEntry(root, importEntry(value.exports?.['.']));
  if ((await fs.realpath(cliPath)) !== physical || typeof value.version !== 'string')
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  await fs.access(sdkEntry).catch(() => {
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  });
  return { command, packageRoot: root, cliPath, sdkEntry, version: value.version };
}
async function inspect(command) {
  const launcher = await fs.realpath(command);
  const installation = await inspectPackage(command, launcher);
  if (installation) return installation;
  // The official installer publishes a launcher at <agent>/bin/pi. Its marker
  // defines the current release layout; arbitrary shell wrappers are not parsed.
  if (path.basename(launcher) !== 'pi' || path.basename(path.dirname(launcher)) !== 'bin')
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  const managedRoot = path.join(path.dirname(path.dirname(launcher)), 'install');
  try {
    const marker = JSON.parse(
      (await fs.readFile(path.join(managedRoot, 'managed-install.json'), 'utf8')).replace(
        /^\uFEFF/u,
        '',
      ),
    );
    if (
      marker.kind !== 'pi-managed-install' ||
      marker.schemaVersion !== 1 ||
      marker.layout !== 'releases-v1'
    )
      throw new Error();
    const version = (await fs.readFile(path.join(managedRoot, 'current-version'), 'utf8')).trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
      throw new Error();
    const release = path.join(managedRoot, 'releases', version, 'node_modules', '.bin', 'pi');
    await executable(release);
    const selected = await inspectPackage(release, await fs.realpath(release));
    if (!selected || selected.version !== version) throw new Error();
    // Do not invoke the switching launcher after binding this release's SDK.
    return { ...selected, command: selected.cliPath, managedRoot };
  } catch {
    throw new Error('PI_INSTALLATION_UNAVAILABLE');
  }
}
export async function resolvePiInstallation(config = {}, env = process.env, cwd = process.cwd()) {
  if (config.piExecutable !== undefined) {
    await executable(config.piExecutable);
    return inspect(config.piExecutable);
  }
  for (const directory of (env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    const command = path.resolve(cwd, directory, 'pi');
    try {
      await executable(command);
    } catch {
      continue;
    }
    return inspect(command);
  }
  throw new Error('PI_EXECUTABLE_NOT_FOUND');
}
// Keep launcher environment semantics in one place without putting credentials
// into installation metadata, which native helpers receive through argv.
export async function piLaunchEnvironment(installation, env, cwd = process.cwd()) {
  const next = { ...env };
  if (!installation.managedRoot) return next;
  next.PI_MANAGED_INSTALL_ROOT = installation.managedRoot;
  const nodeBin = path.resolve(
    cwd,
    env.XDG_DATA_HOME || `${env.HOME ?? ''}/.local/share`,
    'pi-node/current/bin',
  );
  try {
    await executable(path.join(nodeBin, 'node'));
    next.PATH = nodeBin + path.delimiter + (env.PATH ?? '');
  } catch {
    // The installer uses the existing Node when it did not install its own.
  }
  return next;
}
export function launchProfile(config, hostEnv = process.env) {
  const { inheritEnv, tools, agentDir } = config.piRuntime ?? {};
  const env =
    inheritEnv === undefined
      ? { ...hostEnv }
      : Object.fromEntries(
          inheritEnv
            .filter((name) => hostEnv[name] !== undefined)
            .map((name) => [name, hostEnv[name]]),
        );
  if (inheritEnv !== undefined) env.PATH ??= hostEnv.PATH ?? '/usr/bin:/bin';
  if (agentDir !== undefined) env.PI_CODING_AGENT_DIR = agentDir;
  return {
    env,
    toolArgs:
      tools === undefined ? [] : tools.length ? ['--tools', tools.join(',')] : ['--no-tools'],
  };
}
export async function resolvePiLaunch(config, cwd, hostEnv) {
  const { env, toolArgs } = launchProfile(config, hostEnv);
  const installation = await resolvePiInstallation(config, env);
  return { installation, toolArgs, env: await piLaunchEnvironment(installation, env, cwd) };
}
export function loadPiSdk(installation) {
  return import(pathToFileURL(installation.sdkEntry).href);
}
// Resolve Pi's dependency, not a similarly named package next to Bridge.
export async function piDependencyEntry(installation, name, subpath = '.') {
  const file = findPackageJSON(name, pathToFileURL(installation.sdkEntry).href);
  if (!file) throw new Error('PI_INSTALLATION_UNAVAILABLE');
  const root = path.dirname(file),
    value = await manifest(root);
  return packageEntry(root, importEntry(value.exports?.[subpath]));
}
export async function loadPiAi(installation) {
  return import(
    pathToFileURL(await piDependencyEntry(installation, '@earendil-works/pi-ai', './models')).href
  );
}
export async function nativeSdk(config = {}, env = process.env, cwd = process.cwd()) {
  return loadPiSdk(await resolvePiInstallation(config, env, cwd));
}
