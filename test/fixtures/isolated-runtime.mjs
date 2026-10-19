import path from 'node:path';
// Tests select isolation explicitly. Daily runtime defaults must remain native.
export function isolatedRuntime(dir) {
  return {
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
