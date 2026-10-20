import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, atomicJson } from './storage.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
export class Journal {
  constructor(config) {
    this.config = config;
    this.running = new Map();
    this.writes = new Map();
    this.transitions = new Map();
    this.writeFailures = new Map();
  }
  file(id) {
    return path.join(
      this.config.stateDir,
      'receipts',
      `${hash(`${this.config.principal}\0${id}`)}.json`,
    );
  }
  async get(id) {
    for (;;) {
      const transition = this.transitions.get(id),
        write = this.writes.get(id);
      await transition;
      await write;
      if (transition !== this.transitions.get(id) || write !== this.writes.get(id)) continue;
      if (this.writeFailures.has(id)) throw this.writeFailures.get(id);
      let value;
      try {
        value = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') value = null;
        else throw e;
      }
      // A late ACK may start while readFile is pending. Never replay its
      // renamed bytes before the write (including directory sync) settles.
      if (this.transitions.has(id) || this.writes.has(id)) continue;
      if (this.writeFailures.has(id)) throw this.writeFailures.get(id);
      return value;
    }
  }
  async put(id, value) {
    const snapshot = structuredClone(value);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(() => atomicJson(this.file(id), snapshot));
    this.writes.set(id, write);
    try {
      await write;
      this.writeFailures.delete(id);
    } catch (error) {
      this.writeFailures.set(id, error);
      throw error;
    } finally {
      if (this.writes.get(id) === write) this.writes.delete(id);
    }
  }
  run(id, op, target, body, action) {
    const prior = this.running.get(id) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(() => this.execute(id, op, target, body, action));
    this.running.set(id, current);
    return current.finally(() => {
      if (this.running.get(id) === current) this.running.delete(id);
    });
  }
  async execute(id, op, target, body, action) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('INVALID_REQUEST_ID');
    const fingerprint = hash({ op, target, body });
    const key = `${op}:${target}`;
    const prior = await this.get(id);
    if (prior) {
      if (prior.key !== key || (body !== undefined && prior.fingerprint !== fingerprint))
        throw new Error('REQUEST_ID_CONFLICT');
      diagnostics.emit('receipt.replay', {
        op,
        mutation_ref: diagnosticRef(id),
        status: prior.receipt.status,
      });
      return prior.receipt;
    }
    // Omitting the action is a receipt-only lookup with optional body validation.
    if (body === undefined || action === undefined) throw new Error('RECEIPT_NOT_FOUND');
    const base = {
      key,
      fingerprint,
      receipt: { request_id: id, operation: op, status: 'unknown' },
    };
    // Serialize the whole transition, not only writes. A terminal receipt is
    // observable only after its own snapshot has reached durable storage.
    let transition = Promise.resolve();
    const save = (result) => {
      const input = structuredClone(result);
      const next = transition.then(async () => {
        if (input.status === 'unknown' && ['accepted', 'rejected'].includes(base.receipt.status))
          return structuredClone(base.receipt);
        const receipt = { request_id: id, operation: op, ...input };
        try {
          await this.put(id, { ...base, receipt });
        } catch (cause) {
          // Once an operation has run, losing its durable outcome is uncertainty,
          // never proof that native dispatch was rejected. Callers may record an
          // unknown receipt but must not encourage a new-ID replay.
          const error = new Error('RECEIPT_PERSIST_FAILED', { cause });
          error.uncertain = true;
          throw error;
        }
        base.receipt = receipt;
        diagnostics.emit('receipt.saved', {
          op,
          mutation_ref: diagnosticRef(id),
          status: receipt.status,
          disposition: receipt.disposition,
        });
        return structuredClone(receipt);
      });
      // A failed write rejects its caller, but must not prevent a later ACK
      // from recording the outcome once storage is available again.
      transition = next.catch(() => {});
      this.transitions.set(id, next);
      const settled = () => {
        if (this.transitions.get(id) === next) this.transitions.delete(id);
      };
      next.then(settled, settled);
      return next;
    };
    // Persist uncertainty before any side effect. A restart never blindly replays.
    await this.put(id, base);
    return action(save);
  }
}
