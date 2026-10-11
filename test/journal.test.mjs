import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { diagnostics } from '../src/diagnostics.mjs';

const deferred=()=>Promise.withResolvers();
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t){
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-journal-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  return new Journal({stateDir,principal:'public-test'});
}
// Hold atomic replacement at the actual filesystem boundary, after its
// snapshot has been written but before readers can observe that snapshot.
function gateRename(t,journal,predicate){
  const entered=deferred(),release=deferred(),rename=fs.rename;
  let used=false;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(!used&&to===journal.file('request')){
      const snapshot=JSON.parse(await fs.readFile(from,'utf8'));
      if(predicate(snapshot.receipt)){
        used=true;entered.resolve();await release.promise;
      }
    }
    return rename(from,to);
  });
  t.after(()=>release.resolve());
  return {entered:entered.promise,release:()=>release.resolve()};
}

test('overlapping unknown and late ACK saves return and log their own durable receipts',{timeout:10000},async t=>{
  const journal=await setup(t),events=[];
  t.mock.method(diagnostics,'emit',(event,fields)=>events.push({event,...fields}));
  const unknownGate=gateRename(t,journal,r=>r.reason==='ACK_TIMEOUT');
  // Separate gate for the accepted replacement, so disk must remain unknown
  // while the first save resolves and emits its diagnostic event.
  const acceptedEntered=deferred(),acceptedRelease=deferred(),rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===journal.file('request')){
      const snapshot=JSON.parse(await fs.readFile(from,'utf8'));
      if(snapshot.receipt.status==='accepted'){
        acceptedEntered.resolve();await acceptedRelease.promise;
      }
    }
    return rename(from,to);
  });
  t.after(()=>acceptedRelease.resolve());
  await journal.run('request','send','session',{message:'public'},async save=>{
    const first=save({status:'unknown',reason:'ACK_TIMEOUT'});
    await unknownGate.entered;
    const late=save({status:'accepted',disposition:'started'});
    unknownGate.release();
    const initial=await first;
    await acceptedEntered.promise;
    assert.equal(initial.status,'unknown');
    assert.equal(JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt.status,'unknown');
    assert.deepEqual(events.filter(e=>e.event==='receipt.saved').map(e=>e.status),['unknown']);
    acceptedRelease.resolve();
    assert.equal((await late).status,'accepted');
    assert.equal((await journal.get('request')).receipt.status,'accepted');
    assert.deepEqual(events.filter(e=>e.event==='receipt.saved').map(e=>e.status),['unknown','accepted']);
  });
});

test('unknown terminal short-circuit waits for accepted persistence',{timeout:10000},async t=>{
  const journal=await setup(t),gate=gateRename(t,journal,r=>r.status==='accepted');
  await journal.run('request','send','session',{message:'public'},async save=>{
    const accepted=save({status:'accepted'});
    await gate.entered;
    let settled=false;
    const unknown=save({status:'unknown'}).then(receipt=>{settled=true;return receipt;});
    await turn();
    assert.equal(settled,false);
    assert.equal(JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt.status,'unknown');
    gate.release();
    assert.equal((await accepted).status,'accepted');
    assert.equal((await unknown).status,'accepted');
    assert.equal((await journal.get('request')).receipt.status,'accepted');
  });
});

test('failed terminal persistence remains unknown on replay and later ACK can recover',{timeout:10000},async t=>{
  const journal=await setup(t),events=[];
  t.mock.method(diagnostics,'emit',(event,fields)=>events.push({event,...fields}));
  const rename=fs.rename;
  let failed=false,saveLater,actions=0;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===journal.file('request')&&!failed){
      const snapshot=JSON.parse(await fs.readFile(from,'utf8'));
      if(snapshot.receipt.status==='accepted'){
        failed=true;throw Object.assign(new Error('fixture write failure'),{code:'EIO'});
      }
    }
    return rename(from,to);
  });
  await assert.rejects(journal.run('request','send','session',{message:'public'},async save=>{
    actions++;saveLater=save;
    const accepted=save({status:'accepted'});
    const unknown=save({status:'unknown',reason:'WRITE_UNKNOWN'});
    await assert.rejects(accepted,{code:'EIO'});
    assert.equal((await unknown).status,'unknown');
    throw Object.assign(new Error('fixture action failure'),{code:'EIO'});
  }),{code:'EIO'});
  const replay=await journal.run('request','send','session',{message:'public'},()=>{actions++;});
  assert.equal(actions,1);
  assert.equal(replay.status,'unknown');
  assert.equal(events.some(e=>e.event==='receipt.saved'&&e.status==='accepted'),false);
  assert.equal((await saveLater({status:'accepted'})).status,'accepted');
  assert.equal((await journal.get('request')).receipt.status,'accepted');
  assert.equal((await journal.run('request','send','session',undefined,()=>{actions++;})).status,'accepted');
  assert.equal(actions,1);
});

