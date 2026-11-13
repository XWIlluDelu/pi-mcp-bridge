// Pi's AgentSession is a class instance. Test sessions are instances of a fresh
// class, so the binding's admission observer is installed on that class only.
// Supplied members, including accessors, replace these inert defaults.
export function sdkSession(members = {}) {
  class TestSession {}
  const session = Object.assign(new TestSession(), {
    getAllTools: () => [],
    extensionRunner: { getRegisteredCommands: () => [] },
    sessionManager: { getEntries: () => [], getLeafId: () => null, getCwd: () => '/' },
  });
  return Object.defineProperties(session, Object.getOwnPropertyDescriptors(members));
}
