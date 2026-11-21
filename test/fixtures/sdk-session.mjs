// Pi's AgentSession is a class instance. Test sessions are instances of a fresh
// class, so the binding's admission observer is installed on that class only.
// Supplied members, including accessors, replace these inert defaults.
import { AdmissionSession } from './admission-session.mjs';

export function sdkSession(members = {}) {
  class TestSession extends AdmissionSession {}
  const session = Object.assign(new TestSession(), {
    getAllTools: () => [],
    extensionRunner: { getRegisteredCommands: () => [] },
    sessionManager: { getEntries: () => [], getLeafId: () => null, getCwd: () => '/' },
  });
  const descriptors = Object.getOwnPropertyDescriptors(members);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (typeof descriptor.value === 'function' && name in AdmissionSession.prototype) {
      Object.defineProperty(TestSession.prototype, name, descriptor);
      delete descriptors[name];
    }
  }
  return Object.defineProperties(session, descriptors);
}
