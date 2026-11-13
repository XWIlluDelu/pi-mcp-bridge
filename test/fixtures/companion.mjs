// In-process SDK sessions load the companion with the selected installation's
// native classes, as Pi's loader does for attach-extension.mjs in the CLI.
// Hand-built test APIs supply the members they observe; the remaining
// ExtensionAPI members the companion uses are inert, never absent.
import companion from '../../src/companion.mjs';
import { AgentSession, buildSessionProjection } from './pi.mjs';

const inert = {
  on: () => {},
  registerCommand: () => {},
  registerShortcut: () => {},
  getAllTools: () => [],
  getCommands: () => [],
  getThinkingLevel: () => 'off',
  setModel: async () => true,
  setThinkingLevel: () => {},
  sendUserMessage: () => {},
};

export default function attachExtension(pi) {
  for (const [name, value] of Object.entries(inert)) if (!(name in pi)) pi[name] = value;
  return companion(pi, { AgentSession, buildSessionProjection });
}
