// Bind existing owners through Pi 1.1 public APIs. These helpers never open a
// session, spawn a process, read stdio, or access private admission hooks.
import { requestRpcStop, stopReceipt } from './stop-execution.mjs';
const unknown=()=>({status:'unknown',dispatch:'submitted',reason:'PI_ACCEPTANCE_UNOBSERVABLE',completion:'not_tracked'});
const options=mode=>mode==='steer'?{streamingBehavior:'steer'}:mode==='queue'?{streamingBehavior:'followUp'}:{};
const identity=state=>({sessionFile:state.sessionFile,sessionId:state.sessionId});
function assertIdentity(before,after){
  if(before.sessionFile!==after.sessionFile||before.sessionId!==after.sessionId)throw new Error('RUNTIME_SESSION_CHANGED');
}
function tracker(release,onError){
  const pending=new Set();
  function track(work){
    const promise=Promise.resolve(work);pending.add(promise);
    promise.then(()=>pending.delete(promise),error=>{
      pending.delete(promise);
      // Host-local observer only; raw provider errors never enter MCP receipts.
      try{onError?.(error);}catch{}
    });
    return promise;
  }
  return {track,...(release?{release:async()=>{
    // The host must stop admission, abort/drain ALL its session work and close
    // the writer. Waiting only our dispatched promises cannot prove release.
    const outcome=await release();
    if(outcome?.released!==true)throw new Error('HOST_RELEASE_UNCONFIRMED');
    await Promise.allSettled([...pending]);
    return {released:true};
  }}:{})};
}

export function createSdkHostBinding(session,{release,onError}={}){
  const tracked=tracker(release,onError);
  const state=async()=>({...identity(session),isIdle:session.isIdle,isStreaming:session.isStreaming,
    isCompacting:session.isCompacting,pendingMessageCount:session.pendingMessageCount});
  return {
    state,
    snapshot:async()=>{
      const before=identity(session);
      const entries=structuredClone(session.sessionManager.getEntries()),leafId=session.sessionManager.getLeafId();
      assertIdentity(before,identity(session));
      return {...before,entries,leafId};
    },
    submit:async({text,mode='native'})=>{
      if(!['native','idle_only','steer','queue'].includes(mode))throw new Error('INVALID_HOST_SUBMISSION');
      if(mode==='idle_only'&&!session.isIdle)return {status:'skipped',reason:'busy'};
      // Public prompt() resolves at completion, not at admission. Even a
      // synchronous throw after entering host code cannot prove no side effect.
      try{tracked.track(session.prompt(text,options(mode)));}catch(error){try{onError?.(error);}catch{}}
      return unknown();
    },
    stop:async({onWithdraw,...expected}={})=>{
      if(typeof onWithdraw!=='function'||!['clearQueue','abort','abortBash'].every(name=>typeof session[name]==='function'))throw new Error('STOP_UNSUPPORTED');
      const before=identity(session);assertIdentity(expected,before);
      const withdrawn=session.clearQueue(),cancellation=tracked.track(session.abort());
      session.abortBash();
      await onWithdraw(withdrawn);await cancellation;
      assertIdentity(before,identity(session));
      await onWithdraw(session.clearQueue());
      return stopReceipt({acknowledgement:'native_ack',coverage:'agent_and_bash'});
    },
    ...(tracked.release?{release:tracked.release}:{}),
  };
}

export function createRpcHostBinding(client,{release,onError}={}){
  const tracked=tracker(release,onError);
  const state=async()=>{
    const value=await client.getState();
    return {...identity(value),isStreaming:value.isStreaming,isCompacting:value.isCompacting,pendingMessageCount:value.pendingMessageCount};
  };
  return {
    state,
    snapshot:async()=>{
      const before=await state(),snapshot=await client.getEntries(),after=await state();
      assertIdentity(before,after);
      return {...identity(after),entries:structuredClone(snapshot.entries),leafId:snapshot.leafId};
    },
    submit:async({text,mode='native'})=>{
      if(!['native','idle_only','steer','queue'].includes(mode))throw new Error('INVALID_HOST_SUBMISSION');
      if(mode==='idle_only'){
        const observed=await state();
        if(observed.isStreaming||observed.isCompacting)return {status:'skipped',reason:'busy'};
      }
      try{
        const disposition=await tracked.track(client.prompt(text,undefined,options(mode).streamingBehavior));
        if(!['started','queued','handled'].includes(disposition))return unknown();
        return {status:'accepted',disposition,completion:'not_tracked'};
      }catch(error){
        // Official RpcClient exposes both negative ACKs and transport failures
        // as plain Errors. Never infer rejection by parsing a raw error string.
        return unknown();
      }
    },
    stop:async({onWithdraw,...expected}={})=>{
      if(typeof onWithdraw!=='function'||!['clearQueue','abort','abortBash'].every(name=>typeof client[name]==='function'))throw new Error('STOP_UNSUPPORTED');
      const before=await state();assertIdentity(expected,before);
      const result=await tracked.track(requestRpcStop(client,async value=>{
        assertIdentity(before,await state());await onWithdraw(value);
      }));
      assertIdentity(before,await state());return result;
    },
    ...(tracked.release?{release:tracked.release}:{}),
  };
}
