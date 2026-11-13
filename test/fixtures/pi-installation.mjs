// Share one external installation across test code and isolated native children.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePiInstallation } from '../../src/pi-installation.mjs';

export const installation = await resolvePiInstallation(
  process.env.BRIDGE_TEST_PI_CLI ? { piExecutable: process.env.BRIDGE_TEST_PI_CLI } : {},
);
if (process.env.BRIDGE_TEST_PI_CLI) {
  // Default test configs and isolated native children also resolve through PATH.
  // Keep them on the explicit installation, including when its CLI is cli.js.
  const bin = mkdtempSync(path.join(tmpdir(), 'pi-bridge-test-bin-'));
  process.once('exit', () => rmSync(bin, { recursive: true, force: true }));
  symlinkSync(installation.cliPath, path.join(bin, 'pi'));
  process.env.PATH = bin + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin');
}
