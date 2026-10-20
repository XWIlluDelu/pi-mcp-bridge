import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// The pin is a test choice, never the production default. An explicit external
// CLI lets the same native regressions run against the user's installation.
export const nativePiCli =
  process.env.BRIDGE_TEST_PI_CLI ??
  fileURLToPath(
    new URL(
      '../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      import.meta.url,
    ),
  );
// Exercise default PATH selection without relying on a globally installed Pi in CI.
// With BRIDGE_TEST_PI_CLI=/absolute/bin/pi, these tests use that actual installation.
export async function nativeInstallation(dir) {
  const implementation = await fs.realpath(nativePiCli);
  if (process.env.BRIDGE_TEST_PI_CLI && path.basename(nativePiCli) === 'pi')
    return {
      executable: nativePiCli,
      implementation,
      PATH: path.dirname(nativePiCli) + path.delimiter + process.env.PATH,
    };
  const bin = path.join(dir, 'native-bin'),
    executable = path.join(bin, 'pi');
  await fs.mkdir(bin, { recursive: true });
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(implementation)} "$@"\n`,
    { mode: 0o700 },
  );
  return { executable, implementation, PATH: bin + path.delimiter + process.env.PATH };
}
// Tests select isolation explicitly. Daily runtime defaults must remain native.
export function isolatedRuntime(dir) {
  return {
    piExecutable: nativePiCli,
    piRuntime: { agentDir: path.join(dir, 'isolated-agent'), inheritEnv: [], tools: [] },
    piArgs: [
      '--offline',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ],
  };
}
