import http from 'node:http';
import { publicError } from './errors.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Bridge } from './bridge.mjs';
import { diagnostics } from './diagnostics.mjs';
import {
  isRpcRequest,
  dispatchModern,
  validateModernHeaders,
  readJson,
  rpcError,
  MCP_INPUT_LIMIT,
} from './protocol.mjs';
import { loadHttpConfig, TOKEN_HEADER, NOT_ADMITTED, assertBackendToken } from './http-config.mjs';

const digest = (value) => createHash('sha256').update(value).digest();

const refuse = (res, code) => respond(res, NOT_ADMITTED[code], { error: code }, true);
function respond(res, status, message, close = false) {
  if (res.destroyed || res.writableEnded) return;
  if (close) diagnostics.emit('http.rejected', { http_status: status });
  else
    diagnostics.emit('http.rpc_response', {
      http_status: status,
      rpc_status: message.error ? 'error' : 'result',
      rpc_code: message.error?.code,
      callback_reason: message.error?.data?.reason,
    });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(JSON.stringify(message));
}
async function parseBody(req) {
  try {
    // Preserve the socket long enough to send 413 after abandoning an upload.
    const value = await readJson(
      req.iterator({ destroyOnReturn: false }),
      MCP_INPUT_LIMIT,
      'BODY_TOO_LARGE',
    );
    // The MCP batch tool is supported; JSON-RPC envelope arrays are not.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.message === 'BODY_TOO_LARGE') throw error;
    throw new Error('INVALID_JSON_OBJECT');
  }
}

export function createHttpService(bridge, { token, port = 0, waitTimeoutMs = 35000 }) {
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 300000)
    throw new Error('INVALID_WAIT_TIMEOUT');
  assertBackendToken(token);
  const tokenDigest = digest(token),
    requests = new Map();
  let stopping = false,
    closing,
    allowedHosts;
  const listener = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
    (req, res) => {
      req.on('error', () => {});
      res.on('error', () => res.destroy());
      diagnostics.withContext({}, () => {
        const started = performance.now(),
          log = diagnostics.capture();
        log('http.received');
        res.once('close', () =>
          log('http.closed', {
            duration_ms: performance.now() - started,
            http_status: res.statusCode,
            response_finished: res.writableFinished,
          }),
        );
        void handle(req, res).catch(() => respond(res, 500, { error: 'REQUEST_FAILED' }, true));
      });
    },
  );
  listener.maxConnections = 32;
  async function handle(req, res) {
    const headers = req.headersDistinct;
    const host = headers.host;
    if (host?.length !== 1 || !allowedHosts.includes(host[0])) return refuse(res, 'INVALID_HOST');
    if (headers.origin) return refuse(res, 'ORIGIN_DENIED');
    const credentials = headers[TOKEN_HEADER];
    if (credentials?.length !== 1 || !timingSafeEqual(digest(credentials[0]), tokenDigest))
      return refuse(res, 'UNAUTHORIZED');
    if (req.url !== '/mcp') return refuse(res, 'NOT_FOUND');
    if (req.method !== 'POST') return refuse(res, 'METHOD_NOT_ALLOWED');
    if (stopping) return refuse(res, 'SERVICE_STOPPING');
    if (requests.size >= 16) return refuse(res, 'SERVICE_BUSY');
    const contentType = headers['content-type'];
    if (
      contentType?.length !== 1 ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0]) ||
      headers['content-encoding']
    )
      return refuse(res, 'UNSUPPORTED_CONTENT_TYPE');
    if (Number(headers['content-length']?.[0]) > MCP_INPUT_LIMIT)
      return refuse(res, 'BODY_TOO_LARGE');
    requests.set(res, null);
    let deadline;
    res.once('close', () => {
      clearTimeout(deadline);
      if (!requests.get(res)) requests.delete(res);
    });
    let body;
    try {
      body = await parseBody(req);
    } catch (error) {
      // Upload/parse failures happen before admission; others stay unknown.
      if (Object.hasOwn(NOT_ADMITTED, error.message)) return refuse(res, error.message);
      throw error;
    }
    try {
      if (res.destroyed) return;
      if (stopping) return refuse(res, 'SERVICE_STOPPING');
      diagnostics.emit('http.request', { method: body.method });
      if (!isRpcRequest(body) || body.id === undefined)
        return respond(res, 400, rpcError(null, -32600, 'Invalid request'));
      const mismatch = validateModernHeaders(body, (name) => headers[name] ?? []);
      if (mismatch) return respond(res, 400, mismatch);
      deadline = setTimeout(() => {
        respond(
          res,
          504,
          rpcError(body.id, -32000, 'REQUEST_WAIT_EXPIRED', {
            recovery:
              'OUTCOME_UNKNOWN; timeout does not stop submitted Pi work. Inspect list/read before deciding whether to submit again. Do not automatically resubmit.',
          }),
        );
      }, waitTimeoutMs);
      deadline.unref();
      const response = await dispatchModern(bridge, body, {
        execute(run) {
          // Keep admitted work in the request map after the response closes.
          const task = Promise.resolve().then(run);
          requests.set(res, task);
          return task;
        },
      });
      respond(res, response.status, response.message);
    } finally {
      clearTimeout(deadline);
      if (res.destroyed) requests.delete(res);
      else requests.set(res, null);
    }
  }
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', reject);
          resolve();
        });
      });
      const authority = `127.0.0.1:${listener.address().port}`;
      const endpoint = new URL(`http://${authority}/mcp`);
      // HTTP clients normally omit the default port from Host.
      allowedHosts = [authority, endpoint.host];
      diagnostics.emit('service.ready', { transport: 'http' });
      return endpoint.href;
    },
    close() {
      if (closing) return closing;
      stopping = true;
      diagnostics.emit('service.stopping', { transport: 'http' });
      closing = (async () => {
        const stopped = new Promise((resolve, reject) =>
          listener.close((error) =>
            error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
          ),
        );
        // Stop incomplete uploads/validation; admitted tools remain alive.
        const admitted = [];
        for (const [res, task] of requests) {
          if (task) admitted.push(task);
          else res.destroy();
        }
        try {
          await bridge.prepareClose();
          await Promise.allSettled(admitted);
          await bridge.close();
        } finally {
          for (const res of requests.keys()) res.destroy();
          listener.closeAllConnections();
          await stopped;
        }
      })();
      return closing;
    },
  };
}

async function main() {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('OWNER_CONFIG_REQUIRED');
  const { config, token, port } = await loadHttpConfig(configFile);
  const bridge = new Bridge(config, undefined, { configFile });
  let service,
    initializing,
    closing,
    exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (closing) return closing;
    closing = (async () => {
      await initializing?.catch(() => {});
      try {
        if (service) await service.close();
        else await bridge.close();
      } catch {
        exitCode = 1;
        console.error('SHUTDOWN_FAILED');
      }
      process.exit(exitCode);
    })();
    return closing;
  };
  const stop = () => void close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    initializing = (async () => {
      await bridge.init();
      if (closing) return;
      service = createHttpService(bridge, { token, port });
      await service.listen();
    })();
    await initializing;
  } catch (error) {
    console.error(publicError(error, 'HTTP_SERVICE_FAILED'));
    await close(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(publicError(error, 'HTTP_SERVICE_FAILED'));
    process.exitCode = 1;
  });
