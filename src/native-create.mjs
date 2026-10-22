// Resolve a fresh identity in the same cwd/environment as the owned Pi. No
// extensions, credentials or model runtime are loaded by this preparation step.
import path from 'node:path';
import { SessionManager, SettingsManager, parseArgs } from '@earendil-works/pi-coding-agent';
import { inside } from './permissions.mjs';
import { assertNativeDirectory } from './storage.mjs';

try {
  const { roots, args, parentSession } = JSON.parse(process.argv[2]);
  const cwd = process.cwd();
  const parsed = parseArgs(args);
  const settings = SettingsManager.create(cwd);
  const sessionDir =
    (parsed.sessionDir || undefined) ??
    (process.env.PI_CODING_AGENT_SESSION_DIR || undefined) ??
    settings.getSessionDir();
  // Native create chooses the directory, header, ID and filename but does not
  // write a session until conversation entries are appended. Preserve native
  // umask behavior and validate storage integrity without changing permissions.
  const manager = SessionManager.create(cwd, sessionDir, { parentSession });
  const file = path.resolve(manager.getSessionFile());
  if (!roots.some((root) => inside(file, root))) throw new Error('NATIVE_SESSION_OUTSIDE_ROOTS');
  await assertNativeDirectory(path.dirname(file));
  console.log(JSON.stringify({ file, header: manager.getHeader() }));
} catch (error) {
  console.log(JSON.stringify({ error: error.code ?? error.message }));
}
