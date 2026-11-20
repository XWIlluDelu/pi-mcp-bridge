// Owner-side configuration edits only. Not exposed as an MCP operation.
import { validateCompatibilityModules } from '../compat/compatibility.mjs';
import path from 'node:path';
import { z } from 'zod';
import { ACTIONS, resolvePermission, inside } from './permissions.mjs';
import { hash, atomicJson, readPrivateFile } from './storage.mjs';
import { kernelLock } from './kernel-lock.mjs';
import { loadPiSdk } from '../runtime/pi-installation.mjs';
const MAX_OWNER_CONFIG_BYTES = 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = (value) =>
  typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const absolutePath = z.string().refine(absolute);
const textArgument = z.string().refine((value) => !value.includes('\0'));
const projectFolder = z.strictObject({ path: absolutePath });
const ownerShape = z.strictObject({
  stateDir: absolutePath,
  sessionRoots: z.array(absolutePath).min(1),
  attachmentDir: absolutePath.optional(),
  attachmentExitTimeoutMs: z.number().int().min(50).max(30000).optional(),
  folders: z.array(z.unknown()),
  defaults: z.unknown().optional(),
  grants: z.unknown().optional(),
  http: z.unknown().optional(),
  piExecutable: absolutePath.optional(),
  piArgs: z.array(textArgument).optional(),
  piRuntime: z.unknown().optional(),
  compatibilityModules: z.unknown().optional(),
  herdr: z.boolean().optional(),
});
const piRuntimeShape = z.strictObject({
  agentDir: absolutePath.optional(),
  inheritEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).nullish(),
  tools: z.array(textArgument.refine((value) => Boolean(value.trim()))).nullish(),
});
const httpShape = z.strictObject({
  port: z.number().int().min(1).max(65535),
  tokenFile: absolutePath,
});
// The one shared owner registry for every cooperating writer of this configuration.
export const registryDirectory = (config) =>
  config.attachmentDir ?? path.join(config.stateDir, 'ipc');
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
  if (!ownerShape.safeParse(config).success) throw new Error('INVALID_OWNER_CONFIG');
  const paths = new Set();
  for (const folder of config.folders) {
    if (!projectFolder.safeParse(folder).success || paths.has(folder.path))
      throw new Error('INVALID_PROJECT_FOLDER');
    paths.add(folder.path);
  }
  validatePermissionValues(config.defaults);
  validateGrants(config.grants);
  validateCompatibilityModules(config.compatibilityModules);
  if (config.piRuntime !== undefined && !piRuntimeShape.safeParse(config.piRuntime).success)
    throw new Error('INVALID_PI_RUNTIME');
  const dirs = [config.stateDir, ...config.sessionRoots];
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++)
      if (inside(dirs[i], dirs[j]) || inside(dirs[j], dirs[i]))
        throw new Error('OVERLAPPING_STORAGE');
  if (config.http !== undefined && !httpShape.safeParse(config.http).success)
    throw new Error('INVALID_HTTP_CONFIG');
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
export async function readOwnerConfig(file, { cached } = {}) {
  // owner.json contains no secrets (tokens live in separate 0600 files).
  // Require owner UID and reject group/other write access, while allowing
  // ordinary read modes (e.g. 0644) and symlinks (e.g. dotfiles/Nix).
  const {
    text: raw,
    mode,
    resolved,
  } = await readPrivateFile(file, MAX_OWNER_CONFIG_BYTES, {
    pathError: 'INVALID_OWNER_CONFIG_PATH',
    privacyError: 'OWNER_CONFIG_NOT_PRIVATE',
    allowGroupOtherRead: true,
    followSymlinks: true,
  });
  if (cached && cached.raw === raw) return { ...cached, mode, resolved, unchanged: true };
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_OWNER_CONFIG');
  }
  validateOwnerConfig(config);
  return { config, raw, revision: hash(raw), mode, resolved, unchanged: false };
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
    const { config, mode, resolved } = await readCurrent();
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
    await atomicJson(resolved, config, {
      mode,
      beforeRename: readCurrent,
      maxBytes: MAX_OWNER_CONFIG_BYTES,
    });
    return await readOwnerConfig(file);
  } finally {
    await lock.close();
  }
}
