import {
  boundMessage,
  dispatchModern,
  modernMessage,
  rpcError,
  MCP_INPUT_LIMIT,
} from './protocol.mjs';

// One bounded newline transport serves per-request MCP and the pinned MCP SDK.
// It never instantiates another Bridge or replays application work.
export class BridgeStdioTransport {
  constructor(bridge, { input = process.stdin, output = process.stdout } = {}) {
    this.bridge = bridge;
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.bufferLength = 0;
    this.discarding = false;
    this.tasks = new Set();
    this.modern = new Map();
    this.sdkInitialized = false;
    this.data = (chunk) => this.read(chunk);
  }
  async start() {
    this.input.on('data', this.data);
    this.input.resume();
  }
  async send(message) {
    await this.write(boundMessage(message));
  }
  async write(message) {
    if (this.output.destroyed || this.output.writableEnded) return;
    await new Promise((resolve, reject) =>
      this.output.write(JSON.stringify(message) + '\n', (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  async close() {
    this.input.off('data', this.data);
    for (const request of this.modern.values()) request.cancelled = true;
    this.onclose?.();
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
    if (body?.method === 'notifications/cancelled' && this.modern.has(body.params?.requestId)) {
      const record = this.modern.get(body.params.requestId);
      record.cancelled = true;
      return;
    }
    if (body?.method === 'notifications/cancelled' && !this.sdkInitialized) return;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      typeof body.method !== 'string' ||
      (body.params !== undefined &&
        (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) ||
      (body.id !== undefined &&
        !(
          (typeof body.id === 'number' && Number.isSafeInteger(body.id)) ||
          (typeof body.id === 'string' && Buffer.byteLength(body.id) <= 1024)
        ))
    ) {
      this.track(this.write(rpcError(null, -32600, 'Invalid request')));
      return;
    }
    if (body?.method === 'initialize') this.sdkInitialized = true;
    if (!modernMessage(body) && this.sdkInitialized) {
      this.onmessage?.(body);
      return;
    }
    if (body.id === undefined) return; // JSON-RPC notifications never receive responses.
    if (this.modern.has(body.id)) {
      this.track(this.write(rpcError(body.id, -32600, 'Duplicate in-flight request ID')));
      return;
    }
    const record = { cancelled: false };
    this.modern.set(body.id, record);
    const task = (async () => {
      try {
        const { message } = await dispatchModern(this.bridge, body);
        if (!record.cancelled) await this.write(message);
      } catch (error) {
        if (!record.cancelled) await this.write(rpcError(body?.id, -32603, 'REQUEST_FAILED'));
      } finally {
        this.modern.delete(body.id);
      }
    })();
    this.track(task);
  }
}
