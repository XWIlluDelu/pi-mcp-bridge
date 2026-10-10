// Offline SDK smoke test for @earendil-works/pi-coding-agent 1.1.0.
// Run from the bridge directory in a clean environment:
// env -i PATH="$PATH" HOME=/tmp/pi-fake-unused-home PI_OFFLINE=1 \
//   node research/fake-sdk.mjs
// Only synthetic in-memory data is used. No model credentials are required.
import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

if (process.env.PI_OFFLINE !== "1") {
  throw new Error("Run this synthetic test with PI_OFFLINE=1 in a clean environment.");
}

// Guard accidental HTTP fetches; the faux provider only emits scripted events.
globalThis.fetch = async () => { throw new Error("Network is disabled in this synthetic test"); };

const cwd = process.cwd();
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const faux = fauxProvider({ provider: "bridge-fixture" });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Synthetic response; no model was contacted.")]);

const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a deterministic synthetic test.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
const sessionManager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({
  cwd,
  agentDir: "/tmp/pi-fake-unused-agent-dir",
  modelRuntime,
  model: faux.getModel(),
  thinkingLevel: "off",
  tools: [],
  resourceLoader,
  sessionManager,
  settingsManager: SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
});
const eventTypes = [];
const unsubscribe = session.subscribe((event) => eventTypes.push(event.type));
try {
  await session.prompt("Return the scripted response.");
  const assistant = session.messages.findLast((message) => message.role === "assistant");
  assert.equal(assistant?.content[0]?.text, "Synthetic response; no model was contacted.");
  assert.equal(assistant.stopReason, "stop");
  assert.equal(faux.state.callCount, 1);
  assert.equal(sessionManager.getSessionFile(), undefined);
  const entries = sessionManager.getEntries();
  const context = buildSessionContext(entries, sessionManager.getLeafId());
  assert.equal(convertToLlm(context.messages).at(-1)?.role, "assistant");
  console.log(JSON.stringify({
    ok: true,
    fakeCalls: faux.state.callCount,
    persistedSessionFile: sessionManager.getSessionFile() ?? null,
    entryCount: entries.length,
    model: context.model,
    events: [...new Set(eventTypes)],
  }, null, 2));
} finally {
  unsubscribe();
  session.dispose();
}
