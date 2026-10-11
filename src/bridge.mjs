import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { permitted, inside } from './permissions.mjs';
import { discover, opaqueId, renderRead, hash, syncDir } from './data.mjs';
import { RuntimePool } from './rpc.mjs';
import { Journal } from './journal.mjs';
import { privateDirectory } from './attachments.mjs';
import { readOwnerConfig, validateGrants } from './owner-config.mjs';
import { diagnostics } from './diagnostics.mjs';
export class Bridge {
  constructor(config, factory, {configFile}={}) { this.config = config; this.configFile=configFile;const {grants,...settings}=config;this.ownerSettings=structuredClone(settings);this.pool = new RuntimePool(config,factory); this.journal = new Journal(config); this.locks = new Map(); }
  async init() {
    if (!this.config.principal || !path.isAbsolute(this.config.stateDir) || !Array.isArray(this.config.sessionRoots) || this.config.sessionRoots.length === 0) throw new Error('INVALID_OWNER_CONFIG');
    validateGrants(this.config.grants);
    if(this.config.attachmentExitTimeoutMs!==undefined&&(!Number.isInteger(this.config.attachmentExitTimeoutMs)||this.config.attachmentExitTimeoutMs<50||this.config.attachmentExitTimeoutMs>30000))throw new Error('INVALID_OWNER_CONFIG');
    if(this.config.attachmentDir)await privateDirectory(this.config.attachmentDir);
    await fs.mkdir(this.config.stateDir,{recursive:true,mode:0o700});
    if (await fs.realpath(this.config.stateDir) !== path.resolve(this.config.stateDir)) throw new Error('SYMLINK_STATE_NOT_ALLOWED');
    for (const root of this.config.sessionRoots) {
      if (inside(root,this.config.stateDir) || inside(this.config.stateDir,root)) throw new Error('OVERLAPPING_STORAGE');
    }
    for (let i=0;i<this.config.sessionRoots.length;i++) for (let j=i+1;j<this.config.sessionRoots.length;j++) {
      if (inside(this.config.sessionRoots[i],this.config.sessionRoots[j]) || inside(this.config.sessionRoots[j],this.config.sessionRoots[i])) throw new Error('OVERLAPPING_STORAGE');
    }
    for (const root of this.config.sessionRoots) {
      if (!path.isAbsolute(root)) throw new Error('INVALID_OWNER_CONFIG');
      await fs.mkdir(root,{recursive:true,mode:0o700});
      if (await fs.realpath(root) !== path.resolve(root)) throw new Error('SYMLINK_ROOT_NOT_ALLOWED');
    }
    for (const folder of this.config.folders) {
      if (!path.isAbsolute(folder.path) || await fs.realpath(folder.path) !== path.resolve(folder.path)) throw new Error('INVALID_PROJECT_FOLDER');
    }
    // One bridge process per state directory. Do not automatically steal stale locks.
    this.lockPath = path.join(this.config.stateDir,'bridge.lock');
    this.lock = await fs.open(this.lockPath,'wx',0o600); await this.lock.writeFile(`${process.pid}\n`);
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
      const name = s.entries.findLast(e=>e.type==='session_info')?.name;
      const title = typeof name==='string' ? name.trim() || null : null;
      if (args.query && !JSON.stringify({title,cwd:s.cwd}).toLowerCase().includes(args.query.toLowerCase())) continue;
      rows.push({session_id:s.id,title:typeof title==='string'?title.slice(0,200):null,cwd:s.cwd.slice(0,1024),leaf_id:s.leafId,permissions:{read:true,send:permitted(this.config,'send',s),delete:permitted(this.config,'delete',s)}});
    }
    const offset = args.offset ?? 0, limit = Math.min(100,args.limit ?? 30);
    return {sessions:rows.slice(offset,offset+limit),next_offset:offset+limit < rows.length ? offset+limit:null,
      folders:this.config.folders.filter(f=>permitted(this.config,'new_session',{cwd:f.path})).map(f=>({folder_id:f.id}))};
  }
  async read(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    const s = await this.session(args.session_id); this.check('read',s);
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
    return renderRead(s,args,{leafSource:runtime?'live':'saved_resume'});
  }
  async send(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    const body = args.text === undefined ? undefined : {text:args.text,mode:args.mode ?? 'native'};
    return this.journal.run(args.request_id,'send',args.session_id,body,save=>this.locked(args.session_id,async()=>{
      try {
        const s = await this.session(args.session_id); this.check('send',s);
        const runtime = await this.pool.resolve(s); // Resolve/resume first; saved is not busy.
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
  async create(args) {
    this.assertOpen();if(this.configFile){await this.refreshPermissions();this.assertOpen();}
    return this.journal.run(args.request_id,'create',args.folder_id,{},save=>this.locked(`folder:${args.folder_id}`,async()=>{
      let changed = false;
      try {
        const folder = this.config.folders.find(f=>f.id===args.folder_id);
        if (!folder) throw new Error('NOT_FOUND_OR_DENIED'); this.check('new_session',{cwd:folder.path});
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
      let changed = false, release;
      try {
        const s = await this.session(args.session_id); this.check('delete',s);
        release=await this.pool.stopForDelete(s); // Stop and confirm exit; hold ownership through the move.
        const trash = path.join(this.config.stateDir,'trash'); await fs.mkdir(trash,{recursive:true,mode:0o700});
        const token = randomUUID();
        const metadata = await fs.open(path.join(trash,`${token}.restore.json`),'wx',0o600);
        try { await metadata.writeFile(JSON.stringify({original_path:s.file,session_id:s.id})); await metadata.sync(); } finally { await metadata.close(); }
        await syncDir(trash);
        await fs.rename(s.file,path.join(trash,`${token}.jsonl`)); changed = true;
        await syncDir(trash); await syncDir(path.dirname(s.file));
        return save({status:'deleted',recoverable:true,restore_token:token});
      } catch(e) { return save({status:changed?'unknown':'rejected',reason:safeReason(e)}); }
      finally {await release?.();}
    }));
  }
  assertOpen() { if (this.closing) throw new Error('BRIDGE_CLOSING'); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.journal.running.values()]);
      await this.pool.close();
      await Promise.allSettled([...this.journal.writes.values()]);
      if (this.lock) { await this.lock.close(); await fs.unlink(this.lockPath); this.lock = null; }
    })();
    return this.closePromise;
  }
}
function safeReason(error) {
  const code = error.code ?? error.message;
  return ['NOT_FOUND_OR_DENIED','ATTACHMENT_REQUEST_TOO_LARGE','PROMPT_ADMISSION_PENDING','PI_REJECTED','ACK_TIMEOUT','WRITE_UNKNOWN','RUNTIME_DISCONNECTED','RUNTIME_START_FAILED','RUNTIME_SESSION_CHANGED','LIVE_OWNER_UNREACHABLE','OWNER_STILL_ALIVE','ATTACHMENT_REGISTRY_BUSY','PI_ACCEPTANCE_UNOBSERVABLE'].includes(code) ? code : 'OPERATION_FAILED';
}
