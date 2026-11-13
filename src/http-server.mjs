import http from 'node:http';
import { publicError } from './errors.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Bridge } from './bridge.mjs';
import { makeServer } from './server.mjs';
import { diagnostics } from './diagnostics.mjs';
import {
  SDK_VERSIONS,
  modernMessage,
  isRpcRequest,
  dispatchModern,
  validateModernHeaders,
  boundMessage,
  rpcError,
  MCP_INPUT_LIMIT,
} from './protocol.mjs';
import { loadHttpConfig, TOKEN_HEADER, NOT_ADMITTED, assertBackendToken } from './http-config.mjs';

const digest = (value) => createHash('sha256').update(value).digest();

function headers(req, name) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  return values;
}
const refuse = (res, code) => reject(res, NOT_ADMITTED[code], code);
function reject(res, status, code) {
  if (res.destroyed || res.writableEnded) return;
  diagnostics.emit('http.rejected', { http_status: status });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(JSON.stringify({ error: code }));
}
function logRpcResponse(message, httpStatus) {
  diagnostics.emit('http.rpc_response', {
    http_status: httpStatus,
    rpc_status: message.error ? 'error' : message.result !== undefined ? 'result' : undefined,
    rpc_code: message.error?.code,
    callback_reason: message.error?.data?.reason,
  });
}
function jsonResponse(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  logRpcResponse(message, status);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(message));
}
async function parseBody(req) {
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', aborted);
    };
    const error = () => {
      cleanup();
      reject(new Error('INCOMPLETE_BODY'));
    };
    const aborted = () => error();
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > MCP_INPUT_LIMIT) {
        cleanup();
        req.pause();
        reject(new Error('BODY_TOO_LARGE'));
      } else chunks.push(chunk);
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    req.once('aborted', aborted);
  });
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    // The MCP batch tool is supported; JSON-RPC envelope arrays are not.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('INVALID_JSON_OBJECT');
  }
}

// The caller initializes one Bridge. Only this service's close(), never an HTTP
// connection or request transport, owns its shutdown.
export function createHttpService(bridge, { token, port = 0, waitTimeoutMs = 35000 }) {
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 300000)
    throw new Error('INVALID_WAIT_TIMEOUT');
  assertBackendToken(token);
  const tokenDigest = digest(token),
    operations = new Set(),
    requests = new Set();
  let stopping = false,
    closing,
    expectedHost;
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
        void handle(req, res).catch(() => reject(res, 500, 'REQUEST_FAILED'));
      });
    },
  );
  listener.maxConnections = 32;
  async function handle(req, res) {
    const host = headers(req, 'host');
    if (host.length !== 1 || host[0] !== expectedHost) return refuse(res, 'INVALID_HOST');
    if (headers(req, 'origin').length) return refuse(res, 'ORIGIN_DENIED');
    const credentials = headers(req, TOKEN_HEADER);
    if (credentials.length !== 1 || !timingSafeEqual(digest(credentials[0]), tokenDigest))
      return refuse(res, 'UNAUTHORIZED');
    if (req.url !== '/mcp') return refuse(res, 'NOT_FOUND');
    if (req.method !== 'POST') return refuse(res, 'METHOD_NOT_ALLOWED');
    if (stopping) return refuse(res, 'SERVICE_STOPPING');
    if (requests.size >= 16) return refuse(res, 'SERVICE_BUSY');
    const contentType = headers(req, 'content-type');
    if (
      contentType.length !== 1 ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0]) ||
      headers(req, 'content-encoding').length
    )
      return refuse(res, 'UNSUPPORTED_CONTENT_TYPE');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MCP_INPUT_LIMIT))
      return refuse(res, 'BODY_TOO_LARGE');
    const record = {
      req,
      res,
      pending: 0,
      disconnected: false,
      server: null,
    };
    requests.add(record);
    const release = () => {
      if (record.disconnected && record.pending === 0) requests.delete(record);
    };
    res.once('close', () => {
      record.disconnected = true;
      void record.server?.close().catch(() => {});
      release();
    });
    let body;
    try {
      body = await parseBody(req);
    } catch (error) {
      // Upload/parse failures happen before admission; others stay unknown.
      if (Object.hasOwn(NOT_ADMITTED, error.message)) return refuse(res, error.message);
      return reject(res, 500, 'REQUEST_FAILED');
    }
    try {
      if (record.disconnected) return;
      diagnostics.emit('http.request', { method: body.method });
      if (!isRpcRequest(body))
        return jsonResponse(res, 400, rpcError(null, -32600, 'Invalid request'));
      const deadline = setTimeout(() => {
        if (body.id !== undefined)
          jsonResponse(
            res,
            504,
            rpcError(body.id, -32000, 'REQUEST_WAIT_EXPIRED', {
              recovery:
                'OUTCOME_UNKNOWN; timeout does not stop submitted Pi work. Inspect list/read before deciding whether to submit again. Do not automatically resubmit.',
            }),
          );
        else reject(res, 504, 'REQUEST_WAIT_EXPIRED');
      }, waitTimeoutMs);
      deadline.unref();
      res.once('close', () => clearTimeout(deadline));
      res.once('finish', () => clearTimeout(deadline));
      if (stopping) return refuse(res, 'SERVICE_STOPPING');
      const execute = (run) => {
        if (stopping || record.disconnected) throw new Error('REQUEST_NOT_ADMITTED');
        // Track the entire tool (including every batch item). Transport close
        // may abort SDK response delivery; it never cancels this operation.
        record.pending++;
        const task = Promise.resolve().then(run);
        operations.add(task);
        void task
          .finally(() => {
            operations.delete(task);
            record.pending--;
            release();
          })
          .catch(() => {});
        return task;
      };
      const versions = headers(req, 'mcp-protocol-version');
      const modern =
        modernMessage(body) || versions.some((version) => !SDK_VERSIONS.includes(version));
      if (modern) {
        const mismatch = validateModernHeaders(body, (name) => headers(req, name));
        if (mismatch) return jsonResponse(res, 400, mismatch);
        const response = await dispatchModern(bridge, body, {
          execute,
        });
        if (!record.disconnected) jsonResponse(res, response.status, response.message);
        return;
      }
      record.server = makeServer(bridge, { execute });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const send = transport.send.bind(transport);
      transport.send = (message) => {
        const bounded = boundMessage(message);
        logRpcResponse(bounded); // The SDK owns HTTP status; http.closed records it.
        return send(bounded);
      };
      await record.server.connect(transport);
      if (record.disconnected) {
        await record.server.close();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      await transport.handleRequest(req, res, body);
    } catch {
      reject(res, 500, 'REQUEST_FAILED');
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
      expectedHost = `127.0.0.1:${listener.address().port}`;
      diagnostics.emit('service.ready', { transport: 'http' });
      return `http://${expectedHost}/mcp`;
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
        for (const record of requests) if (record.pending === 0) record.res.destroy();
        try {
          await bridge.prepareClose();
          await Promise.allSettled([...operations]);
          await bridge.close();
        } finally {
          for (const record of requests) {
            await record.server?.close().catch(() => {});
            record.res.destroy();
          }
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
  process.on('SIGINT', () => {
    void close();
  });
  process.on('SIGTERM', () => {
    void close();
  });
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
