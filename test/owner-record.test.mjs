import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNoOtherLiveOwner, claimFile, privateDirectory, processIdentity, readClaim } from '../src/attachments.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-owner-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await privateDirectory(dir);
  const session={file:path.join(dir,'session.jsonl'),header:{id:'original'}};
  const record={file:session.file,sessionId:session.header.id,kind:'rpc',generation:'fixture-generation',phase:'starting',owner:await processIdentity()};
  const file=claimFile(dir,session);
  await fs.writeFile(file,JSON.stringify(record),{mode:0o600});
  return {dir,session,record,file,replacement:{file:session.file,header:{id:'replacement'}}};
}

test('both direct lookup and cross-identity scan reject unsafe owner records',async t=>{
  const cases={
    'malformed JSON':async f=>fs.writeFile(f.file,'{'),
    'missing owner':async f=>fs.writeFile(f.file,JSON.stringify({...f.record,owner:null})),
    'invalid kind':async f=>fs.writeFile(f.file,JSON.stringify({...f.record,kind:'foreign'})),
    'outside TUI socket':async f=>fs.writeFile(f.file,JSON.stringify({...f.record,kind:'tui',socket:'/tmp/outside.sock'})),
    'outside extension socket':async f=>fs.writeFile(f.file,JSON.stringify({...f.record,kind:'extension',socket:'/tmp/outside.sock'})),
    'oversized record':async f=>fs.writeFile(f.file,JSON.stringify({...f.record,padding:'x'.repeat(8192)})),
    'group-readable record':async f=>fs.chmod(f.file,0o640),
    'symbolic link':async f=>{const target=path.join(f.dir,'target');await fs.rename(f.file,target);await fs.symlink(target,f.file);},
    'directory':async f=>{await fs.unlink(f.file);await fs.mkdir(f.file,{mode:0o700});},
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,async t=>{
    const f=await fixture(t);await mutate(f);
    await assert.rejects(readClaim(f.dir,f.session),{code:'INVALID_ATTACHMENT_RECORD'});
    await assert.rejects(assertNoOtherLiveOwner(f.dir,f.replacement),{code:'INVALID_ATTACHMENT_RECORD'});
  });
});

test('validated scans preserve exact process identity and all ownership phases',async t=>{
  const f=await fixture(t);
  for(const kind of ['rpc','tui','host','extension'])for(const phase of ['starting','ready','transitioning']){
    const record={...f.record,kind,phase,...(kind!=='rpc'?{socket:path.join(f.dir,'fixture.sock')}:{})};
    await fs.writeFile(f.file,JSON.stringify(record));
    assert.deepEqual(await readClaim(f.dir,f.session),record);
    await assert.rejects(assertNoOtherLiveOwner(f.dir,f.replacement),{code:'LIVE_OWNER_UNREACHABLE'});
    await fs.writeFile(f.file,JSON.stringify({...record,owner:{...record.owner,start:'obsolete-start'}}));
    await assertNoOtherLiveOwner(f.dir,f.replacement);
  }
  await fs.unlink(f.file);
  assert.equal(await readClaim(f.dir,f.session),null);
  await assertNoOtherLiveOwner(f.dir,f.replacement);
});

test('direct lookup still rejects a record for a different native session identity',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.file,JSON.stringify({...f.record,sessionId:'different'}));
  await assert.rejects(readClaim(f.dir,f.session),{code:'INVALID_ATTACHMENT_RECORD'});
});
