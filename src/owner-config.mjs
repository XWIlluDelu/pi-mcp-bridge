// Owner-side configuration edits only. Not exposed as an MCP operation.
import { validateCompatibilityModules } from './compatibility.mjs';
import path from 'node:path';
import { ACTIONS, resolvePermission, inside } from './permissions.mjs';
import { hash, atomicJson, readPrivateFile } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
import { loadPiSdk } from './pi-installation.mjs';
const MAX_OWNER_CONFIG_BYTES = 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = (value) =>
  typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
export function validatePiRuntime(profile = {}) {
  if (
    !object(profile) ||
    Object.keys(profile).some((key) => !['agentDir', 'inheritEnv', 'tools'].includes(key)) ||
    !Array.isArray(profile.inheritEnv ?? []) ||
    (profile.inheritEnv ?? []).some(
      (name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    !Array.isArray(profile.tools ?? []) ||
    (profile.tools ?? []).some(
      (selector) => typeof selector !== 'string' || !selector.trim() || selector.includes('\0'),
    ) ||
    (profile.agentDir !== undefined && !absolute(profile.agentDir))
  )
    throw new Error('INVALID_PI_RUNTIME');
  return profile;
}
// Owner arguments follow the launcher's complete arguments. Use the selected
// Pi's parsing rules to distinguish a selector from an option's value.
export async function validateLaunchArgs(installation, args = [], mode) {
  if (!args.length) return;
  const { parseArgs } = await loadPiSdk(installation);
  const parsed = parseArgs(args);
  if (
    parsed.session !== undefined ||
    parsed.sessionId !== undefined ||
    parsed.fork !== undefined ||
    parsed.continue ||
    parsed.resume ||
    parsed.noSession ||
    (parsed.mode !== undefined && parsed.mode !== mode) ||
    parsed.print ||
    parsed.export !== undefined ||
    parsed.help ||
    parsed.version ||
    parsed.listModels !== undefined ||
    parsed.fileArgs.length ||
    parsed.diagnostics.some(({ type }) => type === 'error')
  )
    throw new Error(mode === 'rpc' ? 'UNSAFE_PI_ARGS' : 'UNSAFE_OPEN_PI_ARGS');
}
// Shape validation is shared by initialization, file reload and both transports.
// Filesystem existence/privacy and execution-time cwd checks remain separate.
export function validateOwnerConfig(config) {
  if (
    !object(config) ||
    !absolute(config.stateDir) ||
    !Array.isArray(config.sessionRoots) ||
    !config.sessionRoots.length ||
    config.sessionRoots.some((root) => !absolute(root)) ||
    !Array.isArray(config.folders)
  )
    throw new Error('INVALID_OWNER_CONFIG');
  const fields = new Set([
    'stateDir',
    'sessionRoots',
    'attachmentDir',
    'attachmentExitTimeoutMs',
    'folders',
    'defaults',
    'grants',
    'http',
    'piExecutable',
    'piArgs',
    'piRuntime',
    'compatibilityModules',
    'herdr',
  ]);
  if (Object.keys(config).some((key) => !fields.has(key))) throw new Error('INVALID_OWNER_CONFIG');
  const paths = new Set();
  for (const folder of config.folders) {
    if (
      !object(folder) ||
      paths.has(folder.path) ||
      Object.keys(folder).some((key) => key !== 'path') ||
      !absolute(folder.path)
    )
      throw new Error('INVALID_PROJECT_FOLDER');
    paths.add(folder.path);
  }
  validatePermissionValues(config.defaults);
  validateGrants(config.grants);
  validateCompatibilityModules(config.compatibilityModules);
  if (
    (config.herdr !== undefined && typeof config.herdr !== 'boolean') ||
    (config.attachmentDir !== undefined && !absolute(config.attachmentDir)) ||
    (config.attachmentExitTimeoutMs !== undefined &&
      (!Number.isInteger(config.attachmentExitTimeoutMs) ||
        config.attachmentExitTimeoutMs < 50 ||
        config.attachmentExitTimeoutMs > 30000)) ||
    (config.piExecutable !== undefined && !absolute(config.piExecutable)) ||
    (config.piArgs !== undefined &&
      (!Array.isArray(config.piArgs) ||
        config.piArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0'))))
  )
    throw new Error('INVALID_OWNER_CONFIG');
  validatePiRuntime(config.piRuntime);
  const dirs = [config.stateDir, ...config.sessionRoots];
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++)
      if (inside(dirs[i], dirs[j]) || inside(dirs[j], dirs[i]))
        throw new Error('OVERLAPPING_STORAGE');
  if (config.http !== undefined) {
    const settings = config.http;
    if (
      !object(settings) ||
      !Number.isInteger(settings.port) ||
      settings.port < 1 ||
      settings.port > 65535 ||
      !absolute(settings.tokenFile) ||
      Object.keys(settings).some((key) => !['port', 'tokenFile'].includes(key))
    )
      throw new Error('INVALID_HTTP_CONFIG');
  }
  return config;
}
function validatePermissionValues(values, scopeKeys = []) {
  if (
    !object(values) ||
    Object.keys(values).some((key) => !ACTIONS.includes(key) && !scopeKeys.includes(key))
  )
    throw new Error('INVALID_PERMISSION_FIELD');
  for (const action of ACTIONS)
    if (
      Object.hasOwn(values, action) &&
      values[action] !== null &&
      typeof values[action] !== 'boolean'
    )
      throw new Error('INVALID_OWNER_CONFIG');
}
export function validateGrants(grants = []) {
  if (!Array.isArray(grants)) throw new Error('INVALID_OWNER_CONFIG');
  for (const rule of grants) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
      throw new Error('INVALID_OWNER_CONFIG');
    const session = Object.hasOwn(rule, 'session_id'),
      folder = Object.hasOwn(rule, 'folder');
    if (session === folder) throw new Error('INVALID_OWNER_CONFIG');
    if (
      session &&
      (typeof rule.session_id !== 'string' ||
        rule.session_id.length === 0 ||
        rule.session_id.length > 128)
    )
      throw new Error('INVALID_OWNER_CONFIG');
    if (folder && !absolute(rule.folder)) throw new Error('INVALID_OWNER_CONFIG');
    validatePermissionValues(rule, ['session_id', 'folder']);
    if (session && Object.hasOwn(rule, 'create')) throw new Error('CREATE_REQUIRES_PROJECT_SCOPE');
  }
  return grants;
}
export async function readOwnerConfig(file) {
  const { text: raw, mode } = await readPrivateFile(file, MAX_OWNER_CONFIG_BYTES, {
    pathError: 'INVALID_OWNER_CONFIG_PATH',
    privacyError: 'OWNER_CONFIG_NOT_PRIVATE',
  });
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_OWNER_CONFIG');
  }
  validateOwnerConfig(config);
  return { config, revision: hash(raw), mode };
}
export function permissionDetails(config, action, target) {
  const { allowed, explicit, sourceScope } = resolvePermission(config, action, target);
  const source = sourceScope?.session_id
    ? 'this session'
    : sourceScope?.folder
      ? !target.session_id && sourceScope.folder === path.resolve(target.folder ?? target.cwd)
        ? 'this project'
        : `project ${sourceScope.folder}`
      : 'default';
  return { allowed, explicit, source };
}
export async function editPermission(file, revision, target, action, value) {
  if (
    !ACTIONS.includes(action) ||
    ![true, false, null].includes(value) ||
    (target.session_id && action === 'create')
  )
    throw new Error('INVALID_PERMISSION_EDIT');
  const scope = target.default
    ? {}
    : target.session_id
      ? { session_id: target.session_id }
      : { folder: target.folder };
  if (!target.default) validateGrants([{ ...scope, [action]: value }]);
  // Project grants address the recorded identity, not the current filesystem.
  // Editing policy must remain possible after cleanup or symlink replacement.
  if (scope.folder) scope.folder = path.resolve(scope.folder);
  const lock = await kernelLock('permissions:' + file, { busy: 'OWNER_CONFIG_BUSY' });
  try {
    const readCurrent = async () => {
      const current = await readOwnerConfig(file);
      if (current.revision !== revision) throw new Error('OWNER_CONFIG_CHANGED');
      return current;
    };
    const { config, mode } = await readCurrent();
    let rule;
    if (target.default) {
      rule = config.defaults;
    } else {
      config.grants ??= [];
      rule = config.grants.findLast((r) =>
        scope.session_id
          ? r.session_id === scope.session_id
          : !r.session_id && path.resolve(r.folder) === scope.folder,
      );
      if (!rule) {
        rule = { ...scope };
        config.grants.push(rule);
      }
    }
    rule[action] = value;
    await atomicJson(file, config, {
      mode,
      beforeRename: readCurrent,
      maxBytes: MAX_OWNER_CONFIG_BYTES,
    });
    return await readOwnerConfig(file);
  } finally {
    await lock.close();
  }
}
