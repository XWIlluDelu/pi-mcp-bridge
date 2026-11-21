import http from 'node:http';
import { once } from 'node:events';
import { publicError } from './core/errors.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Bridge } from './core/bridge.mjs';
import { runService } from './server.mjs';
import { diagnostics } from './core/diagnostics.mjs';
import { dispatchMcp, readJson, rpcError, MCP_INPUT_LIMIT } from './mcp/protocol.mjs';
import { loadHttpConfig, TOKEN_HEADER, NOT_ADMITTED } from './mcp/http-config.mjs';

const digest = (value) => createHash('sha256').update(value).digest();

function extractHttpToken(headers) {
  const headerTokens = headers[TOKEN_HEADER];
  const authHeaders = headers.authorization;
  if ((headerTokens?.length ?? 0) > 1 || (authHeaders?.length ?? 0) > 1) return null;
  let token = headerTokens?.[0] ?? null;
  if (authHeaders?.length === 1) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeaders[0].trim());
    if (!match) return null;
    if (token !== null && token !== match[1]) return null;
    token = match[1];
  }
  return token;
}

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
// The token and port come from loadHttpConfig, which validates them.
export function createHttpService(bridge, { token, port = 0, waitTimeoutMs = 40000 }) {
  const tokenDigest = digest(token),
    requests = new Map();
  let stopping = false,
    listening,
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
    const credential = extractHttpToken(headers);
    if (!credential || !timingSafeEqual(digest(credential), tokenDigest))
      return refuse(res, 'UNAUTHORIZED');
    if (req.url !== '/mcp') return refuse(res, 'NOT_FOUND');
    if (req.method === 'DELETE') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
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
    try {
      let body;
      try {
        // Leave the socket open long enough to reject an oversized upload.
        body = await readJson(
          req.iterator({ destroyOnReturn: false }),
          MCP_INPUT_LIMIT,
          'BODY_TOO_LARGE',
        );
      } catch (error) {
        return refuse(
          res,
          error.message === 'BODY_TOO_LARGE' ? error.message : 'INVALID_JSON_OBJECT',
        );
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return refuse(res, 'INVALID_JSON_OBJECT');
      if (res.destroyed) return;
      if (stopping) return refuse(res, 'SERVICE_STOPPING');
      diagnostics.emit('http.request', { method: body.method });
      const response = await dispatchMcp(bridge, body, {
        headers,
        execute(run) {
          deadline = setTimeout(
            () =>
              respond(
                res,
                504,
                rpcError(body.id, -32000, 'REQUEST_WAIT_EXPIRED', {
                  recovery:
                    'OUTCOME_UNKNOWN; timeout does not stop submitted Pi work. Inspect list_sessions/read before deciding whether to submit again. Do not automatically resubmit.',
                }),
              ),
            waitTimeoutMs,
          );
          deadline.unref();
          // Keep admitted work in the request map after the response closes.
          const task = Promise.resolve().then(run);
          requests.set(res, task);
          return task;
        },
      });
      if (response.message === null) {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(response.status, { 'Cache-Control': 'no-store' });
          res.end();
        }
      } else {
        respond(res, response.status, response.message);
      }
    } finally {
      clearTimeout(deadline);
      if (res.destroyed) requests.delete(res);
      else res.once('close', () => requests.delete(res));
    }
  }
  return {
    async listen() {
      if (stopping) throw new Error('SERVICE_STOPPING');
      listening = once(listener.listen(port, '127.0.0.1'), 'listening');
      await listening;
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
        const stopped = listening?.then(
          () => listener[Symbol.asyncDispose](),
          () => {},
        );
        // Disconnect unfinished uploads. A detached, admitted request stays in
        // the map until dispatch finishes, even after its HTTP deadline.
        for (const [res, task] of requests) if (!task) res.destroy();
        try {
          await bridge.prepareClose();
          await Promise.allSettled(requests.values());
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
  return runService(bridge, () => createHttpService(bridge, { token, port }), {
    failureCode: 'HTTP_SERVICE_FAILED',
  });
}
if (import.meta.main)
  main().catch((error) => {
    console.error(publicError(error, 'HTTP_SERVICE_FAILED'));
    process.exitCode = 1;
  });
