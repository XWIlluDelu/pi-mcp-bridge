// Native RPC has no acknowledgment for extension_ui_response.
export const uiFacts = () => ({ cancel_sent: new Set(), startup: new Set(), shutdown: new Set() });
export function uiSnapshot(facts) {
  if (!facts) return {};
  const unavailable = ['startup', 'shutdown']
    .filter((phase) => facts[phase].size)
    .map((phase) => ({ phase, methods: [...facts[phase]] }));
  if (!facts.cancel_sent.size && !unavailable.length) return {};
  return {
    ui: {
      cancel_sent: [...facts.cancel_sent],
      completion: 'unconfirmed',
      ...(unavailable.length ? { unavailable } : {}),
    },
  };
}
