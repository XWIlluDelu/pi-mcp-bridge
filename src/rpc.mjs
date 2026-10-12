import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readLfLines } from './lf-lines.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSingleSessionFile, validateExecutionCwd } from './data.mjs';
import { rpcActivity } from './activity.mjs';
import { diagnostics } from './diagnostics.mjs';
import { validatePiRuntime } from './owner-config.mjs';
import { reserveOwner, updateOwner, releaseOwner, processIdentity, readClaim, ownerAlive, AttachedRuntime, AttachmentFailure } from './attachments.mjs';
export class RpcFailure extends Error {
  constructor(code, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
export function launchProfile(config, hostEnv = process.env) {
  const profile = config.piRuntime ?? {};
  validatePiRuntime(profile);
  const inheritEnv=profile.inheritEnv??undefined,tools=profile.tools??undefined;
  const env = inheritEnv === undefined ? {...hostEnv}
    : Object.fromEntries(inheritEnv.filter(name => hostEnv[name] !== undefined).map(name => [name,hostEnv[name]]));
  if (inheritEnv !== undefined) env.PATH ??= hostEnv.PATH ?? '/usr/bin:/bin';
  if (profile.agentDir !== undefined) env.PI_CODING_AGENT_DIR = profile.agentDir;
  // Pi resolves HOME, its native agent directory and resource/settings defaults.
  return {env,resourceArgs:[],toolArgs:tools === undefined ? []
    : tools.length ? ['--tools',tools.join(',')] : ['--no-tools']};
}
export class PiRpc {
  constructor(config, session) { this.config = config; this.session = session; this.pending = new Map(); this.alive = false; this.exited = false; this.generation = randomUUID(); this.promptAdmission = null; this.settlement = {generation:this.generation,sequence:0,observed_at:null,aborted:null}; }
  async start() {
    await assertSingleSessionFile(this.session.file);
    const {env,toolArgs,resourceArgs} = launchProfile(this.config);
    if(this.config.piRuntime?.agentDir)await fs.mkdir(this.config.piRuntime.agentDir,{recursive:true,mode:0o700});
    const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
    try {
      if(this.config.attachmentDir){
      this.ownerRecord=await reserveOwner(this.config.attachmentDir,this.session,'rpc');
      await updateOwner(this.config.attachmentDir,this.session,this.ownerRecord,{socket:path.join(this.config.attachmentDir,`${process.pid}-${this.ownerRecord.generation.slice(0,8)}.sock`)});
      env.PI_MCP_RPC_OBSERVER=JSON.stringify({socket:this.ownerRecord.socket,generation:this.ownerRecord.generation});
      }
      // Recheck at the actual launch boundary: content preflight and owner
      // reservation may have taken time since discovery verified this path.
      await validateExecutionCwd(this.session.cwd);
      // Native environment/settings by default; only owner-selected overrides apply.
      this.child = spawn(process.execPath, [cli, '--mode','rpc','--session',this.session.file,...resourceArgs,...toolArgs, ...(this.config.piArgs ?? []), ...(this.ownerRecord ? ['-e',fileURLToPath(new URL('./rpc-observer.mjs',import.meta.url))] : [])], {cwd:this.session.cwd, env, stdio:['pipe','pipe','pipe']});
    } catch (error) {
      if(this.ownerRecord)await releaseOwner(this.config.attachmentDir,this.session,this.ownerRecord);
      throw error;
    }
    this.alive = true;
    const runtimeLog=diagnostics.capture();this.child.once('spawn',()=>runtimeLog('runtime.spawned',{kind:'rpc',generation:this.generation}));
    this.child.stderr.resume(); // Drain diagnostics without retaining provider output.
    const fail = () => {
      this.alive = false;
      for (const req of this.pending.values()) { clearTimeout(req.timer); req.reject(new RpcFailure('RUNTIME_DISCONNECTED', req.written)); }
      this.pending.clear();
    };
    this.child.once('error', () => { if (!this.child.pid) this.exited = true; fail(); });
    this.child.once('exit', () => { runtimeLog('runtime.exited',{kind:'rpc',generation:this.generation});this.exited = true; this.promptAdmission = null; fail(); });
    this.child.stdin.on('error', fail);
    const generation = this.generation;
    this.lines = readLfLines(this.child.stdout, line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      this.receiveResponse(event, generation);
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
  receiveResponse(event, generation) {
    if (generation !== this.generation || !event) return;
    if (event.type === 'agent_settled' && typeof event.aborted === 'boolean') {
      this.settlement = {generation,sequence:this.settlement.sequence+1,observed_at:new Date().toISOString(),aborted:event.aborted};
      return; // Session observation only; never release an unresolved prompt ACK fence.
    }
    if (event.type !== 'response') return;
    const req = this.pending.get(event.id);
    if (!req || req.generation !== generation) return;
    // Only the matching prompt ACK is evidence of completed admission. State,
    // timers, unrelated events and malformed responses cannot clear uncertainty.
    if (req.commandType === 'prompt' && (event.command !== 'prompt' ||
        (event.success !== false && !(event.success === true && ['started','queued','handled'].includes(event.data?.disposition))))) return;
    this.pending.delete(event.id); clearTimeout(req.timer);
    if (this.promptAdmission?.id === event.id && this.promptAdmission.generation === generation) this.promptAdmission = null;
    const result = event.success ? {ok:true,data:event.data} : {ok:false,code:'PI_REJECTED'};
    if (req.timedOut) { req.log?.('rpc.late_ack',{op:req.commandType,generation,late:true,status:result.ok?'ok':'error'});req.onLate?.(result); return; }
    if (result.ok) req.resolve(result.data); else req.reject(new RpcFailure(result.code));
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
    let checkedState;
    try { checkedState = await this.state(); } catch (error) { if (command.type === 'prompt') error.uncertain = true; throw error; }
    if (rejection) throw rejection;
    if (command.type === 'get_entries') return {...result,activity:rpcActivity(checkedState,Boolean(this.promptAdmission),this.settlement)};
    return result;
  }
  dispatch(command, timeout = 5000, onLate) {
    return diagnostics.measure('rpc.command',{op:command.type,generation:this.generation},()=>this.dispatchRequest(command,timeout,onLate));
  }
  dispatchRequest(command, timeout = 5000, onLate) {
    if (!this.alive) return Promise.reject(new RpcFailure('RUNTIME_DISCONNECTED'));
    if (command.type === 'prompt' && this.promptAdmission) return Promise.reject(new RpcFailure('PROMPT_ADMISSION_PENDING'));
    const id = randomUUID(), generation = this.generation;
    const serialized = `${JSON.stringify({...command,id})}\n`;
    if (command.type === 'prompt') this.promptAdmission = {id,generation};
    return new Promise((resolve,reject) => {
      const req = {resolve,reject,onLate:onLate&&diagnostics.bind(onLate),generation,commandType:command.type,written:false,timedOut:false,log:diagnostics.capture()};
      const discardRead = () => {
        if (['get_state','get_entries'].includes(command.type)) this.pending.delete(id);
      };
      req.timer = setTimeout(() => {
        req.timedOut = true;
        discardRead();
        reject(new RpcFailure('ACK_TIMEOUT', req.written));
        // Reads have no durable side effect or useful late result. Prompts keep
        // their authoritative late-ACK recovery and admission fence.
      },timeout);
      this.pending.set(id,req);
      req.written = true;
      const writeFailed = () => {
        clearTimeout(req.timer); req.timedOut = true;
        discardRead();
        // A write error does not prove that Pi failed to receive the command.
        // Keep matching ACK recovery possible and keep the admission fence.
        reject(new RpcFailure('WRITE_UNKNOWN',true));
      };
      try { this.child.stdin.write(serialized, err => { if (err) writeFailed(); }); }
      catch { writeFailed(); }
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
  async assertReleasable(){
    if(this.promptAdmission)throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    const state=await this.dispatch({type:'get_state'});
    if(state.sessionFile!==this.session.file||state.sessionId!==this.session.header.id)throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    if(this.promptAdmission)throw new RpcFailure('PROMPT_ADMISSION_PENDING');
    if(state.isStreaming===true||state.isCompacting===true||state.pendingMessageCount>0)throw new RpcFailure('RUNTIME_BUSY');
    if(state.isStreaming!==false||state.isCompacting!==false||state.pendingMessageCount!==0||!this.ownerRecord?.socket)throw new RpcFailure('RUNTIME_IDLE_UNCONFIRMED');
    const observed=await new AttachedRuntime(this.config,this.session,this.ownerRecord).state();
    if(observed.preparingUnconfirmed)throw new RpcFailure('RUNTIME_IDLE_UNCONFIRMED');
    if(observed.isIdle===false||observed.hasPendingMessages===true)throw new RpcFailure('RUNTIME_BUSY');
    if(observed.isIdle!==true||observed.hasPendingMessages!==false)throw new RpcFailure('RUNTIME_IDLE_UNCONFIRMED');
    if(this.promptAdmission)throw new RpcFailure('PROMPT_ADMISSION_PENDING');
  }
  async stop() {
    const release=async()=>{if(this.ownerRecord){await releaseOwner(this.config.attachmentDir,this.session,this.ownerRecord);this.ownerRecord=null;}};
    if (!this.child || this.exited) {this.promptAdmission=null;await release();return;}
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const exited = new Promise(resolve => this.child.once('exit',resolve));
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => this.child.kill('SIGKILL'),1500);
      await exited; this.exited=true; this.promptAdmission=null; clearTimeout(timer); this.lines?.close();
      if(this.ownerRecord?.socket)await fs.unlink(this.ownerRecord.socket).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await release();
    })();
    return this.stopPromise;
  }
}
export class RuntimePool {
  constructor(config, factory) {
    this.config=config;this.attachmentDir=config.attachmentDir??(config.stateDir?path.join(config.stateDir,'ipc'):undefined);
    this.factory=factory??(session=>new PiRpc({...config,attachmentDir:this.attachmentDir},session).start());
    this.instances=new Map();this.starting=new Map();
  }
  async forRead(session){
    const existing=this.instances.get(session.id);
    if(!this.attachmentDir)return existing?.alive?existing:null;
    const claim=await readClaim(this.attachmentDir,session);
    if(claim&&await ownerAlive(claim.owner)){
      if(claim.kind==='rpc'){
        if(existing?.alive&&existing.ownerRecord?.generation===claim.generation)return existing;
        throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      }
      if(claim.phase!=='ready')throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
      if(existing?.attached&&existing.alive&&existing.record.generation===claim.generation)return existing;
      if(existing)await existing.stop();
      const attached=await diagnostics.measure('runtime.attach',{kind:'attached',generation:claim.generation},()=>new AttachedRuntime({...this.config,attachmentDir:this.attachmentDir},session,claim).start());this.instances.set(session.id,attached);return attached;
    }
    if(existing?.attached){diagnostics.emit('runtime.detached',{kind:'attached',generation:existing.record.generation});await existing.stop();this.instances.delete(session.id);return null;}
    return existing?.alive?existing:null;
  }
  async resolve(session) {
    if(this.starting.has(session.id))return this.starting.get(session.id);
    const attached=await this.forRead(session);if(attached){diagnostics.emit('runtime.reused',{kind:attached.attached?'attached':'rpc',generation:attached.generation??attached.record?.generation});return attached;}
    if(this.attachmentDir&&(await readClaim(this.attachmentDir,session))?.noColdReacquire)throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    const existing = this.instances.get(session.id);
    if (existing?.alive) return existing;
    if (existing) await existing.stop();
    if (this.starting.has(session.id)) return this.starting.get(session.id);
    const start = diagnostics.measure('runtime.start',{kind:'rpc'},()=>this.factory(session)).then(runtime => { this.instances.set(session.id,runtime); return runtime; }).finally(() => this.starting.delete(session.id));
    this.starting.set(session.id,start); return start;
  }
  get(id) { const r = this.instances.get(id); return r?.alive ? r : null; }
  async stopForDelete(session){
    const pending=this.starting.get(session.id);if(pending)await pending.catch(()=>{});
    const runtime=await this.forRead(session);
    if(runtime?.attached){await runtime.stopForDelete();this.instances.delete(session.id);}
    else await this.stop(session.id);
    if(this.attachmentDir){
      // Keep a cooperative owner claim across the filesystem move, including saved-session deletes.
      const deletion=await reserveOwner(this.attachmentDir,session,'delete');
      return ()=>releaseOwner(this.attachmentDir,session,deletion);
    }
  }
  async stop(id) { const pending = this.starting.get(id); if (pending) await pending.catch(()=>{}); await this.instances.get(id)?.stop(); this.instances.delete(id); }
  async close() { await Promise.all([...new Set([...this.instances.keys(),...this.starting.keys()])].map(id=>this.stop(id))); }
}
