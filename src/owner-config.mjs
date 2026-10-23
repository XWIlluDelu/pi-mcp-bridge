// Owner-side configuration edits only. Not exposed as an MCP operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIONS, resolvePermission, inside } from './permissions.mjs';
import { hash, syncDir, readPrivateFile } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
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
      (name) => !['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'].includes(name),
    ) ||
    (profile.agentDir !== undefined && !absolute(profile.agentDir))
  )
    throw new Error('INVALID_PI_RUNTIME');
  return profile;
}
// Both launchers own session selection and mode. Native resource/model/storage
// options remain available; a saved session may only be opened after reservation.
export function validateLaunchArgs(args = [], code = 'UNSAFE_PI_ARGS') {
  if (
    !Array.isArray(args) ||
    args.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.includes('\0') ||
        /^(?:--(?:session(?:-id)?|continue|resume|fork|no-session|mode|print|export)|-[crp])(?:=|$)/.test(
          arg,
        ) ||
        arg.startsWith('@') ||
        arg === '--',
    )
  )
    throw new Error(code);
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
  // An explicit baseline for every right distinguishes shell from stop without
  // interpreting an incomplete policy from a different permission vocabulary.
  if (ACTIONS.some((action) => !Object.hasOwn(config.defaults, action)))
    throw new Error('INVALID_OWNER_CONFIG');
  validateGrants(config.grants);
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
export function validatePermissionValues(values, scopeKeys = []) {
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
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw new Error('INVALID_OWNER_CONFIG_PATH');
  const { text: raw, mode } = await readPrivateFile(file, 1024 * 1024, {
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
  if (target.default) validatePermissionValues({ [action]: value });
  else validateGrants([{ ...scope, [action]: value }]);
  // Project grants address the recorded identity, not the current filesystem.
  // Editing policy must remain possible after cleanup or symlink replacement.
  if (scope.folder) scope.folder = path.resolve(scope.folder);
  await readOwnerConfig(file); // Validate the canonical private namespace first.
  const lock = await kernelLock('permissions:' + file, { busy: 'OWNER_CONFIG_BUSY' });
  let temporary;
  try {
    const current = await readOwnerConfig(file);
    if (current.revision !== revision) throw new Error('OWNER_CONFIG_CHANGED');
    const config = structuredClone(current.config);
    config.grants ??= [];
    let rule;
    if (target.default) {
      rule = config.defaults;
    } else {
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
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = await fs.open(temporary, 'wx', current.mode);
    try {
      await fd.writeFile(JSON.stringify(config, null, 2) + '\n');
      await fd.sync();
    } finally {
      await fd.close();
    }
    // Detect non-cooperating editor changes during preparation as well.
    if ((await readOwnerConfig(file)).revision !== revision)
      throw new Error('OWNER_CONFIG_CHANGED');
    await fs.rename(temporary, file);
    temporary = null;
    await syncDir(path.dirname(file));
    return await readOwnerConfig(file);
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    await lock.close();
  }
}
