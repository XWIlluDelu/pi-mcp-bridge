import { isRpcRequest, parseJson, rpcError, MCP_INPUT_LIMIT } from './protocol.mjs';

import { readLfFrames } from '../core/lf-lines.mjs';

// Bound each newline-delimited request before decoding UTF-8.
export class StdioTransport {
  constructor(dispatch, { input = process.stdin, output = process.stdout, capacity } = {}) {
    this.dispatch = dispatch;
    this.capacity = capacity;
    this.input = input;
    this.output = output;
    this.requests = new Map();
  }
  start() {
    this.reader = readLfFrames(
      this.input,
      (frame) => {
        if (frame.length) this.line(frame);
      },
      {
        maxBytes: MCP_INPUT_LIMIT,
        onOverflow: () => this.reject(null, -32600, 'INPUT_TOO_LARGE'),
      },
    );
    this.input.resume();
  }
  async write(message) {
    if (this.output.destroyed || this.output.writableEnded) return;
    await new Promise((resolve, reject) =>
      this.output.write(JSON.stringify(message) + '\n', (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  close() {
    this.reader?.close();
    for (const { controller } of this.requests.values()) controller?.abort();
  }
  async drain() {
    await Promise.allSettled(this.requests.values().map(({ task }) => task));
  }
  track(run, id = Symbol(), controller) {
    const request = { controller };
    this.requests.set(id, request);
    request.task = run();
    void request.task
      .finally(() => this.requests.delete(id))
      .catch((error) => this.onerror?.(error));
  }
  reject(id, code, message, data) {
    this.track(() => this.write(rpcError(id, code, message, data)));
  }
  line(bytes) {
    let body;
    try {
      body = parseJson(bytes);
    } catch {
      return this.reject(null, -32700, 'Parse error');
    }
    if (!isRpcRequest(body)) return this.reject(null, -32600, 'Invalid request');
    if (body.id === undefined) {
      if (body.method === 'notifications/cancelled')
        this.requests.get(body.params?.requestId)?.controller?.abort();
      return;
    }
    if (this.requests.has(body.id))
      return this.reject(body.id, -32600, 'Duplicate in-flight request ID');
    if (
      this.capacity &&
      this.requests
        .values()
        .filter(({ controller }) => controller)
        .reduce((count) => count + 1, 0) >= this.capacity.limit
    ) {
      return this.reject(body.id, -32000, this.capacity.code, { recovery: 'NOT_FORWARDED' });
    }
    const controller = new AbortController();
    this.track(
      async () => {
        let reply;
        try {
          reply = await this.dispatch(body, controller.signal);
        } catch {
          reply = rpcError(body.id, -32603, 'REQUEST_FAILED');
        }
        if (!controller.signal.aborted) await this.write(reply);
      },
      body.id,
      controller,
    );
  }
}
