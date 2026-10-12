// Load explicitly in the owner's ordinary Pi TUI or RPC: -e /absolute/path/src/attach-extension.mjs
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, hash, renderRead, assertSingleSessionFile, readSessionIdentity } from './data.mjs';
import { activityObservation } from './activity.mjs';
import { MAX_ATTACHMENT_REQUEST_BYTES } from './attachment-protocol.mjs';
import { privateDirectory, processIdentity, ownerAlive, registryTransaction, readClaim, readOwnerRecord, claimFile, updateOwner, assertNoOtherLiveOwner, AttachmentFailure } from './attachments.mjs';

export default function attachExtension(pi){
  const dir=process.env.PI_MCP_ATTACH_DIR;let active;
  if(!dir)return;
  async function closeServer(runtime){
    if(!runtime)return;
    runtime.ready=false;
    for(const socket of runtime.connections)socket.destroy();
    await new Promise(resolve=>runtime.server.close(resolve));
  }
  async function validateStorage(runtime) {
    try {
      let stat=await assertSingleSessionFile(runtime.session.file,{allowMissing:!runtime.fileObserved});
      if(!stat&&runtime.ctx.sessionManager.getEntries().some(e=>e.type==='message'&&['user','assistant'].includes(e.message?.role))){
        // First persistence can occur after the missing-file snapshot but
        // before the in-memory snapshot. Recheck the now-required file before
        // deciding that those observations represent a storage failure.
        stat=await assertSingleSessionFile(runtime.session.file);
      }
      if(!stat&&runtime.session.header.version!==3)throw new AttachmentFailure('ATTACH_REQUIRES_SAVED_SESSION');
      if(stat&&!runtime.fileObserved){
        const saved=await readSessionIdentity(runtime.session.file);
        if(saved.header.id!==runtime.session.header.id)throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
        runtime.fileObserved=true;
      }
    }catch(error){
      if(active===runtime){runtime.ready=false;if(runtime.ctx.mode==='tui')try{runtime.ctx.shutdown();}catch{}}
      throw error; // Retain the claim until exact process death/replacement.
    }
  }
  // These events occur after the relevant persistence; every IPC request also
  // validates, including the first request after a previously absent file appears.
  pi.on('agent_settled',async(event)=>{
    if(!active?.ready)return;
    active.settlement={generation:active.record.generation,sequence:active.settlement.sequence+1,observed_at:new Date().toISOString(),aborted:event.aborted};
    await validateStorage(active);
  });
  for(const event of ['session_info_changed','session_compact'])pi.on(event,async()=>{
    if(active?.ready)await validateStorage(active);
  });
  pi.on('session_shutdown',async()=>{
    const runtime=active;if(!runtime)return;
    runtime.ready=false; // Retire captured callbacks before the first asynchronous lifecycle step.
    try {await updateOwner(dir,runtime.session,runtime.record,{phase:'transitioning'});}
    finally {await closeServer(runtime);}
    // Keep the claim through quit/reload/replacement until exact process death or a fresh session_start.
  });
  pi.on('session_start',async(_event,ctx)=>{
    if(!['tui','rpc'].includes(ctx.mode))return;
    try {
    await privateDirectory(dir);
    const file=ctx.sessionManager.getSessionFile(),header=ctx.sessionManager.getHeader();
    if(!file||!header||!path.isAbsolute(file))throw new AttachmentFailure('ATTACH_REQUIRES_SAVED_SESSION');
    const session={file,header},owner=await processIdentity();
    const record={kind:ctx.mode==='tui'?'tui':'extension',mode:ctx.mode,file,sessionId:header.id,generation:randomUUID(),owner,phase:'starting'};
    record.socket=path.join(dir,`${owner.pid}-${record.generation.slice(0,8)}.sock`);
    let fileObserved;
    await registryTransaction(dir,async()=>{
      const observation={session,ctx,fileObserved:false};
      await validateStorage(observation);
      fileObserved=observation.fileObserved;
      // The same path cannot be reserved under another live native identity,
      // whether first persistence has happened yet or not.
      await assertNoOtherLiveOwner(dir,session);
      const old=await readClaim(dir,session);
      const sameProcess=old?.owner&&old.owner.pid===owner.pid&&old.owner.start===owner.start&&old.owner.boot===owner.boot;
      if(old&&await ownerAlive(old.owner)&&!sameProcess){if(ctx.mode==='tui')ctx.shutdown();throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');}
      if(old?.noColdReacquire)record.noColdReacquire=true;
      await atomicJson(claimFile(dir,session),record);
    });
    // Publish blocking ownership before socket setup or any later fallible initialization.
    if(Buffer.byteLength(record.socket)>100)throw new AttachmentFailure('ATTACHMENT_SOCKET_PATH_TOO_LONG');
    const connections=new Set();
    const runtime={session,record,connections,ready:false,server:null,ctx,fileObserved,settlement:{generation:record.generation,sequence:0,observed_at:null,aborted:null}};
    const activity=()=>activityObservation('attached_context',{idle:ctx.isIdle(),pending:ctx.hasPendingMessages(),settlement:runtime.settlement});
    function check(request){
      if(active!==runtime||!runtime.ready||request.generation!==record.generation||request.file!==file||request.sessionId!==header.id||ctx.sessionManager.getSessionFile()!==file||ctx.sessionManager.getSessionId()!==header.id)throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
    }
    const server=net.createServer(socket=>{
      if(connections.size>=16){socket.destroy();return;}
      connections.add(socket);socket.setEncoding('utf8');socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>connections.delete(socket));
      let buffer='',handled=false;
      socket.on('data',async chunk=>{
        if(handled)return;buffer+=chunk;
        if(Buffer.byteLength(buffer)>MAX_ATTACHMENT_REQUEST_BYTES){socket.destroy();return;}
        const end=buffer.indexOf('\n');if(end<0)return;handled=true;
        try{
          const request=JSON.parse(buffer.slice(0,end));check(request);await validateStorage(runtime);check(request);let data;const args=request.body??{};
          if(request.op==='state')data={sessionFile:file,sessionId:header.id,isStreaming:!ctx.isIdle(),generation:record.generation,activity:activity()};
          else if(request.op==='read'){
            const entries=ctx.sessionManager.getEntries(),leafId=ctx.sessionManager.getLeafId();
            const revisionInput={entries,leaf:leafId,generation:record.generation};
            if(Buffer.byteLength(JSON.stringify(revisionInput))>32*1024*1024)throw new AttachmentFailure('SESSION_TOO_LARGE');
            data=renderRead({entries,leafId,revision:hash(revisionInput),activity:activity()},args,{leafSource:'live',generation:record.generation});
          }else if(request.op==='send'){
            if(typeof args.text!=='string'||!args.text.length||args.text.length>100000||!['native','idle_only','steer','queue'].includes(args.mode))throw new AttachmentFailure('INVALID_ATTACHED_SEND');
            if(args.mode==='idle_only'&&!ctx.isIdle())data={status:'skipped',reason:'busy'};
            else{
              const options={expandPromptTemplates:true};
              if(args.mode==='steer')options.deliverAs='steer';
              if(args.mode==='queue')options.deliverAs='followUp';
              pi.sendUserMessage(args.text,options);
              data={status:'unknown',dispatch:'submitted',reason:'PI_ACCEPTANCE_UNOBSERVABLE',completion:'not_tracked'};
            }
          }else if(request.op==='stop'){
            // TUI ctx.abort + getEditorText can recover joined text (including
            // prior draft), but no public context API aborts independent bash.
            // RPC ctx also lacks clearQueue. Don't claim partial work is stop-all.
            throw new AttachmentFailure('STOP_UNSUPPORTED');
          }else if(request.op==='shutdown'){
            if(ctx.mode==='rpc')throw new AttachmentFailure('HOST_RELEASE_UNSUPPORTED');
            data={shutdown:'requested'};
            socket.end(JSON.stringify({generation:record.generation,data})+'\n',()=>{
              try {check(request);ctx.shutdown();}
              catch { /* Reload/replacement may invalidate the captured context before the flush callback. */ }
            });return;
          }else throw new AttachmentFailure('INVALID_ATTACHED_OPERATION');
          socket.end(JSON.stringify({generation:record.generation,data})+'\n');
        }catch(error){socket.end(JSON.stringify({generation:record.generation,error:/^[A-Z_]+$/.test(error.code??error.message)?(error.code??error.message):'ATTACHED_OPERATION_FAILED'})+'\n');}
      });
    });
    runtime.server=server;active=runtime;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(record.socket,resolve);});
    await fs.chmod(record.socket,0o600);runtime.ready=true;
    await updateOwner(dir,session,record,{phase:'ready'});
    // A successful replacement lifecycle conclusively releases this process's previous native identity.
    await registryTransaction(dir,async()=>{
      for(const name of await fs.readdir(dir)){
        if(!/^ps_[a-f0-9]{32}\.owner\.json$/.test(name)||path.join(dir,name)===claimFile(dir,session))continue;
        const other=await readOwnerRecord(dir,path.join(dir,name));
        if(['tui','extension'].includes(other?.kind)&&other.owner?.pid===owner.pid&&other.owner.start===owner.start&&other.owner.boot===owner.boot){
          if(other.noColdReacquire)await atomicJson(path.join(dir,name),{...other,phase:'released',owner:null});
          else await fs.unlink(path.join(dir,name));
        }
      }
    });
    } catch(error) {
      // Pi catches hook errors. A TUI can request graceful exit; an externally
      // owned RPC host must remain under its owner's lifecycle control.
      // A published starting claim is retained until its exact process exits.
      try {if(ctx.mode==='tui')ctx.shutdown();} catch { /* Context may already be invalidated by another lifecycle. */ }
      throw error;
    }
  });
}
