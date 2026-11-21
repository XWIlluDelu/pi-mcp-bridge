import {
  createAgentSession,
  DefaultResourceLoader,
  InMemoryCredentialStore,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './pi.mjs';

export async function offlineModels(faux) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return runtime;
}

export async function sdkSession(
  f,
  modelRuntime,
  model,
  {
    manager = SessionManager.open(f.session.file),
    agentDir = f.config.piRuntime.agentDir,
    extensions = [],
    tools = [],
    settings = {},
  } = {},
) {
  const cwd = f.cwd;
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    retry: { enabled: false },
    compaction: { enabled: false },
    ...settings,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Offline Bridge test.',
    extensionFactories: extensions,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: 'off',
    tools,
    resourceLoader,
    sessionManager: manager,
    settingsManager,
  });
  return session;
}
