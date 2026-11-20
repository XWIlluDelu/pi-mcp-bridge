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
const validNames = (values) =>
  Array.isArray(values) && values.every((name) => typeof name === 'string');

export function assertReadFeatures(value) {
  const { available, tools, commands, leaf_id } = value ?? {};
  if (
    typeof available !== 'boolean' ||
    !validNames(tools) ||
    !validNames(commands) ||
    !(leaf_id === null || typeof leaf_id === 'string')
  )
    throw new Error('INVALID_READ_FEATURES');
  return { available, tools: [...tools], commands: [...commands], leaf_id };
}
