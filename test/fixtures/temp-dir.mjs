import fs from 'node:fs/promises';
import path from 'node:path';

// Darwin's /tmp is a symlink and its per-user temp directory is long. Native
// fixtures need canonical paths that leave room for their Unix socket names.
export async function shortTempDir(prefix = 'pi-') {
  return fs.mkdtemp(path.join(await fs.realpath('/tmp'), prefix));
}
