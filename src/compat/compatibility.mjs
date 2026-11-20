import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseAs } from '../mcp/schema.mjs';

const entriesSchema = z
  .array(
    z.strictObject({
      module: z.string().refine((file) => path.isAbsolute(file) && !file.includes('\0')),
      enabled: z.boolean().optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .refine((entries) => new Set(entries.map((entry) => entry.module)).size === entries.length);

export const validateCompatibilityModules = (entries = []) =>
  parseAs(entriesSchema, entries, 'INVALID_COMPATIBILITY_CONFIG');

// Preflight the entire set before starting any owner-selected code.
async function load(entries) {
  const modules = new Map();
  for (const { module: file, options, enabled } of entries) {
    if (enabled === false) continue;
    const { default: module } = await import(pathToFileURL(file).href).catch((cause) => {
      throw new Error('COMPATIBILITY_MODULE_LOAD_FAILED', { cause });
    });
    if (
      typeof module?.id !== 'string' ||
      !module.id ||
      modules.has(module.id) ||
      typeof module !== 'object' ||
      Array.isArray(module) ||
      typeof module.start !== 'function'
    )
      throw new Error('INVALID_COMPATIBILITY_MODULE');
    modules.set(module.id, { module, options });
  }
  return modules.values();
}

export function startCompatibilityModules(entries = [], services) {
  const active = [];
  let stopping;
  async function dispose() {
    const errors = [];
    for (const cleanups of active.reverse())
      for (const cleanup of cleanups.reverse())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
    if (errors.length)
      throw new Error('COMPATIBILITY_MODULE_STOP_FAILED', { cause: new AggregateError(errors) });
  }
  const ready = (async () => {
    const modules = await load(entries);
    try {
      for (const { module, options } of modules) {
        if (stopping) throw new Error('COMPATIBILITY_MODULES_CLOSED');
        const cleanups = [];
        active.push(cleanups);
        const onStop = (cleanup) => {
          if (typeof cleanup !== 'function') throw new Error('INVALID_COMPATIBILITY_MODULE');
          cleanups.push(cleanup);
        };
        await module.start(
          Object.freeze({ id: module.id, services, onStop }),
          structuredClone(options ?? {}),
        );
      }
    } catch (cause) {
      try {
        await dispose();
      } catch (error) {
        cause = new AggregateError([cause, error]);
      }
      throw new Error('COMPATIBILITY_MODULE_START_FAILED', { cause });
    }
  })();
  return { ready, stop: () => (stopping ??= ready.then(dispose, () => {})) };
}
