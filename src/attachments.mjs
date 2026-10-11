import { MAX_ATTACHMENT_REQUEST_BYTES } from './attachment-protocol.mjs';
import { diagnostics } from './diagnostics.mjs';
// Cooperative, owner-private Linux/Unix-socket attachment transport. No credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { atomicJson, opaqueId, assertSingleSessionFile } from './data.mjs';
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
export async function ownerAlive(owner){
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
  try{
    const file=claimFile(dir,session),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>8192)throw new Error();
    const record=JSON.parse(await fs.readFile(file,'utf8'));
    if(record.file!==session.file||record.sessionId!==session.header.id||!['tui','rpc'].includes(record.kind)||typeof record.generation!=='string'||!Number.isSafeInteger(record.owner?.pid)||record.owner.pid<1||typeof record.owner.start!=='string'||typeof record.owner.boot!=='string')throw new Error();
    if(record.kind==='tui'&&(typeof record.socket!=='string'||path.dirname(record.socket)!==dir))throw new Error();
    return record;
  }catch(e){if(e.code==='ENOENT')return null;throw new AttachmentFailure('INVALID_ATTACHMENT_RECORD');}
}
// Call while holding registryTransaction: a changed header must not bypass
// an existing path owner merely because its claim has a different filename.
export async function assertNoOtherLiveOwner(dir,session){
  for(const name of await fs.readdir(dir)){
    if(!/^ps_[a-f0-9]{32}\.owner\.json$/.test(name))continue;
    const other=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
    if(other.file===session.file&&other.sessionId!==session.header.id&&await ownerAlive(other.owner))throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
  }
}
export async function reserveOwner(dir,session,kind,owner=undefined){
  return registryTransaction(dir,async()=>{
    await assertSingleSessionFile(session.file);
    await assertNoOtherLiveOwner(dir,session);
    const old=await readClaim(dir,session);
    if(old&&await ownerAlive(old.owner))throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
    const record={kind,file:session.file,sessionId:session.header.id,generation:randomUUID(),owner:owner??await processIdentity(),phase:'starting'};
    if(kind==='tui')record.socket=path.join(dir,`${process.pid}-${record.generation.slice(0,8)}.sock`);
    await atomicJson(claimFile(dir,session),record);return record;
  });
}
export async function updateOwner(dir,session,record,changes){
  return registryTransaction(dir,async()=>{
    const current=await readClaim(dir,session);
    if(current?.generation!==record.generation)throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    Object.assign(record,changes);await atomicJson(claimFile(dir,session),record);return record;
  });
}
export async function releaseOwner(dir,session,record){
  return registryTransaction(dir,async()=>{
    const current=await readClaim(dir,session);
    if(current?.generation===record.generation)await fs.unlink(claimFile(dir,session));
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
          if(response.error)return finish(new AttachmentFailure(['RUNTIME_SESSION_CHANGED','SESSION_TOO_LARGE','ENTRY_NOT_FOUND','STALE_CURSOR','INVALID_CURSOR','SINCE_REQUIRES_RAW'].includes(response.error)?response.error:'ATTACHED_OPERATION_FAILED',written&&op==='send'));
          finish(null,response.data);
        }catch{finish(new AttachmentFailure('INVALID_ATTACHMENT_RESPONSE',written&&op==='send'));}
      });
    });
  }
  async start(){await this.state();return this;}
  state(){return this.request('state');}
  read(args){return this.request('read',args);}
  send(args){return this.request('send',{text:args.text,mode:args.mode??'native'},args.timeout_ms??5000);}
  async stop(){this.alive=false;} // Disconnect only. Never shut down the user's TUI on bridge close.
  async stopForDelete(){
    await this.request('shutdown');
    await waitOwnerExit(this.record.owner,this.config.attachmentExitTimeoutMs??5000);
    await releaseOwner(this.config.attachmentDir,this.session,this.record);this.alive=false;
  }
}
