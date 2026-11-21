// In-process SDK sessions load the companion with the selected installation's
// native classes, as Pi's loader does for attach-extension.mjs in the CLI.
// Hand-built test APIs supply the members they observe; the remaining
// ExtensionAPI members the companion uses are inert, never absent.
import companion from '../../src/runtime/companion.mjs';
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

function loadCompanion(pi, projection = buildSessionProjection) {
  for (const [name, value] of Object.entries(inert)) if (!(name in pi)) pi[name] = value;
  return companion(pi, { AgentSession, buildSessionProjection: projection });
}

export default function attachExtension(pi) {
  return loadCompanion(pi);
}

export async function companionHooks({ config, cleanup }, projection) {
  const handlers = {};
  const previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = config.attachmentDir;
  try {
    await loadCompanion({ on: (name, handler) => (handlers[name] = handler) }, projection);
  } finally {
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
  cleanup.push(() => handlers.session_shutdown({ reason: 'quit' }));
  return handlers;
}