test('save snapshots inputs and returned receipts cannot mutate terminal state',{timeout:10000},async t=>{
  const journal=await setup(t);
  await journal.run('request','send','session',{message:'public'},async save=>{
    const input={status:'accepted',detail:{value:'original'}};
    const pending=save(input);
    input.status='rejected';input.detail.value='changed';
    const returned=await pending;
    assert.equal(returned.status,'accepted');
    assert.equal(returned.detail.value,'original');
    returned.status='unknown';returned.detail.value='caller changed';
    const terminal=await save({status:'unknown'});
    assert.equal(terminal.status,'accepted');
    assert.equal(terminal.detail.value,'original');
    terminal.detail.value='changed again';
    assert.equal((await save({status:'unknown'})).detail.value,'original');
    assert.equal((await journal.get('request')).receipt.detail.value,'original');
  });
});

test('initial receipt persistence failure prevents action execution',{timeout:10000},async t=>{
  const journal=await setup(t),rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===journal.file('request'))throw Object.assign(new Error('fixture unavailable'),{code:'EIO'});
    return rename(from,to);
  });
  let actions=0;
  await assert.rejects(journal.run('request','send','session',{message:'public'},()=>{actions++;}),{code:'EIO'});
  assert.equal(actions,0);
  await assert.rejects(journal.get('request'),{code:'EIO'});
});

test('same-ID replay waits for late ACK directory sync after atomic rename',{timeout:10000},async t=>{
  const journal=await setup(t),entered=deferred(),release=deferred(),open=fs.open;
  let saveLater,actions=0,held=false;
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open(file,...args);
    if(file===path.dirname(journal.file('request'))&&!held){
      const receipt=JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt;
      if(receipt.status==='accepted'){
        held=true;const sync=handle.sync.bind(handle);
        t.mock.method(handle,'sync',async()=>{entered.resolve();await release.promise;return sync();});
      }
    }
    return handle;
  });
  t.after(()=>release.resolve());
  await journal.run('request','send','session',{message:'public'},save=>{
    actions++;saveLater=save;return save({status:'unknown',reason:'ACK_TIMEOUT'});
  });
  const late=saveLater({status:'accepted'});
  await entered.promise;
  assert.equal(JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt.status,'accepted');
  let settled=false;
  const replay=journal.run('request','send','session',{message:'public'},()=>{actions++;}).then(value=>{settled=true;return value;});
  await turn();assert.equal(settled,false);assert.equal(actions,1);
  release.resolve();await late;
  assert.equal((await replay).status,'accepted');assert.equal(actions,1);
});

test('failed late ACK directory sync cannot replay accepted bytes until persistence recovers',{timeout:10000},async t=>{
  const journal=await setup(t),open=fs.open;
  let saveLater,actions=0,failed=false;
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open(file,...args);
    if(file===path.dirname(journal.file('request'))&&!failed){
      const receipt=JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt;
      if(receipt.status==='accepted'){
        failed=true;
        t.mock.method(handle,'sync',async()=>{throw Object.assign(new Error('fixture sync failure'),{code:'EIO'});});
      }
    }
    return handle;
  });
  await journal.run('request','send','session',{message:'public'},save=>{
    actions++;saveLater=save;return save({status:'unknown',reason:'ACK_TIMEOUT'});
  });
  await assert.rejects(saveLater({status:'accepted'}),{code:'EIO'});
  assert.equal(JSON.parse(await fs.readFile(journal.file('request'),'utf8')).receipt.status,'accepted');
  await assert.rejects(journal.get('request'),{code:'EIO'});
  await assert.rejects(journal.run('request','send','session',{message:'public'},()=>{actions++;}),{code:'EIO'});
  assert.equal(actions,1);
  await saveLater({status:'accepted'});
  assert.equal((await journal.run('request','send','session',undefined,()=>{actions++;})).status,'accepted');
  assert.equal(actions,1);
});
