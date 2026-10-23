// Live native tool/command registration is session-local evidence, not package discovery.
// Adapters decide which registrations identify the extension they support.
export function nativeReadFeatures(allTools, commands, leafId) {
  return assertReadFeatures({
    available: Array.isArray(allTools) || Array.isArray(commands),
    tools: (allTools ?? []).map((tool) => tool.name),
    commands: (commands ?? []).map((command) => command.name),
    leaf_id: leafId ?? null,
  });
}
export async function ownerReadFeatures(runtime) {
  return typeof runtime?.readFeatures === 'function'
    ? runtime.readFeatures()
    : nativeReadFeatures(undefined, undefined, null);
}
export function assertReadFeatures(value) {
  if (
    !value ||
    typeof value.available !== 'boolean' ||
    !Array.isArray(value.tools) ||
    !value.tools.every((name) => typeof name === 'string') ||
    !Array.isArray(value.commands) ||
    !value.commands.every((name) => typeof name === 'string') ||
    !(value.leaf_id === null || typeof value.leaf_id === 'string')
  )
    throw new Error('INVALID_READ_FEATURES');
  return {
    available: value.available,
    tools: [...value.tools],
    commands: [...value.commands],
    leaf_id: value.leaf_id,
  };
}
