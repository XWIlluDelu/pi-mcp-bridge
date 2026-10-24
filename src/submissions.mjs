import { randomUUID } from 'node:crypto';

// Admission observations only. No prompts, native output, replay or durable log.
export class Submissions {
  constructor({ now = Date.now, limit = 256, ttl = 3600000 } = {}) {
    this.now = now;
    this.limit = limit;
    this.ttl = ttl;
    this.records = new Map();
  }
  prune() {
    for (const [id, record] of this.records)
      if (record.expires <= this.now()) this.records.delete(id);
  }
  start(sessionId, operation) {
    this.prune();
    while (this.records.size >= this.limit) this.records.delete(this.records.keys().next().value);
    const id = randomUUID(),
      timestamp = new Date(this.now()).toISOString();
    this.records.set(id, {
      submission_id: id,
      session_id: sessionId,
      operation,
      submitted_at: timestamp,
      updated_at: timestamp,
      expires: this.now() + this.ttl,
      receipt: { status: 'pending' },
    });
    return id;
  }
  update(id, value) {
    this.prune();
    const record = this.records.get(id);
    if (!record) return null;
    // A late native ACK can arrive before the timeout caller finishes unwinding.
    // Never replace that evidence with the earlier unknown result.
    if (value.status === 'unknown' && !['pending', 'unknown'].includes(record.receipt.status))
      return structuredClone(record.receipt);
    record.receipt = {
      status: value.status,
      ...(value.reason ? { reason: value.reason } : {}),
      ...(value.admission ? { admission: value.admission } : {}),
    };
    record.updated_at = new Date(this.now()).toISOString();
    return structuredClone(record.receipt);
  }
  get(sessionId, id) {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.session_id !== sessionId) throw new Error('SUBMISSION_UNAVAILABLE');
    const { expires, ...value } = record;
    return { ...structuredClone(value), expires_at: new Date(expires).toISOString() };
  }
}
