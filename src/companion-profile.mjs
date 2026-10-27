// Daily native startup reads the existing owner scope; explicit IPC remains
// available for hosts that supply their own registration/admission contract.
import os from 'node:os';
import path from 'node:path';
import { readOwnerConfig } from './owner-config.mjs';
import { inside } from './permissions.mjs';

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
  let config;
  try {
    ({ config } = await readOwnerConfig(file));
  } catch (error) {
    if (!explicitFile && error.code === 'ENOENT') return null;
    throw error;
  }
  const dir = config.attachmentDir ?? path.join(config.stateDir, 'ipc');
  if (env.PI_MCP_ATTACH_DIR && env.PI_MCP_ATTACH_DIR !== dir)
    throw new Error('HANDOFF_DIRECTORY_MISMATCH');
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
  const { config } = await readOwnerConfig(profile.file);
  if ((config.attachmentDir ?? path.join(config.stateDir, 'ipc')) !== profile.dir)
    throw new Error('HANDOFF_DIRECTORY_MISMATCH');
  return { ...profile, roots: config.sessionRoots };
}

export function companionIncludes(profile, file) {
  return (
    typeof file === 'string' &&
    path.isAbsolute(file) &&
    (profile.roots === null || profile.roots.some((root) => inside(file, root)))
  );
}
