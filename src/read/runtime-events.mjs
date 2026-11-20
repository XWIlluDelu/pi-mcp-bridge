// Native extension events have no prompt correlation. Keep them outside history
// and receipts, scoped to the RPC generation that actually emitted them.
import { jsonBytes, largestFittingSize } from '../mcp/response-budget.mjs';

const textFields = ['extension_path', 'event', 'error', 'message'];
function clipped(event, limit) {
  const result = { ...event };
  const truncated = new Set(event.truncated_fields ?? []);
  for (const key of textFields) {
    const text = event[key];
    if (typeof text !== 'string' || text.length <= limit) continue;
    let end = limit;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    result[key] = text.slice(0, end);
    truncated.add(key);
  }
  if (truncated.size) result.truncated_fields = [...truncated];
  return result;
}

// Applied once per rendered page, against that page's own byte budget.
export function boundRuntimeEvents(snapshot, maxBytes) {
  if (!snapshot) return null;
  const total = snapshot.events.length + snapshot.omitted_events;
  const build = (events) => ({ ...snapshot, events, omitted_events: total - events.length });
  const events = [];
  for (let i = snapshot.events.length - 1; i >= 0; i--) {
    const event = snapshot.events[i];
    if (jsonBytes(build([event, ...events])) <= maxBytes) events.unshift(event);
    else {
      if (!events.length) {
        const fits = (length) => jsonBytes(build([clipped(event, length)])) <= maxBytes;
        const candidate = clipped(event, largestFittingSize(2048, fits));
        if (jsonBytes(build([candidate])) <= maxBytes) events.push(candidate);
      }
      break;
    }
  }
  const result = build(events);
  return jsonBytes(result) <= maxBytes ? result : null;
}

export class RuntimeEvents {
  constructor(generation) {
    this.generation = generation;
    this.events = [];
    this.sequence = 0;
  }
  invalidate() {
    this.invalidated = true;
    this.events = [];
  }
  observe(event) {
    if (this.invalidated) return false;
    let payload;
    if (event.type === 'extension_error') {
      if (
        ![event.extensionPath, event.event, event.error].every((value) => typeof value === 'string')
      )
        return false;
      payload = {
        type: 'extension_error',
        extension_path: event.extensionPath,
        event: event.event,
        error: event.error,
      };
    } else if (event.type === 'extension_ui_request' && event.method === 'notify') {
      if (typeof event.message !== 'string') return false;
      payload = {
        type: 'notify',
        message: event.message,
        level: ['info', 'warning', 'error'].includes(event.notifyType) ? event.notifyType : 'info',
      };
    } else return false;
    this.events.push(
      clipped(
        { sequence: ++this.sequence, observed_at: new Date().toISOString(), ...payload },
        2048,
      ),
    );
    if (this.events.length > 32) this.events.shift();
    return true;
  }
  snapshot() {
    if (!this.events.length) return null;
    return {
      source: 'rpc_extension_events',
      generation: this.generation,
      transient: true,
      events: [...this.events],
      omitted_events: this.sequence - this.events.length,
    };
  }
}
