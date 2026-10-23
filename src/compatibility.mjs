// Owner-selected module lifecycle only. Capability-specific APIs belong to services,
// not this loader; modules need not implement a common reading/transform interface.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateCompatibilityModules(entries = []) {
  const files = new Set();
  if (!Array.isArray(entries)) throw new Error('INVALID_COMPATIBILITY_CONFIG');
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !['module', 'enabled', 'options'].includes(key)) ||
      typeof entry.module !== 'string' ||
      !path.isAbsolute(entry.module) ||
      entry.module.includes('\0') ||
      files.has(entry.module) ||
      (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') ||
      (entry.options !== undefined &&
        (!entry.options || typeof entry.options !== 'object' || Array.isArray(entry.options)))
    )
      throw new Error('INVALID_COMPATIBILITY_CONFIG');
    files.add(entry.module);
  }
  return entries;
}

export class CompatibilityModules {
  constructor(entries = [], services = {}) {
    this.entries = entries;
    this.services = services;
    this.active = [];
  }
  start() {
    if (this.closing) return Promise.reject(new Error('COMPATIBILITY_MODULES_CLOSED'));
    return (this.startPromise ??= this.activate());
  }
  async activate() {
    const loaded = [],
      ids = new Set();
    validateCompatibilityModules(this.entries);
    for (const entry of this.entries) {
      if (entry.enabled === false) continue; // Disabled code is not imported.
      let module;
      try {
        module = (await import(pathToFileURL(entry.module).href)).default;
      } catch (cause) {
        throw new Error('COMPATIBILITY_MODULE_LOAD_FAILED', { cause });
      }
      if (
        !module ||
        typeof module !== 'object' ||
        Array.isArray(module) ||
        typeof module.id !== 'string' ||
        !module.id ||
        ids.has(module.id) ||
        typeof module.start !== 'function'
      )
        throw new Error('INVALID_COMPATIBILITY_MODULE');
      ids.add(module.id);
      loaded.push({ module, options: structuredClone(entry.options ?? {}) });
    }
    try {
      for (const { module, options } of loaded) {
        if (this.closing) throw new Error('COMPATIBILITY_MODULES_CLOSED');
        const cleanups = [];
        this.active.push({ id: module.id, cleanups });
        await module.start(
          Object.freeze({
            id: module.id,
            services: this.services,
            onStop(cleanup) {
              if (typeof cleanup !== 'function') throw new Error('INVALID_COMPATIBILITY_MODULE');
              cleanups.push(cleanup);
            },
          }),
          options,
        );
      }
    } catch (cause) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        cause = new AggregateError([cause, cleanupError]);
      }
      throw new Error('COMPATIBILITY_MODULE_START_FAILED', { cause });
    }
    return this;
  }
  async dispose() {
    const errors = [];
    for (const { cleanups } of this.active.splice(0).reverse())
      for (const cleanup of cleanups.reverse())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
    if (errors.length)
      throw new Error('COMPATIBILITY_MODULE_STOP_FAILED', { cause: new AggregateError(errors) });
  }
  stop() {
    this.closing = true;
    return (this.stopPromise ??= (async () => {
      await this.startPromise?.catch(() => {});
      await this.dispose();
    })());
  }
}
