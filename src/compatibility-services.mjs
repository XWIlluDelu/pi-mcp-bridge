// Independent capability ports shared by optional modules. No plugin names here.
import { validateReadAdapters } from './read-adapters.mjs';
import { SessionReaders } from './session-readers.mjs';

export class CompatibilityServices {
  constructor() {
    const inputs = new Map(),
      environment = new Map();
    this.sessionReaders = new SessionReaders();
    this.readInputs = Object.freeze({
      register(id, inputCustomTypes) {
        const descriptor = structuredClone({ id, inputCustomTypes });
        validateReadAdapters([...inputs.values(), descriptor]);
        inputs.set(id, descriptor);
        return () => {
          if (inputs.get(id) === descriptor) inputs.delete(id);
        };
      },
      snapshot() {
        return structuredClone([...inputs.values()]);
      },
    });
    this.daemonEnvironment = Object.freeze({
      register(filter) {
        if (typeof filter !== 'function') throw new Error('INVALID_COMPATIBILITY_MODULE');
        const registration = Symbol();
        environment.set(registration, filter);
        return () => environment.delete(registration);
      },
      apply(source) {
        const env = { ...source };
        for (const filter of environment.values()) filter(env);
        return env;
      },
    });
    Object.freeze(this);
  }
}
