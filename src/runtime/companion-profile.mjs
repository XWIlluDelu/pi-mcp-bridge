// Daily native startup reads the existing owner scope; explicit IPC remains
// available for hosts that supply their own registration/admission contract.
import os from 'node:os';
import path from 'node:path';
import { readOwnerConfig, registryDirectory } from '../core/owner-config.mjs';
import { inside } from '../core/permissions.mjs';

export async function readCompanionConfig(file, expectedDir) {
  const { config } = await readOwnerConfig(file);
  const dir = registryDirectory(config);
  if (expectedDir !== undefined && expectedDir !== dir)
    throw new Error('HANDOFF_DIRECTORY_MISMATCH');
  return { config, dir };
}

export async function companionProfile(env = process.env) {
  const explicitFile = env.PI_MCP_OWNER_CONFIG;
  if (env.PI_MCP_ATTACH_DIR && !explicitFile)
    return { dir: env.PI_MCP_ATTACH_DIR, file: undefined, roots: null };
  const file =
    explicitFile ??
    path.join(
      env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), '.config'),
      'pi-mcp-bridge',
      'owner.json',
    );
  let config, dir;
  try {
    ({ config, dir } = await readCompanionConfig(file, env.PI_MCP_ATTACH_DIR || undefined));
  } catch (error) {
    if (!explicitFile && error.code === 'ENOENT') return null;
    throw error;
  }
  return {
    file,
    dir,
    roots: config.sessionRoots,
    ownerControl: { stateDir: config.stateDir, attachmentDir: dir },
  };
}

// Refresh only directory scope at native session admission. IPC identity and the
// already-running Pi installation remain fixed for this companion instance.
export async function currentCompanionScope(profile) {
  if (!profile.file) return profile;
  const { config } = await readCompanionConfig(profile.file, profile.dir);
  return { ...profile, roots: config.sessionRoots };
}

export function companionIncludes(profile, file) {
  return (
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    (profile.roots === null || profile.roots.some((root) => inside(file, root)))
  );
}
