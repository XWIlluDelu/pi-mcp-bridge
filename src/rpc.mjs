import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reserveOwner, updateOwner, releaseOwner, processIdentity, readClaim, ownerAlive, AttachedRuntime, AttachmentFailure } from './attachments.mjs';
export class RpcFailure extends Error {
  constructor(code, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
export function launchProfile(config, hostEnv = process.env) {
  const profile = config.piRuntime ?? {};
  const inherit = profile.inheritEnv ?? [];
  const tools = profile.tools ?? [];
  if (!Array.isArray(inherit) || inherit.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      !Array.isArray(tools) || tools.some(name => !['read','write','edit','bash','grep','find','ls'].includes(name)) ||
      (profile.agentDir !== undefined && (typeof profile.agentDir !== 'string' || !path.isAbsolute(profile.agentDir)))) throw new Error('INVALID_PI_RUNTIME');
  const home = path.join(config.stateDir, 'pi-home');
  const agentDir = profile.agentDir ?? path.join(home, '.pi', 'agent');
  const env = Object.fromEntries(inherit.filter(name => hostEnv[name] !== undefined).map(name => [name,hostEnv[name]]));
  Object.assign(env, {PATH:hostEnv.PATH ?? '/usr/bin:/bin', HOME:home, LANG:'C.UTF-8', TERM:'dumb', PI_OFFLINE:'1', PI_CODING_AGENT_DIR:agentDir});
  return {agentDir,env,toolArgs:tools.length ? ['--tools',tools.join(',')] : ['--no-tools']};
}
export class PiRpc {
  constructor(config, session) { this.config = config; this.session = session; this.pending = new Map(); this.alive = false; this.exited = false; }
  async start() {
    const {agentDir,env,toolArgs} = launchProfile(this.config);
    await fs.mkdir(agentDir, {recursive:true, mode:0o700});
    const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
    if(this.config.attachmentDir)this.ownerRecord=await reserveOwner(this.config.attachmentDir,this.session,'rpc');
    // Deliberate clean environment: do not borrow host keys or subscriptions.
    this.child = spawn(process.execPath, [cli, '--mode','rpc','--session',this.session.file,'--no-extensions','--no-skills','--no-prompt-templates','--no-themes',...toolArgs, ...(this.config.piArgs ?? [])], {cwd:this.session.cwd, env, stdio:['pipe','pipe','pipe']});
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
      if(this.ownerRecord){const owner=await processIdentity(this.child.pid);if(!owner)throw new RpcFailure('RUNTIME_START_FAILED');await updateOwner(this.config.attachmentDir,this.session,this.ownerRecord,{owner,phase:'ready'});}
      await this.state(15000);
      return this;
    } catch {
      await this.stop();
      throw new RpcFailure('RUNTIME_START_FAILED');
    }
  }
  async command(command, timeout = 5000, onLate) {
    if (command.type === 'get_state') return this.state(timeout);
    await this.state();
    const late = onLate && (async result => {
      try { await this.state(); onLate(result); } catch { /* Preserve unknown after a session switch. */ }
    });
    let result, rejection;
    try { result = await this.dispatch(command, timeout, late); }
    catch (error) { if (error.code !== 'PI_REJECTED') throw error; rejection = error; }
    try { await this.state(); } catch (error) { if (command.type === 'prompt') error.uncertain = true; throw error; }
    if (rejection) throw rejection;
    return result;
  }
  dispatch(command, timeout = 5000, onLate) {
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
  async state(timeout = 5000) {
    const state = await this.dispatch({type:'get_state'}, timeout);
    if (state.sessionFile !== this.session.file || state.sessionId !== this.session.header.id) {
      await this.stop();
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    }
    return state;
  }
  entries() { return this.command({type:'get_entries'}); }
  async stop() {
    const release=async()=>{if(this.ownerRecord){await releaseOwner(this.config.attachmentDir,this.session,this.ownerRecord);this.ownerRecord=null;}};
    if (!this.child || this.exited) {await release();return;}
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const exited = new Promise(resolve => this.child.once('exit',resolve));
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'),1500);
      await exited; clearTimeout(timer); this.lines?.close();
      await release();
    })();
    return this.stopPromise;
  }
}
export class RuntimePool {
  constructor(config, factory = async session => new PiRpc(config,session).start()) { this.config=config;this.factory = factory; this.instances = new Map(); this.starting = new Map(); }
  async forRead(session){
    const existing=this.instances.get(session.id);
    if(!this.config.attachmentDir)return existing?.alive?existing:null;
    const claim=await readClaim(this.config.attachmentDir,session);
    if(claim&&await ownerAlive(claim.owner)){
      if(claim.kind==='rpc'){
        if(existing?.alive&&existing.ownerRecord?.generation===claim.generation)return existing;
        throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      }
      if(claim.phase!=='ready')throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      if(existing?.attached&&existing.alive&&existing.record.generation===claim.generation)return existing;
      if(existing)await existing.stop();
      const attached=await new AttachedRuntime(this.config,session,claim).start();this.instances.set(session.id,attached);return attached;
    }
    if(existing?.attached){await existing.stop();this.instances.delete(session.id);return null;}
    return existing?.alive?existing:null;
  }
  async resolve(session) {
    if(this.starting.has(session.id))return this.starting.get(session.id);
    const attached=await this.forRead(session);if(attached)return attached;
    const existing = this.instances.get(session.id);
    if (existing?.alive) return existing;
    if (existing) await existing.stop();
    if (this.starting.has(session.id)) return this.starting.get(session.id);
    const start = this.factory(session).then(runtime => { this.instances.set(session.id,runtime); return runtime; }).finally(() => this.starting.delete(session.id));
    this.starting.set(session.id,start); return start;
  }
  get(id) { const r = this.instances.get(id); return r?.alive ? r : null; }
  async stopForDelete(session){
    const pending=this.starting.get(session.id);if(pending)await pending.catch(()=>{});
    const runtime=await this.forRead(session);
    if(runtime?.attached){await runtime.stopForDelete();this.instances.delete(session.id);}
    else await this.stop(session.id);
    if(this.config.attachmentDir){
      // Keep a cooperative owner claim across the filesystem move, including saved-session deletes.
      const deletion=await reserveOwner(this.config.attachmentDir,session,'rpc');
      return ()=>releaseOwner(this.config.attachmentDir,session,deletion);
    }
  }
  async stop(id) { const pending = this.starting.get(id); if (pending) await pending.catch(()=>{}); await this.instances.get(id)?.stop(); this.instances.delete(id); }
  async close() { await Promise.all([...new Set([...this.instances.keys(),...this.starting.keys()])].map(id=>this.stop(id))); }
}
