import { readOwnerConfig } from '../core/owner-config.mjs';
import { readPrivateFile } from '../core/storage.mjs';

export const TOKEN_HEADER = 'x-pi-bridge-token';

// HTTP rejections the service issues before admitting any MCP work. The proxy
// reports only these exact code/status pairs as not admitted; any other
// failure, including a timeout or server error, leaves the outcome unknown.
export const NOT_ADMITTED = Object.freeze({
  INVALID_JSON_OBJECT: 400,
  UNAUTHORIZED: 401,
  INVALID_HOST: 403,
  ORIGIN_DENIED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_CONTENT_TYPE: 415,
  SERVICE_STOPPING: 503,
  SERVICE_BUSY: 503,
});

export async function loadHttpConfig(file) {
  const { config } = await readOwnerConfig(file);
  const settings = config.http;
  if (!settings) throw new Error('INVALID_HTTP_CONFIG');
  const token = (await readPrivateFile(settings.tokenFile, 257)).text.replace(/\n$/, '');
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error('INVALID_BACKEND_TOKEN');
  return { config, token, port: settings.port };
}
