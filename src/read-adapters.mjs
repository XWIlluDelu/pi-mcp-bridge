// Native input descriptors cross existing owner IPC as data. Optional module
// loading and lifecycle belong to compatibility.mjs, never to this reader.

export function validateReadAdapters(adapters = []) {
  const ids = new Set(),
    types = new Set();
  if (!Array.isArray(adapters)) throw new Error('INVALID_READ_ADAPTER');
  for (const adapter of adapters) {
    if (
      !adapter ||
      typeof adapter !== 'object' ||
      Array.isArray(adapter) ||
      Object.keys(adapter).some((key) => !['id', 'inputCustomTypes'].includes(key)) ||
      typeof adapter.id !== 'string' ||
      !adapter.id ||
      ids.has(adapter.id) ||
      !Array.isArray(adapter.inputCustomTypes) ||
      !adapter.inputCustomTypes.length
    )
      throw new Error('INVALID_READ_ADAPTER');
    ids.add(adapter.id);
    for (const type of adapter.inputCustomTypes) {
      if (typeof type !== 'string' || !type || types.has(type))
        throw new Error('INVALID_READ_ADAPTER');
      types.add(type);
    }
  }
  return adapters;
}
