import { sdkEntry } from './pi.mjs';
// Loaded only in the isolated catalog subprocess; never in a user's Pi.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { ModelRuntime, SessionManager, DefaultResourceLoader, AgentSession } from './pi.mjs';

const mark = (value) => fs.appendFileSync(process.env.BRIDGE_CATALOG_MARKER, value + '\n');
const forbidden = () => {
  mark('FORBIDDEN');
  throw new Error('Catalog must not use network, sessions or resources');
};
globalThis.fetch = forbidden;
net.connect =
  net.createConnection =
  tls.connect =
  http.request =
  http.get =
  https.request =
  https.get =
    forbidden;
syncBuiltinESMExports();
for (const method of ['create', 'open', 'continueRecent', 'inMemory', 'list', 'listAll'])
  SessionManager[method] = forbidden;
DefaultResourceLoader.prototype.reload = forbidden;
AgentSession.prototype.bindExtensions = forbidden;
const { ReadOnlyAuthStorage } = await import(new URL('./core/auth-storage.js', sdkEntry).href);
async function mustReject(fn) {
  try {
    await fn();
  } catch {
    return;
  }
  forbidden();
}
const create = ModelRuntime.create;
ModelRuntime.create = async function (options) {
  if (options?.allowModelNetwork !== false || !(options.credentials instanceof ReadOnlyAuthStorage))
    forbidden();
  await mustReject(() => options.credentials.modify('openrouter', forbidden));
  await mustReject(() => options.credentials.delete('openrouter'));
  await mustReject(() => options.modelsStore.write('openrouter', { models: [] }));
  await mustReject(() => options.modelsStore.delete('openrouter'));
  mark('catalog');
  return create.call(this, options);
};
