import path from 'node:path';
import fs from 'node:fs/promises';
import { installation } from './pi.mjs';
// An external CLI supplies all native regression APIs and execution.
export const nativePiCli = installation.cliPath;
// Exercise default PATH selection without relying on a globally installed Pi in CI.
// With BRIDGE_TEST_PI_CLI=/absolute/bin/pi, these tests use that actual installation.
export async function nativeInstallation(dir) {
  const implementation = await fs.realpath(nativePiCli);
  const bin = path.join(dir, 'native-bin'),
    executable = path.join(bin, 'pi');
  await fs.mkdir(bin, { recursive: true });
  await fs.symlink(implementation, executable);
  return { executable, implementation, PATH: bin + path.delimiter + process.env.PATH };
}
// Tests select isolation explicitly. Daily runtime defaults must remain native.
export function isolatedRuntime(dir) {
  return {
    piExecutable: nativePiCli,
    piRuntime: { agentDir: path.join(dir, 'isolated-agent'), inheritEnv: [], tools: [] },
    piArgs: [
      '--session-dir',
      path.join(dir, 'sessions'),
      '--offline',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ],
  };
}
