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
async function inspect(command) {
  const physical = await fs.realpath(command);
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
  if (!found) throw new Error('PI_INSTALLATION_UNAVAILABLE');
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
export async function resolvePiInstallation(config = {}, env = process.env, cwd = process.cwd()) {
  if (config.piExecutable !== undefined) {
    const command = config.piExecutable;
    if (typeof command !== 'string' || !path.isAbsolute(command) || command.includes('\0'))
      throw new Error('INVALID_PI_EXECUTABLE');
    await executable(command);
    return inspect(command);
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
export async function loadPiAi(installation, subpath = './compat') {
  return import(
    pathToFileURL(await piDependencyEntry(installation, '@earendil-works/pi-ai', subpath)).href
  );
}
export async function nativeSdk(config = {}, env = process.env, cwd = process.cwd()) {
  return loadPiSdk(await resolvePiInstallation(config, env, cwd));
}
