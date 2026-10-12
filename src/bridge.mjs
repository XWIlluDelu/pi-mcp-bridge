import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { activityObservation, rpcActivity } from './activity.mjs';
import { readSchema, hasTextSelector, stopSchema } from './tool-schemas.mjs';
import { isDeepStrictEqual } from 'node:util';
import { permitted } from './permissions.mjs';
import { discover, opaqueId, renderRead, hash, syncDir, loadSavedSession, validateExecutionCwd, atomicJson } from './data.mjs';
import { stopReceipt, recoveredWithdrawal, withdrawalPage } from './stop-execution.mjs';
import { PiRpc, RuntimePool } from './rpc.mjs';
import { Journal } from './journal.mjs';
import { privateDirectory, readClaim, ownerAlive, registryTransaction, updateOwner, claimFile } from './attachments.mjs';
import { serveOwnerControl } from './owner-runtime.mjs';
import { readOwnerConfig, validateOwnerConfig } from './owner-config.mjs';
import { diagnostics } from './diagnostics.mjs';
import { prepareTrash } from './trash.mjs';
export class Bridge {
  constructor(config, factory, {configFile}={}) { this.config = config; this.configFile=configFile;const {grants,...settings}=config;this.ownerSettings=structuredClone(settings);this.pool = new RuntimePool(config,factory); this.journal = new Journal(config); this.locks = new Map(); }
  async init() {
    validateOwnerConfig(this.config);
    await privateDirectory(this.pool.attachmentDir);
    await fs.mkdir(this.config.stateDir,{recursive:true,mode:0o700});
    if (await fs.realpath(this.config.stateDir) !== path.resolve(this.config.stateDir)) throw new Error('SYMLINK_STATE_NOT_ALLOWED');
    for (const root of this.config.sessionRoots) {
      await fs.mkdir(root,{recursive:true,mode:0o700});
      if (await fs.realpath(root) !== path.resolve(root)) throw new Error('SYMLINK_ROOT_NOT_ALLOWED');
    }
    // Configured execution directories may be offline while saved history is
    // still accessible. Create and cold resume validate their cwd on demand.
    // One bridge process per state directory. Do not automatically steal stale locks.
    this.lockPath = path.join(this.config.stateDir,'bridge.lock');
    this.lock = await fs.open(this.lockPath,'wx',0o600); await this.lock.writeFile(`${process.pid}\n`);
    try{this.ownerControl=await serveOwnerControl(this);}catch(error){await this.lock.close();await fs.unlink(this.lockPath);this.lock=null;throw error;}
    return this;
  }
  async locked(id,fn) {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(()=>{}).then(fn); this.locks.set(id,next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async sessions() { return diagnostics.measure('session.discover',{},()=>discover(this.config)); }
  async refreshPermissions(){
    if(!this.configFile)return;
    const task=diagnostics.measure('permission.reload',{},()=>(this.permissionsReload??Promise.resolve()).catch(()=>{}).then(async()=>{
      const {config}=await readOwnerConfig(this.configFile);const {grants,...settings}=config;
      if(!isDeepStrictEqual(settings,this.ownerSettings))throw new Error('CONFIG_RESTART_REQUIRED');
      this.config.grants=grants??[];
    }));
    this.permissionsReload=task;
    try{await task;}finally{if(this.permissionsReload===task)this.permissionsReload=null;}
  }
  async session(id) { const s = (await this.sessions()).find(s=>s.id === id); if (!s) throw new Error('NOT_FOUND_OR_DENIED'); return s; }
  check(action,s) { const allowed=permitted(this.config,action,s);diagnostics.emit('permission.check',{op:action,allowed});if (!allowed) throw new Error('NOT_FOUND_OR_DENIED'); }
  async list(args = {}) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    const rows = [];
    for (const s of await this.sessions()) {
      if (!permitted(this.config,'read',s)) { if (!args.query) rows.push({session_id:s.id}); continue; }
      let saved;
      try { saved = await loadSavedSession(s); } catch { /* Identity remains accessible; content reads report their own error. */ }
      const name = saved?.entries.findLast(e=>e.type==='session_info')?.name;
      const title = typeof name==='string' ? name.trim() || null : null;
      if (args.query && !JSON.stringify({title,cwd:s.header.cwd}).toLowerCase().includes(args.query.toLowerCase())) continue;
      rows.push({session_id:s.id,title:typeof title==='string'?title.slice(0,200):null,cwd:s.header.cwd.slice(0,1024),leaf_id:saved?.leafId??null,permissions:{read:true,send:permitted(this.config,'send',s),command:permitted(this.config,'command',s),delete:permitted(this.config,'delete',s)}});
    }
    const offset = args.offset ?? 0, limit = Math.min(100,args.limit ?? 30);
    return {sessions:rows.slice(offset,offset+limit),next_offset:offset+limit < rows.length ? offset+limit:null,
      folders:this.config.folders.filter(f=>permitted(this.config,'new_session',{cwd:f.path})).map(f=>({folder_id:f.id}))};
  }
  async read(args,{signal}={}) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    let s = await this.session(args.session_id); this.check('read',s);
    if(hasTextSelector(args)&&!readSchema.safeParse(args).success)throw new Error('INVALID_TEXT_SELECTOR');
    if(args.view==='status'){
      if(!readSchema.safeParse(args).success)throw new Error('INVALID_STATUS_ARGS');
      return this.readStatus(s,args,signal);
    }
    if(args.after_settlement!==undefined||args.wait_ms!==undefined)throw new Error('INVALID_STATUS_ARGS');
    const runtime = await this.pool.forRead(s);
    diagnostics.emit('read.source',{kind:runtime?(runtime.attached?'attached':'rpc'):'saved',view:args.view??'context'});
    if(runtime?.attached)return runtime.read(args);
    if (runtime) {
      const active = await runtime.entries();
      if (active.entries.some(e=>typeof e.id!=='string' || e.id.length>128) || (active.leafId!==null && (typeof active.leafId!=='string' || active.leafId.length>128))) throw new Error('INVALID_RUNTIME_ENTRIES');
      s.entries = active.entries; s.leafId = active.leafId;
      s.activity = active.activity;
      s.revision = hash({entries:s.entries,leaf:s.leafId});
    }
    if (!runtime) s = await loadSavedSession(s);
    return renderRead(s,args,{leafSource:runtime?'live':'saved_resume'});
  }
  async readStatus(session,args,signal){
    const deadline=Date.now()+(args.wait_ms??0),baseline=args.after_settlement;
    let activity=activityObservation(),generation=null,observed=false;
    for(;;){
      this.assertOpen();
      if(signal?.aborted)throw new Error('READ_CANCELLED');
      // Always take an initial snapshot. The deadline limits polling, not
      // an observation's normal bounded command timeout.
      if(!observed||Date.now()<deadline){
        const runtime=await this.pool.forRead(session); // Never start a writer for status.
        if(!observed||Date.now()<deadline){ // Ownership resolution may exhaust the poll budget.
          activity=activityObservation();generation=null;
          if(runtime){
            const state=await runtime.state();
            generation=runtime.generation??runtime.record?.generation??null;
            activity=runtime.attached
              ? state.activity??activityObservation(runtime.record.kind==='host'?'host_state':'attached_state',{
                idle:state.isIdle,streaming:state.isStreaming,compacting:state.isCompacting,
                count:state.pendingMessageCount,pending:typeof state.pendingMessageCount==='number'?state.pendingMessageCount>0:undefined})
              : rpcActivity(state,Boolean(runtime.promptAdmission),runtime.settlement);
          }
          observed=true;
        }
      }
      // A permission edit while waiting must not expose even a status snapshot.
      if(this.configFile)await this.refreshPermissions();
      this.assertOpen();this.check('read',session);
      if(signal?.aborted)throw new Error('READ_CANCELLED');
      const settled=activity.settlement;
      let outcome='not_requested';
      if(baseline){
        if(!generation||!settled)outcome='unavailable';
        else if(generation!==baseline.generation)outcome='generation_changed';
        else if(settled.sequence>baseline.sequence)outcome='settled';
        else outcome='timeout';
      }
      if(!baseline||outcome!=='timeout'||Date.now()>=deadline)
        return {session_id:session.id,view:'status',generation,activity,wait:{status:outcome}};
      try{await delay(Math.min(100,Math.max(1,deadline-Date.now())),undefined,{signal});}
      catch(error){if(signal?.aborted)throw new Error('READ_CANCELLED');throw error;}
    }
  }
  async send(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    const body = args.text === undefined ? undefined : {text:args.text,mode:args.mode ?? 'native'};
    return this.journal.run(args.request_id,'send',args.session_id,body,save=>this.locked(args.session_id,async()=>{
      try {
        if(this.locks.has(`stop:${args.session_id}`))throw new Error('STOP_IN_PROGRESS');
        const s = await this.session(args.session_id); this.check('send',s);
        // Existing owners remain readable/controllable independently of whether
        // their original working directory still exists. Only a new execution
        // needs a validated directory and a valid saved transcript.
        let runtime = await this.pool.forRead(s);
        if (!runtime) {
          await validateExecutionCwd(s.cwd);
          await loadSavedSession(s);
          runtime = await this.pool.resolve(s);
        }
        if(this.locks.has(`stop:${args.session_id}`))throw new Error('STOP_IN_PROGRESS');
        if(runtime.attached)return save(await runtime.send({...args,...body}));
        if (body.mode === 'idle_only') {
          const state = await runtime.state();
          if (state.isStreaming || state.isCompacting) return save({status:'skipped',reason:'busy'});
        }
        const command = {type:'prompt',message:body.text};
        if (body.mode === 'steer') command.streamingBehavior = 'steer';
        if (body.mode === 'queue') command.streamingBehavior = 'followUp';
        const late = result => save(result.ok ? {status:'accepted',disposition:result.data.disposition,completion:'not_tracked'} : {status:'rejected',reason:result.code}).catch(()=>{});
        const result = await runtime.command(command,args.timeout_ms ?? 5000,late);
        return save({status:'accepted',disposition:result.disposition,completion:'not_tracked'});
      } catch(e) { return save({status:e.uncertain?'unknown':'rejected',reason:safeReason(e)}); }
    }));
  }
  async stop(args) {
    this.assertOpen();
    if(!stopSchema.safeParse(args).success)throw new Error('INVALID_STOP_ARGS');
    if(this.configFile)await this.refreshPermissions();
    const session=await this.session(args.session_id);
    this.check('command',session);
    if(!permitted(this.config,'read',session))throw new Error('STOP_REQUIRES_READ');
    const recovery_id=hash({principal:this.config.principal,session:session.id,request:args.request_id});
    const receipt=await this.journal.run(args.request_id,'stop',session.id,args.cursor?undefined:{},save=>this.locked(`stop:${session.id}`,async()=>{
      let generation;
      try {
        this.assertOpen();
        // Independent of prompt admission's lock; never start a writer.
        const runtime=await this.pool.forRead(session);
        this.assertOpen();
        if(this.configFile)await this.refreshPermissions();
        this.check('command',session);this.check('read',session);
        if(!runtime)return save({status:'skipped',reason:'not_running'});
        if(typeof runtime.stopExecution!=='function')throw new Error('STOP_UNSUPPORTED');
        generation=runtime.generation??runtime.record?.generation??null;
        await save({status:'unknown',generation});
        const result=stopReceipt(await runtime.stopExecution({...args,recovery_id}));
        return save({...result,generation});
      }catch(error){return save({status:error.uncertain?'unknown':'rejected',reason:safeReason(error),...(generation?{generation}:{})});}
    }));
    // Returning/replaying withdrawn content always rechecks current ACLs.
    if(this.configFile)await this.refreshPermissions();
    this.assertOpen();this.check('command',session);this.check('read',session);
    const withdrawn=receipt.generation?await recoveredWithdrawal(this.pool.attachmentDir,session,receipt.generation,recovery_id):null;
    if(withdrawn===null){
      if(receipt.status==='skipped')return withdrawalPage(receipt,{generation:null,text:'',includesEditorDraft:false},args);
      if(receipt.status==='accepted')throw new Error('WITHDRAWAL_RECOVERY_MISSING');
      return {...receipt,withdrawn_available:false};
    }
    return withdrawalPage(receipt,withdrawn,args);
  }
  async create(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    return this.journal.run(args.request_id,'create',args.folder_id,{},save=>this.locked(`folder:${args.folder_id}`,async()=>{
      let changed = false;
      try {
        const folder = this.config.folders.find(f=>f.id===args.folder_id);
        if (!folder) throw new Error('NOT_FOUND_OR_DENIED'); this.check('new_session',{cwd:folder.path});
        await validateExecutionCwd(folder.path);
        const id = randomUUID(), timestamp = new Date().toISOString();
        const file = path.join(this.config.sessionRoots[0],`${timestamp.replace(/[:.]/g,'-')}_${id}.jsonl`);
        const fd = await fs.open(file,'wx',0o600); changed = true;
        try { await fd.writeFile(`${JSON.stringify({type:'session',version:3,id,timestamp,cwd:folder.path})}\n`); await fd.sync(); } finally { await fd.close(); }
        await syncDir(path.dirname(file));
        return save({status:'created',session_id:opaqueId(`${file}\0${id}`)});
      } catch(e) { return save({status:changed?'unknown':'rejected',reason:safeReason(e)}); }
    }));
  }
  async delete(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    return this.journal.run(args.request_id,'delete',args.session_id,{},save=>this.locked(args.session_id,async()=>{
      let trash, release;
      try {
        const s = await this.session(args.session_id); this.check('delete',s);
        trash = await prepareTrash(this.config,s);
        release=await this.pool.stopForDelete(s); // Hold ownership through the move.
        await trash.move();
        return save({status:'deleted',recoverable:true,restore_token:trash.token});
      } catch(e) { return save({status:trash?.moved?'unknown':'rejected',reason:safeReason(e)}); }
      finally {await trash?.cancel().catch(()=>{});await release?.();}
    }));
  }
  async releaseForLocal({session_id}){
    this.assertOpen();
    return this.locked(session_id,async()=>{
      this.assertOpen();
      const session=await this.session(session_id),dir=this.pool.attachmentDir;
      if(this.pool.starting.has(session_id))throw new Error('RUNTIME_IDLE_UNCONFIRMED');
      const runtime=await this.pool.forRead(session);
      if(runtime?.attached)throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
      if(runtime){
        if(!(runtime instanceof PiRpc))throw new Error('BRIDGE_OWNED_RUNTIME_REQUIRED');
        await runtime.assertReleasable();
        await updateOwner(dir,session,runtime.ownerRecord,{noColdReacquire:true});
        await this.pool.stop(session_id); // Wait exact child exit; stop never targets external owners.
      }else await registryTransaction(dir,async()=>{
        const current=await readClaim(dir,session);
        if(current&&await ownerAlive(current.owner))throw new Error('LIVE_OWNER_UNREACHABLE');
        await atomicJson(claimFile(dir,session),{kind:'rpc',file:session.file,sessionId:session.header.id,
          generation:current?.generation??randomUUID(),owner:null,phase:'released',noColdReacquire:true});
      });
      return {session_id,status:'released',no_cold_reacquire:true};
    });
  }
  async resetColdResume({session_id,confirm_local_closed}){
    this.assertOpen();
    if(confirm_local_closed!==true)throw new Error('LOCAL_CLOSE_CONFIRMATION_REQUIRED');
    return this.locked(session_id,async()=>{
      this.assertOpen();const session=await this.session(session_id),dir=this.pool.attachmentDir;
      await registryTransaction(dir,async()=>{
        const current=await readClaim(dir,session);
        if(current&&await ownerAlive(current.owner))throw new Error('OWNER_STILL_ALIVE');
        // This confirms cooperative owners only; caller must close unregistered Pi too.
        if(current?.noColdReacquire)await fs.unlink(claimFile(dir,session));
      });
      return {session_id,status:'reset',no_cold_reacquire:false};
    });
  }
  assertOpen() { if (this.closing) throw new Error('BRIDGE_CLOSING'); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.ownerControl?.close();
      await Promise.allSettled([...this.journal.running.values()]);
      await this.pool.close();
      await Promise.allSettled([...this.journal.transitions.values()]);
      await Promise.allSettled([...this.journal.writes.values()]);
      if (this.lock) { await this.lock.close(); await fs.unlink(this.lockPath); this.lock = null; }
    })();
    return this.closePromise;
  }
}
function safeReason(error) {
  const code = error.code ?? error.message;
  diagnostics.emit('operation.failure',{code,uncertain:error.uncertain===true});
  return ['STOP_IN_PROGRESS','STOP_UNSUPPORTED','INVALID_STOP_RECEIPT','ATTACHED_OPERATION_FAILED','COLD_REACQUIRE_BLOCKED','HOST_RELEASE_UNSUPPORTED','HOST_RELEASE_FAILED','HOST_NOT_READY','HOST_SUBMIT_UNCERTAIN','EXECUTION_CWD_UNAVAILABLE','INVALID_SESSION','INVALID_SESSION_TREE','NOT_FOUND_OR_DENIED','ATTACHMENT_REQUEST_TOO_LARGE','PROMPT_ADMISSION_PENDING','PI_REJECTED','ACK_TIMEOUT','WRITE_UNKNOWN','RUNTIME_DISCONNECTED','RUNTIME_START_FAILED','RUNTIME_SESSION_CHANGED','LIVE_OWNER_UNREACHABLE','OWNER_STILL_ALIVE','ATTACHMENT_REGISTRY_BUSY','PI_ACCEPTANCE_UNOBSERVABLE'].includes(code) ? code : 'OPERATION_FAILED';
}
