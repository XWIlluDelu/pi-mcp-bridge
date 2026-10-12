import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import { AttachedRuntime, readClaim, ownerAlive } from '../src/attachments.mjs';

async function until(check) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await delay(10);}
  throw new Error('COMPANION_FIXTURE_TIMEOUT');
}
const text=entry=>entry.type==='message'&&entry.message?.role==='user'
  ? (typeof entry.message.content==='string'?entry.message.content:entry.message.content.map(part=>part.text??'').join('')):'';

test('ordinary RPC plus remote MCP shares one extension owner, settlement, permissions and generation', {timeout:30000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-companion-')),cwd=path.join(dir,'project'),agentDir=path.join(dir,'agent');
  await fs.mkdir(cwd);await fs.mkdir(agentDir);
  await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarm:'off',compaction:{enabled:false},retry:{enabled:false}}));
  const config={principal:'rpc-companion',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,command:true,bash:true,delete:true,new_session:true}],attachmentDir:path.join(dir,'ipc')};
  const configFile=path.join(dir,'owner.json');await fs.writeFile(configFile,JSON.stringify(config));
  const setup=await new Bridge(config).init(),made=await setup.create({folder_id:'project',request_id:'seed'}),saved=await setup.session(made.session_id);
  await setup.close();
  const env=Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined]));
  Object.assign(env,{PATH:process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',PI_MCP_ATTACH_DIR:config.attachmentDir});
  const local=new RpcClient({cliPath:path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),cwd,env,provider:'bridge-fixture',model:'deterministic',
    args:['--session',saved.file,'-e',path.resolve('research/faux-extension.mjs'),'-e',path.resolve('src/attach-extension.mjs')]});
  let remote=new Client({name:'companion-review',version:'1'});
  const connect=()=>remote.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),configFile],cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:dir,PI_OFFLINE:'1'},stderr:'pipe'}));
  t.after(async()=>{await remote.close();await local.stop();await fs.rm(dir,{recursive:true,force:true});});
  await local.start();await local.getState();
  const owner=await readClaim(config.attachmentDir,saved);
  assert.equal(owner.kind,'extension');assert.equal(owner.mode,'rpc');assert.equal(owner.phase,'ready');
  await connect();
  const call=async(name,args)=>remote.callTool({name,arguments:args});
  const ok=async(name,args)=>{const response=await call(name,args);assert.ok(!response.isError,JSON.stringify(response));return response.structuredContent;};
  const status=()=>ok('read',{session_id:made.session_id,view:'status'});
  assert.equal((await remote.listTools()).tools.length,8);
  const unsupportedBash=await ok('bash',{session_id:made.session_id,request_id:'companion-bash-gap',command:'MUST_NOT_EXECUTE'});
  assert.equal(unsupportedBash.reason,'BASH_UNSUPPORTED');assert.equal(unsupportedBash.status,'rejected');
  const unsupportedStop=await ok('stop',{session_id:made.session_id,request_id:'companion-stop-gap'});
  assert.equal(unsupportedStop.status,'rejected');assert.equal(unsupportedStop.reason,'STOP_UNSUPPORTED');
  assert.equal(unsupportedStop.withdrawn_available,false);await local.getState();
  const initial=await status();
  assert.equal(initial.generation,owner.generation);assert.equal(initial.activity.settlement.sequence,0);
  const batchStatus=await ok('batch',{operations:[{op:'read',args:{session_id:made.session_id,view:'status'}}]});
  assert.equal(batchStatus.results[0].result.view,'status');assert.ok(!('applied_max_chars' in batchStatus.results[0]));
  const baseline={generation:initial.generation,sequence:initial.activity.settlement.sequence};
  const input={session_id:made.session_id,request_id:'remote-once',text:'REMOTE_ORDINARY_RPC'};
  const submitted=await ok('send',input);
  assert.equal(submitted.status,'unknown');assert.equal(submitted.dispatch,'submitted');
  assert.deepEqual(await ok('send',{session_id:made.session_id,request_id:'remote-once'}),submitted);
  const settled=await ok('read',{session_id:made.session_id,view:'status',after_settlement:baseline,wait_ms:1000});
  assert.equal(settled.wait.status,'settled');assert.equal(settled.activity.settlement.aborted,false);
  let entries=(await local.getEntries()).entries;
  assert.equal(entries.filter(entry=>text(entry)==='REMOTE_ORDINARY_RPC').length,1);
  assert.ok((await ok('read',{session_id:made.session_id})).items.some(item=>item.message?.role==='assistant'));
  const system=entries.find(entry=>entry.message?.role==='system'&&Object.values(entry.message.sections??{}).some(value=>typeof value==='string'&&value.length));
  assert.ok(system,'native RPC persists typed system sections');
  const section=Object.keys(system.message.sections).find(key=>typeof system.message.sections[key]==='string'&&system.message.sections[key].length);
  const systemSelector={session_id:made.session_id,entry_id:system.id,message_index:0,field:'sections',section,max_chars:256};
  let cursor,systemText='';
  do{
    const selected=await ok('read',{...systemSelector,cursor});assert.equal(selected.items[0].field,'sections');assert.equal(selected.items[0].section,section);
    assert.ok(JSON.stringify(selected.items[0]).length<=256);systemText+=selected.items[0].text;cursor=selected.next_cursor;
  }while(cursor);
  assert.equal(systemText,system.message.sections[section]);
  const reply=entries.find(entry=>entry.message?.role==='assistant'),block=reply.message.content.findIndex(part=>part.type==='text');
  const selector={session_id:made.session_id,entry_id:reply.id,message_index:0,block_index:block,max_chars:256};
  const decoded=await ok('read',selector);assert.equal(decoded.format,'projected_text');assert.equal(decoded.items[0].text,reply.message.content[block].text);
  const missingBlock=await call('read',{...selector,block_index:99});assert.equal(missingBlock.isError,true);assert.equal(missingBlock.content[0].text,'TEXT_BLOCK_NOT_FOUND');
  assert.equal(await local.prompt('LOCAL_ORDINARY_RPC'),'started');
  await until(async()=>{const value=await status();return value.activity.settlement.sequence===2&&value.activity.idle;});
  entries=(await local.getEntries()).entries;
  assert.equal(entries.filter(entry=>text(entry)==='LOCAL_ORDINARY_RPC').length,1);

  const deleted=await ok('delete',{session_id:made.session_id,request_id:'unsupported-live-delete'});
  assert.equal(deleted.status,'rejected');assert.equal(deleted.reason,'HOST_RELEASE_UNSUPPORTED');
  assert.ok(await fs.stat(saved.file));assert.equal(await ownerAlive(owner.owner),true);
  await assert.rejects(new AttachedRuntime(config,saved,owner).request('shutdown'),/HOST_RELEASE_UNSUPPORTED/);
  await local.getState(); // Proves no deferred shutdown flag was set by either request.
  assert.equal((await status()).generation,owner.generation);
  await remote.close();await local.getState();assert.equal(await ownerAlive(owner.owner),true);
  remote=new Client({name:'companion-review-restart',version:'1'});await connect();
  assert.deepEqual(await ok('send',{session_id:made.session_id,request_id:'remote-once'}),submitted);

  // Same native file, fresh extension generation after public session replacement.
  await local.switchSession(saved.file);await local.getState();
  const replacement=await until(async()=>{const claim=await readClaim(config.attachmentDir,saved);return claim?.phase==='ready'&&claim.generation!==owner.generation?claim:null;});
  const changed=await ok('read',{session_id:made.session_id,view:'status',after_settlement:baseline,wait_ms:1000});
  assert.equal(changed.wait.status,'generation_changed');assert.equal(changed.activity.settlement.sequence,0);
  assert.equal(replacement.owner.pid,owner.owner.pid);
  assert.equal((await local.getEntries()).entries.filter(entry=>text(entry)==='REMOTE_ORDINARY_RPC').length,1);

  // Read/send permissions remain separate and project/folder inherited.
  config.grants.push({session_id:made.session_id,read:false,send:true});await fs.writeFile(configFile,JSON.stringify(config));
  assert.equal((await call('read',{session_id:made.session_id,view:'status'})).isError,true);
  const sendOnly=await ok('send',{session_id:made.session_id,request_id:'send-only',text:'SEND_ONLY_NO_TRANSCRIPT'});
  assert.equal(sendOnly.dispatch,'submitted');assert.ok(!JSON.stringify(sendOnly).includes('SEND_ONLY_NO_TRANSCRIPT'));
  await until(async()=>!(await local.getState()).isStreaming);
  config.grants.push({folder:cwd,send:false});await fs.writeFile(configFile,JSON.stringify(config));
  // Explicit session send wins over project denial; inherit it to test project rule.
  config.grants.push({session_id:made.session_id,send:null});await fs.writeFile(configFile,JSON.stringify(config));
  assert.equal((await ok('send',{session_id:made.session_id,request_id:'project-denied',text:'MUST_NOT_ENTER'})).reason,'NOT_FOUND_OR_DENIED');
  assert.ok(!(await local.getEntries()).entries.some(entry=>text(entry)==='MUST_NOT_ENTER'));
  config.grants.push({session_id:made.session_id,read:true,send:true});await fs.writeFile(configFile,JSON.stringify(config));

  // A missing live endpoint blocks reads/sends instead of spawning fallback.
  await fs.rename(replacement.socket,replacement.socket+'.paused');
  try{
    assert.equal((await call('read',{session_id:made.session_id})).isError,true);
    const rejected=await ok('send',{session_id:made.session_id,request_id:'unreachable',text:'NO_FALLBACK_WRITER'});
    assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'LIVE_OWNER_UNREACHABLE');
    assert.equal((await readClaim(config.attachmentDir,saved)).generation,replacement.generation);
    assert.equal(await ownerAlive(replacement.owner),true);await local.getState();
    assert.ok(!(await local.getEntries()).entries.some(entry=>text(entry)==='NO_FALLBACK_WRITER'));
  }finally{await fs.rename(replacement.socket+'.paused',replacement.socket);}
  assert.equal((await status()).generation,replacement.generation);
  t.diagnostic('ordinary local RPC + remote MCP: one native session/owner, public settlement, no host shutdown, no fallback writer');
});
