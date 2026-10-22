// Tests use an explicitly selected external Pi, never a Bridge dependency.
import { pathToFileURL } from 'node:url';
import {
  resolvePiInstallation,
  loadPiSdk,
  piDependencyEntry,
  loadPiAi,
} from '../../src/pi-installation.mjs';
export const installation = await resolvePiInstallation(
  process.env.BRIDGE_TEST_PI_CLI ? { piExecutable: process.env.BRIDGE_TEST_PI_CLI } : {},
);
export const sdkEntry = pathToFileURL(installation.sdkEntry).href;
export const aiEntry = pathToFileURL(
  await piDependencyEntry(installation, '@earendil-works/pi-ai'),
).href;
export const sdk = await loadPiSdk(installation);
export const {
  AgentSession,
  AgentSessionRuntime,
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
export const {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  AssistantMessageEventStream,
} = await import(aiEntry);
export const { getSupportedThinkingLevels } = await loadPiAi(installation);
