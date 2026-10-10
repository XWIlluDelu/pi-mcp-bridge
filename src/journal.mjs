import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, atomicJson } from './data.mjs';
export class Journal {
  constructor(config) { this.config = config; this.running = new Map(); this.writes = new Map(); }
  file(id) { return path.join(this.config.stateDir,'receipts',`${hash(`${this.config.principal}\0${id}`)}.json`); }
  async get(id) { try { return JSON.parse(await fs.readFile(this.file(id),'utf8')); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } }
  async put(id,value) {
    const snapshot = structuredClone(value);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.then(()=>atomicJson(this.file(id),snapshot)); this.writes.set(id,write);
    try { await write; } finally { if (this.writes.get(id) === write) this.writes.delete(id); }
  }
  run(id,op,target,body,action) {
    const prior = this.running.get(id) ?? Promise.resolve();
    const current = prior.catch(()=>{}).then(()=>this.execute(id,op,target,body,action));
    this.running.set(id,current);
    return current.finally(()=>{ if (this.running.get(id) === current) this.running.delete(id); });
  }
  async execute(id,op,target,body,action) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('INVALID_REQUEST_ID');
    const fingerprint = hash({op,target,body});
    const key = `${op}:${target}`;
    const prior = await this.get(id);
    if (prior) {
      if (prior.key !== key || (body !== undefined && prior.fingerprint !== fingerprint)) throw new Error('REQUEST_ID_CONFLICT');
      return prior.receipt;
    }
    if (body === undefined) throw new Error('RECEIPT_NOT_FOUND');
    const base = {key,fingerprint,receipt:{request_id:id,operation:op,status:'unknown'}};
    const save = async result => {
      if (result.status === 'unknown' && ['accepted','rejected'].includes(base.receipt.status)) return base.receipt;
      base.receipt = {request_id:id,operation:op,...result}; await this.put(id,base); return base.receipt;
    };
    // Persist uncertainty before any side effect. A restart never blindly replays.
    await this.put(id,base);
    return action(save);
  }
}
