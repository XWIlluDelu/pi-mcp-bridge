import { isRpcRequest, rpcError, MCP_INPUT_LIMIT } from './protocol.mjs';

// Bound each newline-delimited request before decoding UTF-8.
export class StdioTransport {
  constructor(dispatch, { input = process.stdin, output = process.stdout, capacity } = {}) {
    this.dispatch = dispatch;
    this.capacity = capacity;
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.bufferLength = 0;
    this.discarding = false;
    this.tasks = new Set();
    this.requests = new Map();
    this.data = (chunk) => this.read(chunk);
  }
  start() {
    this.input.on('data', this.data);
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
    this.input.off('data', this.data);
    for (const request of this.requests.values()) request.abort();
  }
  async drain() {
    await Promise.allSettled([...this.tasks]);
  }
  track(task) {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch((error) => this.onerror?.(error));
  }
  read(chunk) {
    // Split before concatenation, so an oversized line never grows the buffer
    // without bound, even if the peer keeps writing without a newline.
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i < chunk.length && chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      start = i + 1;
      if (!this.discarding) {
        const size = this.bufferLength + part.length;
        if (size > MCP_INPUT_LIMIT) {
          this.buffer = Buffer.alloc(0);
          this.bufferLength = 0;
          this.discarding = true;
          this.track(this.write(rpcError(null, -32600, 'INPUT_TOO_LARGE')));
        } else if (part.length) {
          // Geometric growth bounds total copying, even for tiny input chunks.
          // Only the initialized prefix is parsed; capacity never exceeds the frame limit.
          if (size > this.buffer.length) {
            const capacity = Math.min(
              MCP_INPUT_LIMIT,
              Math.max(size, this.buffer.length * 2, 4096),
            );
            const next = Buffer.allocUnsafe(capacity);
            this.buffer.copy(next, 0, 0, this.bufferLength);
            this.buffer = next;
          }
          part.copy(this.buffer, this.bufferLength);
          this.bufferLength = size;
        }
      }
      if (i < chunk.length) {
        if (!this.discarding && this.bufferLength)
          this.line(this.buffer.subarray(0, this.bufferLength));
        this.buffer = Buffer.alloc(0);
        this.bufferLength = 0;
        this.discarding = false;
      }
    }
  }
  line(bytes) {
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      this.track(this.write(rpcError(null, -32700, 'Parse error')));
      return;
    }
    if (!isRpcRequest(body)) {
      this.track(this.write(rpcError(null, -32600, 'Invalid request')));
      return;
    }
    if (body.id === undefined) {
      if (body.method === 'notifications/cancelled')
        this.requests.get(body.params?.requestId)?.abort();
      return;
    }
    if (this.requests.has(body.id)) {
      this.track(this.write(rpcError(body.id, -32600, 'Duplicate in-flight request ID')));
      return;
    }
    if (this.capacity && this.requests.size >= this.capacity.limit) {
      this.track(
        this.write(rpcError(body.id, -32000, this.capacity.code, { recovery: 'NOT_FORWARDED' })),
      );
      return;
    }
    const controller = new AbortController();
    this.requests.set(body.id, controller);
    const task = (async () => {
      try {
        let reply;
        try {
          reply = await this.dispatch(body, controller.signal);
        } catch {
          reply = rpcError(body.id, -32603, 'REQUEST_FAILED');
        }
        if (!controller.signal.aborted) await this.write(reply);
      } finally {
        this.requests.delete(body.id);
      }
    })();
    this.track(task);
  }
}
