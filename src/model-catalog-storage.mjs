import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getAgentDir, VERSION } from '@earendil-works/pi-coding-agent';

// SDK 1.3.0's ModelsStore file layout. Model payloads remain native metadata;
// validate the envelope/identity without reimplementing provider discovery.
const cachedModel = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    api: z.string().min(1),
    type: z.enum(['chat', 'image', 'classifier']).optional(),
  })
  .passthrough();
const cacheSchema = z
  .record(
    z
      .object({
        models: z.array(cachedModel),
        lastModified: z.number().finite().optional(),
        checkedAt: z.number().finite().optional(),
        etag: z.string().optional(),
      })
      .strict(),
  )
  .refine((cache) =>
    Object.entries(cache).every(([provider, entry]) =>
      entry.models.every((model) => model.provider === provider),
    ),
  );

export async function readOnlyModelsStore(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const snapshot = cacheSchema.parse(raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : {});
  const rejectWrite = async () => {
    throw new Error('MODEL_CATALOG_READ_ONLY');
  };
  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return Object.hasOwn(snapshot, providerId)
        ? structuredClone(snapshot[providerId])
        : undefined;
    },
    write: rejectWrite,
    delete: rejectWrite,
  };
}

export async function catalogStores() {
  // Narrow, fixed-package dependency: 1.3.0 exports this native CredentialStore
  // from its module, but does not re-export it through dist/index.js.
  if (VERSION !== '1.3.0') throw new Error('MODEL_CATALOG_UNAVAILABLE');
  const { ReadOnlyAuthStorage } = await import(
    new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
  );
  return {
    credentials: new ReadOnlyAuthStorage(),
    modelsStore: await readOnlyModelsStore(path.join(getAgentDir(), 'models-store.json')),
  };
}
