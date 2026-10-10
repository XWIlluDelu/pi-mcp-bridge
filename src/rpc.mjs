import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export class RpcFailure extends Error {
  constructor(code, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
export class PiRpc {
  constructor(config, session) { this.config = config; this.session = session; this.pending = new Map(); this.alive = false; this.exited = false; }
  async start() {
    const home = path.join(this.config.stateDir, 'pi-home');
    const agentDir = path.join(home, '.pi', 'agent');
    await fs.mkdir(agentDir, {recursive:true, mode:0o700});
    const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
    // Deliberate clean environment: do not borrow host keys or subscriptions.
    const env = {PATH:process.env.PATH ?? '/usr/bin:/bin', HOME:home, LANG:'C.UTF-8', TERM:'dumb', PI_OFFLINE:'1', PI_CODING_AGENT_DIR:agentDir};
    this.child = spawn(process.execPath, [cli, '--mode','rpc','--session',this.session.file,'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools', ...(this.config.piArgs ?? [])], {cwd:this.session.cwd, env, stdio:['pipe','pipe','pipe']});
    this.alive = true;
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    const fail = () => {
      this.alive = false;
      for (const req of this.pending.values()) { clearTimeout(req.timer); req.reject(new RpcFailure('RUNTIME_DISCONNECTED', req.written)); }
      this.pending.clear();
    };
    this.child.once('error', () => { if (!this.child.pid) this.exited = true; fail(); });
    this.child.once('exit', () => { this.exited = true; fail(); });
    this.child.stdin.on('error', fail);
    this.lines = createInterface({input:this.child.stdout});
    this.lines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type !== 'response') return; // Never attribute a later settled event to a unique send.
      const req = this.pending.get(event.id);
      if (!req) return;
      this.pending.delete(event.id); clearTimeout(req.timer);
      const result = event.success ? {ok:true,data:event.data} : {ok:false,code:'PI_REJECTED'};
      if (req.timedOut) { req.onLate?.(result); return; }
      if (result.ok) req.resolve(result.data); else req.reject(new RpcFailure(result.code));
    });
    try {
      await this.command({type:'get_state'}, 15000);
      return this;
    } catch {
      await this.stop();
      throw new RpcFailure('RUNTIME_START_FAILED');
    }
  }
  command(command, timeout = 5000, onLate) {
    if (!this.alive) return Promise.reject(new RpcFailure('RUNTIME_DISCONNECTED'));
    const id = randomUUID();
    return new Promise((resolve,reject) => {
      const req = {resolve,reject,onLate,written:false,timedOut:false};
      req.timer = setTimeout(() => {
        req.timedOut = true;
        reject(new RpcFailure('ACK_TIMEOUT', req.written));
        // Keep until a late authoritative response or process exit; never resend.
      },timeout);
      this.pending.set(id,req);
      req.written = true;
      this.child.stdin.write(`${JSON.stringify({...command,id})}\n`, err => {
        if (err) { clearTimeout(req.timer); this.pending.delete(id); reject(new RpcFailure('WRITE_UNKNOWN',true)); }
      });
    });
  }
  state() { return this.command({type:'get_state'}); }
  entries() { return this.command({type:'get_entries'}); }
  async stop() {
    if (!this.child || this.exited) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const exited = new Promise(resolve => this.child.once('exit',resolve));
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'),1500);
      await exited; clearTimeout(timer); this.lines?.close();
    })();
    return this.stopPromise;
  }
}
export class RuntimePool {
  constructor(config, factory = async session => new PiRpc(config,session).start()) { this.factory = factory; this.instances = new Map(); this.starting = new Map(); }
  async resolve(session) {
    const existing = this.instances.get(session.id);
    if (existing?.alive) return existing;
    if (existing) await existing.stop();
    if (this.starting.has(session.id)) return this.starting.get(session.id);
    const start = this.factory(session).then(runtime => { this.instances.set(session.id,runtime); return runtime; }).finally(() => this.starting.delete(session.id));
    this.starting.set(session.id,start); return start;
  }
  get(id) { const r = this.instances.get(id); return r?.alive ? r : null; }
  async stop(id) { const pending = this.starting.get(id); if (pending) await pending.catch(()=>{}); await this.instances.get(id)?.stop(); this.instances.delete(id); }
  async close() { await Promise.all([...new Set([...this.instances.keys(),...this.starting.keys()])].map(id=>this.stop(id))); }
}
