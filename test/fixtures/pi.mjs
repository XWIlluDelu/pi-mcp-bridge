// Tests use an explicitly selected external Pi, never a Bridge dependency.
import { pathToFileURL } from 'node:url';
import { loadPiSdk, piDependencyEntry, loadPiAi } from '../../src/pi-installation.mjs';
import { installation } from './pi-installation.mjs';
export { installation } from './pi-installation.mjs';
export const sdkEntry = pathToFileURL(installation.sdkEntry).href;
export const aiEntry = pathToFileURL(
  await piDependencyEntry(installation, '@earendil-works/pi-ai'),
).href;
export const sdk = await loadPiSdk(installation);
export const {
  AgentSession,
  createAgentSessionRuntime,
  createAgentSession,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createExtensionRuntime,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
  ModelRuntime,
  RpcClient,
  buildSessionProjection,
  parseSessionEntries,
  migrateSessionEntries,
} = sdk;
export const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } =
  await import(aiEntry);
export const { getSupportedThinkingLevels } = await loadPiAi(installation);
