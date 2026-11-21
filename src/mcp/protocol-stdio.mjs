import { promisify } from 'node:util';
import { isRpcRequest, parseJson, rpcError, MCP_INPUT_LIMIT } from './protocol.mjs';

import { readLfFrames } from '../core/lf-lines.mjs';

// Bound each newline-delimited request before decoding UTF-8.
export class StdioTransport {
  constructor(dispatch, { input = process.stdin, output = process.stdout, capacity } = {}) {
    this.dispatch = dispatch;
    this.capacity = capacity;
    this.input = input;
    this.output = output;
    this.writeLine = promisify(output.write.bind(output));
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
  write(message) {
    if (this.output.destroyed || this.output.writableEnded) return;
    // Writable callbacks complete in order, including replies that never
    // admitted a request. Only the tail is needed to flush those rejections.
    return (this.lastWrite = this.writeLine(JSON.stringify(message) + '\n').catch((error) =>
      this.onerror?.(error),
    ));
  }
  close() {
    this.reader?.close();
    for (const { controller } of this.requests.values()) controller.abort();
  }
  async drain() {
    await Promise.allSettled(this.requests.values().map(({ task }) => task));
    await this.lastWrite;
  }
  reject(id, code, message, data) {
    this.write(rpcError(id, code, message, data));
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
    if (this.capacity && this.requests.size >= this.capacity.limit)
      return this.reject(body.id, -32000, this.capacity.code, { recovery: 'NOT_FORWARDED' });
    const controller = new AbortController();
    const request = { controller };
    this.requests.set(body.id, request);
    request.task = this.reply(body, controller.signal)
      .catch((error) => this.onerror?.(error))
      .finally(() => this.requests.delete(body.id));
  }
  async reply(body, signal) {
    let message;
    try {
      message = await this.dispatch(body, signal);
    } catch {
      message = rpcError(body.id, -32603, 'REQUEST_FAILED');
    }
    if (!signal.aborted) await this.write(message);
  }
}
