import { MAX_ATTACHMENT_REQUEST_BYTES } from './attachment-protocol.mjs';
import { diagnostics } from './diagnostics.mjs';
// Cooperative, owner-private Linux/Unix-socket attachment transport. No credentials.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { atomicJson, opaqueId, assertSingleSessionFile, assertProjectedTextResponse } from './data.mjs';
export class AttachmentFailure extends Error {
  constructor(code,uncertain=false,options){super(code,options);this.code=code;this.uncertain=uncertain;}
}
export async function processIdentity(pid=process.pid){
  if(process.platform!=='linux'||!Number.isSafeInteger(pid)||pid<1)throw new AttachmentFailure('PROCESS_IDENTITY_UNAVAILABLE');
  try {
    let stat;
    try {stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');}
    catch(error){
      // Linux can open stat while the task exists, then return ESRCH from
      // read after it exits. Only errors from this PID's stat prove absence.
      if(['ENOENT','ESRCH'].includes(error.code))return null;
      throw error;
    }
    const boot=await fs.readFile('/proc/sys/kernel/random/boot_id','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    if(!/^\d+$/.test(fields[19]??'')||!fields[0]||!boot.trim())throw new Error('INVALID_PROCESS_IDENTITY');
    return {pid,start:fields[19],boot:boot.trim(),state:fields[0]};
  }catch(cause){throw new AttachmentFailure('PROCESS_IDENTITY_UNAVAILABLE',false,{cause});}
}
export function isReleasedOwner(record){
  return record?.owner===null&&record.phase==='released'&&record.noColdReacquire===true;
}
export async function ownerAlive(owner){
  if(owner===null)return false;
  const current=await processIdentity(owner.pid);
  return Boolean(current&&current.start===owner.start&&current.boot===owner.boot&&!['Z','X'].includes(current.state));
}
export async function privateDirectory(dir){
  if(typeof dir!=='string'||!path.isAbsolute(dir))throw new AttachmentFailure('INVALID_ATTACHMENT_DIRECTORY');
  // Validate identically for bridge and extension, before either can treat a missing claim as safe.
  if(Buffer.byteLength(path.join(dir,'2147483647-12345678.sock'))>100)throw new AttachmentFailure('ATTACHMENT_SOCKET_PATH_TOO_LONG');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||await fs.realpath(dir)!==path.resolve(dir))throw new AttachmentFailure('INVALID_ATTACHMENT_DIRECTORY');
}
export function claimFile(dir,session){return path.join(dir,`${opaqueId(`${session.file}\0${session.header.id}`)}.owner.json`);}
export async function registryTransaction(dir,action){
  await privateDirectory(dir);
  const lock=path.join(dir,'registry.lock');let fd;
  for(let attempt=0;attempt<100;attempt++){
    try{fd=await fs.open(lock,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,10));}
  }
  if(!fd)throw new AttachmentFailure('ATTACHMENT_REGISTRY_BUSY');
  try{await fd.writeFile(JSON.stringify(await processIdentity()));return await action();}
  finally{await fd.close();await fs.unlink(lock);}
}
export async function readClaim(dir,session){
  await privateDirectory(dir);
  return readOwnerRecord(dir,claimFile(dir,session),session);
}
export async function readOwnerRecord(dir,file,session){
  let handle;
  try{
    // Validate the opened inode and bound the read itself, including growth after stat.
    // NONBLOCK also prevents a replaced special file from hanging registry scans.
    handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>8192)throw new Error();
    const bytes=Buffer.alloc(8193);let length=0;
    while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>8192)throw new Error();
    const record=JSON.parse(bytes.subarray(0,length).toString('utf8'));
    const released=isReleasedOwner(record);
    const identified=Number.isSafeInteger(record?.owner?.pid)&&record.owner.pid>0&&typeof record.owner.start==='string'&&typeof record.owner.boot==='string';
    if(typeof record?.file!=='string'||typeof record.sessionId!=='string'||!['tui','rpc','host','extension','delete'].includes(record.kind)||typeof record.generation!=='string'||(!released&&!identified))throw new Error();
    if(session&&(record.file!==session.file||record.sessionId!==session.header.id))throw new Error();
    if((['tui','host','extension'].includes(record.kind)||record.socket!==undefined)&&(typeof record.socket!=='string'||path.dirname(record.socket)!==dir))throw new Error();
    if(record.noColdReacquire!==undefined&&typeof record.noColdReacquire!=='boolean')throw new Error();
    return record;
  }catch(e){if(e.code==='ENOENT')return null;throw new AttachmentFailure('INVALID_ATTACHMENT_RECORD');}
  finally{await handle?.close();}
}
// Call while holding registryTransaction: a changed header must not bypass
// an existing path owner merely because its claim has a different filename.
export async function assertNoOtherLiveOwner(dir,session){
  for(const name of await fs.readdir(dir)){
    if(!/^ps_[a-f0-9]{32}\.owner\.json$/.test(name))continue;
    const other=await readOwnerRecord(dir,path.join(dir,name));
    if(other&&other.file===session.file&&other.sessionId!==session.header.id&&await ownerAlive(other.owner))throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
  }
}
export async function reserveOwner(dir,session,kind,owner=undefined){
  return registryTransaction(dir,async()=>{
    await assertSingleSessionFile(session.file);
    await assertNoOtherLiveOwner(dir,session);
    const old=await readClaim(dir,session);
    if(old&&await ownerAlive(old.owner))throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
    if(kind==='rpc'&&old?.noColdReacquire)throw new AttachmentFailure('COLD_REACQUIRE_BLOCKED');
    const record={...(old?.noColdReacquire?{noColdReacquire:true}:{}),kind,file:session.file,sessionId:session.header.id,generation:randomUUID(),owner:owner??await processIdentity(),phase:'starting'};
    if(['tui','host','extension'].includes(kind))record.socket=path.join(dir,`${process.pid}-${record.generation.slice(0,8)}.sock`);
    await atomicJson(claimFile(dir,session),record);return record;
  });
}
export async function updateOwner(dir,session,record,changes){
  return registryTransaction(dir,async()=>{
    const current=await readClaim(dir,session);
    if(current?.generation!==record.generation)throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    if(isReleasedOwner(current)){
      // Late teardown is idempotent; never republish its cached live owner.
      if(changes.phase==='transitioning'&&Object.keys(changes).length===1)return current;
      throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    }
    Object.assign(record,current.noColdReacquire?{noColdReacquire:true}:{},changes);await atomicJson(claimFile(dir,session),record);return record;
  });
}
export async function releaseOwner(dir,session,record){
  return registryTransaction(dir,async()=>{
    const current=await readClaim(dir,session);
    if(current?.generation===record.generation){
      if(current.noColdReacquire)await atomicJson(claimFile(dir,session),{...current,phase:'released',owner:null});
      else await fs.unlink(claimFile(dir,session));
    }
  });
}
export async function waitOwnerExit(owner,timeout=5000){
  const until=Date.now()+timeout;
  while(await ownerAlive(owner)){
    if(Date.now()>=until)throw new AttachmentFailure('OWNER_STILL_ALIVE');
    await new Promise(r=>setTimeout(r,25));
  }
}
export class AttachedRuntime {
  constructor(config,session,record){this.config=config;this.session=session;this.record=record;this.alive=true;this.attached=true;}
  async request(op,body={},timeout=5000){
    return diagnostics.measure('attached.request',{op,generation:this.record.generation},()=>this.requestOnce(op,body,timeout));
  }
  async requestOnce(op,body={},timeout=5000){
    const serialized=JSON.stringify({op,body,generation:this.record.generation,file:this.record.file,sessionId:this.record.sessionId})+'\n';
    if(Buffer.byteLength(serialized)>MAX_ATTACHMENT_REQUEST_BYTES)throw new AttachmentFailure('ATTACHMENT_REQUEST_TOO_LARGE');
    const current=await readClaim(this.config.attachmentDir,this.session);
    if(current?.generation!==this.record.generation)throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    if(!await ownerAlive(this.record.owner)||current.phase!=='ready')throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
    return new Promise((resolve,reject)=>{
      const socket=net.createConnection(this.record.socket);socket.setEncoding('utf8');let bytes='',written=false,done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE',written&&op==='send')),timeout);
      socket.on('error',()=>finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE',written&&op==='send')));
      socket.on('end',()=>finish(new AttachmentFailure('LIVE_OWNER_UNREACHABLE',written&&op==='send')));
      socket.on('connect',()=>{written=true;socket.write(serialized);});
      socket.on('data',chunk=>{
        bytes+=chunk.toString();if(Buffer.byteLength(bytes)>100000)return finish(new AttachmentFailure('INVALID_ATTACHMENT_RESPONSE',written&&op==='send'));
        const newline=bytes.indexOf('\n');if(newline<0)return;
        try{const response=JSON.parse(bytes.slice(0,newline));
          if(response.generation!==this.record.generation)throw new Error();
          if(response.error)return finish(new AttachmentFailure(['RUNTIME_SESSION_CHANGED','SESSION_TOO_LARGE','ENTRY_NOT_FOUND','STALE_CURSOR','INVALID_CURSOR','SINCE_REQUIRES_RAW','INVALID_TEXT_SELECTOR','PROJECTED_MESSAGE_NOT_FOUND','TEXT_BLOCK_NOT_FOUND','TEXT_SECTION_NOT_FOUND','OWNER_READ_REFRESH_REQUIRED','NON_TEXT_CONTENT','INVALID_TEXT_OFFSET','TEXT_BUDGET_TOO_SMALL','HOST_RELEASE_UNSUPPORTED','HOST_RELEASE_FAILED','HOST_NOT_READY','HOST_SUBMIT_UNCERTAIN'].includes(response.error)?response.error:'ATTACHED_OPERATION_FAILED',written&&op==='send'));
          finish(null,response.data);
        }catch{finish(new AttachmentFailure('INVALID_ATTACHMENT_RESPONSE',written&&op==='send'));}
      });
    });
  }
  async start(){await this.state();return this;}
  state(timeout=5000){return this.request('state',{},timeout);}
  async read(args){const result=await this.request('read',args);assertProjectedTextResponse(result,args);return result;}
  send(args){return this.request('send',{text:args.text,mode:args.mode??'native'},args.timeout_ms??5000);}
  async stop(){this.alive=false;} // Disconnect only. Never shut down external Pi on bridge close.
  async stopForDelete(){
    // Public RPC extension shutdown is deferred, and this child is not ours.
    // Keep its read/send endpoint alive; never request host exit or kill it.
    if(this.record.kind==='extension')throw new AttachmentFailure('HOST_RELEASE_UNSUPPORTED');
    if(this.record.kind==='host'){
      // A shared SDK host may keep other sessions alive. Only the host can
      // close this session's admission and drain its own preparation work.
      const result=await this.request('release',{},this.config.attachmentExitTimeoutMs??5000);
      if(result?.released!==true)throw new AttachmentFailure('HOST_RELEASE_FAILED');
      const current=await readClaim(this.config.attachmentDir,this.session);
      if(current&&!(isReleasedOwner(current)&&current.generation===this.record.generation))throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
      this.alive=false;return;
    }
    await this.request('shutdown');
    await waitOwnerExit(this.record.owner,this.config.attachmentExitTimeoutMs??5000);
    await releaseOwner(this.config.attachmentDir,this.session,this.record);this.alive=false;
  }
}
