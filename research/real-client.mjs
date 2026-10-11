// Opt-in real-provider smoke test. Only public fixed prompts and generated fixtures.
// Credentials remain environment references; never write them to config or output.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { realTestSettings } from './real-config.mjs';

const {baseUrl,model,thinkingFormat}=realTestSettings(process.env);
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-mcp-real-'));
const cwd=path.join(root,'public-fixture'),agentDir=path.join(root,'agent');
await fs.mkdir(cwd);await fs.mkdir(agentDir);
await fs.writeFile(path.join(cwd,'keep.txt'),'public fixture');
await fs.writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{'test-gateway':{baseUrl,api:'openai-completions',apiKey:'${OPENAI_API_KEY}',models:[{id:model,reasoning:Boolean(thinkingFormat),...(thinkingFormat?{compat:{thinkingFormat}}:{}),input:['text'],contextWindow:64000,maxTokens:process.env.PI_REAL_REVIEW==='1'?4096:1024}]}}}));
await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({retry:{enabled:false},cacheWarming:'off',compaction:{enabled:false}}));
const inheritEnv=['OPENAI_API_KEY','HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','NODE_USE_ENV_PROXY'];
const config={principal:'real-fixture',stateDir:path.join(root,'state'),sessionRoots:[path.join(root,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],piRuntime:{agentDir,inheritEnv},piArgs:['--provider','test-gateway','--model',model,'--thinking','off']};
const configFile=path.join(root,'owner-config.json');await fs.writeFile(configFile,JSON.stringify(config));
const env=Object.fromEntries(['PATH',...inheritEnv].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));env.NODE_USE_ENV_PROXY='1';
let client;
async function connect(){
 client=new Client({name:'real-integration',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),configFile],cwd:base,env,stderr:'pipe'}));
}
async function call(name,args){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,`MCP ${name} failed`);return result.structuredContent;}
const evidence={provider:model,real:true};
async function waitFor(session_id,marker){
 const deadline=Date.now()+90000;
 while(Date.now()<deadline){
  const read=await call('read',{session_id,view:'context',query:'"role":"assistant"',limit:50,max_chars:32768});
  const assistants=read.items.filter(x=>x.message?.role==='assistant');
  assert.equal(assistants.some(x=>x.message.stopReason==='error'),false,'Provider returned an error');
  if(assistants.some(x=>marker===null || JSON.stringify(x.message.content).includes(marker)))return read;
  await new Promise(r=>setTimeout(r,250));
 }
 throw new Error('Real response deadline exceeded');
}
async function readAll(session_id,view){
 const items=[];let cursor,fragment='';let pages=0,fragments=0;
 do{
  const result=await call('read',{session_id,view,limit:50,max_chars:1024,...(cursor?{cursor}:{})});pages++;
  for(const item of result.items){
   if(item.json_fragment!==undefined){
    assert.equal(item.char_offset,fragment.length);fragment+=item.json_fragment;fragments++;
    if(fragment.length===item.total_chars){items.push(JSON.parse(fragment));fragment='';}
   }else items.push(item);
  }
  cursor=result.next_cursor;
 }while(cursor);
 assert.equal(fragment,'');return {items,pages,fragments};
}
try{
 await connect();
 if(process.env.PI_REAL_REVIEW_ONLY!=='1'){
 const made=await call('create',{folder_id:'project',request_id:'create'});assert.equal(made.status,'created');const session_id=made.session_id;
 assert.equal((await call('read',{session_id})).items.length,0);evidence.create_empty=true;
 const first=await call('send',{session_id,request_id:'first',mode:'native',text:'For a public test fixture, explain addition in 200 words. Finish with MCP_FIRST_OK.'});assert.equal(first.disposition,'started');evidence.native_idle='started';
 const skipped=await call('send',{session_id,request_id:'skip',mode:'idle_only',text:'SKIPPED_FIXTURE'});assert.equal(skipped.status,'skipped');evidence.idle_only_busy='skipped';
 const busy=await call('send',{session_id,request_id:'busy',mode:'native',text:'REJECTED_FIXTURE'});assert.equal(busy.status,'rejected');evidence.native_busy='rejected';
 const steer=await call('send',{session_id,request_id:'steer',mode:'steer',text:'Reply briefly with MCP_STEER_OK.'});assert.equal(steer.disposition,'queued');evidence.steer_busy='queued';
 const queued=await call('send',{session_id,request_id:'queue',mode:'queue',text:'Reply exactly MCP_QUEUE_OK.'});assert.equal(queued.disposition,'queued');evidence.queue_busy='queued';
 assert.deepEqual(await call('send',{session_id,request_id:'first'}),first);evidence.receipt_replay=true;
 await waitFor(session_id,'MCP_STEER_OK');evidence.steer_assistant_marker=true;
 await waitFor(session_id,'MCP_QUEUE_OK');evidence.context_responses=true;
 for(const mode of ['steer','queue']){
  const marker=`MCP_IDLE_${mode.toUpperCase()}_OK`;
  const result=await call('send',{session_id,request_id:`idle-${mode}`,mode,text:`Reply exactly ${marker}.`});
  assert.equal(result.disposition,'started');await waitFor(session_id,marker);evidence[`${mode}_idle`]='started_with_assistant_marker';
 }
 const raw=await call('read',{session_id,view:'raw',limit:50,max_chars:32768});assert.ok(raw.items.some(x=>x.entry?.type==='message'));assert.ok(!JSON.stringify(raw).includes('SKIPPED_FIXTURE'));assert.ok(!JSON.stringify(raw).includes('REJECTED_FIXTURE'));evidence.raw_read=true;
 await client.close();await connect();
 assert.deepEqual(await call('send',{session_id,request_id:'first'}),first);
 const resumed=await call('send',{session_id,request_id:'resume',mode:'idle_only',text:'Reply exactly MCP_RESUME_OK.'});assert.equal(resumed.disposition,'started');await waitFor(session_id,'MCP_RESUME_OK');evidence.saved_resume=true;
 const deleted=await call('delete',{session_id,request_id:'delete'});assert.equal(deleted.status,'deleted');assert.deepEqual(await call('delete',{session_id,request_id:'delete'}),deleted);assert.equal((await call('list',{})).sessions.length,0);assert.equal(await fs.readFile(path.join(cwd,'keep.txt'),'utf8'),'public fixture');evidence.delete_preserves_project=true;
 }
 if(process.env.PI_REAL_REVIEW==='1'){
  const reviewedCommit='b24070d';
  const files=['src/bridge.mjs','src/rpc.mjs'];
  const publicSource=files.map(file=>`FILE ${file}\n${execFileSync('git',['show',`${reviewedCommit}:${file}`],{cwd:base,encoding:'utf8'})}`).join('\n');
  const prompt=`Review the following public Pi MCP bridge source at ${reviewedCommit}. Focus only on session read/write correctness and runtime/session identity boundaries. Owner configuration, extensions, and enabled Pi tools are trusted; the bridge is explicitly not an OS sandbox, uses exclusively owned storage, and does not attach existing TUIs. Give at most two actionable findings with severity, file/function, concrete trigger, and minimal fix. Distinguish code-proven defects from hypotheses requiring Pi behavior evidence. Do not claim to have run tests. Stay under 400 words.\n\n${publicSource}`;
  const madeReview=await call('create',{folder_id:'project',request_id:'review-create'});
  const reviewId=madeReview.session_id;
  const sent=await call('send',{session_id:reviewId,request_id:'review',mode:'native',text:prompt});assert.equal(sent.disposition,'started');
  evidence.public_review_started=true;
  const completed=await waitFor(reviewId,null);
  const answer=completed.items.find(x=>x.message?.role==='assistant').message;
  const text=answer.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  await fs.writeFile(path.join(base,'research/DEEPSEEK_REVIEW.txt'),`UNTRUSTED MODEL REVIEW — validate all suggestions independently\nModel: ${model}\nReviewed commit: ${reviewedCommit}\nInput: public source only (${files.join(', ')}); no tools, private owner context, environment values, or generated config supplied.\nNo claim of independent test execution by reviewer.\nStop reason: ${answer.stopReason}\n\n${text}\n`);
  assert.notEqual(answer.stopReason,'length');assert.ok(text.trim());
  const current=await readAll(reviewId,'context'),rawReview=await readAll(reviewId,'raw');
  assert.ok(current.pages>1&&rawReview.pages>1&&current.fragments>0&&rawReview.fragments>0);
  const userText=message=>typeof message.content==='string'?message.content:message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  assert.equal(userText(current.items.find(x=>x.message?.role==='user').message),prompt);
  assert.equal(userText(rawReview.items.find(x=>x.entry?.message?.role==='user').entry.message),prompt);
  evidence.public_review={reviewedCommit,contextPages:current.pages,rawPages:rawReview.pages,contextFragments:current.fragments,rawFragments:rawReview.fragments,exactUserPromptRoundTrip:true,assistantResponse:true};
  assert.equal((await call('delete',{session_id:reviewId,request_id:'review-delete'})).status,'deleted');
 }
 console.log(JSON.stringify(evidence));
}catch(error){console.log(JSON.stringify({...evidence,failed:true,errorType:error.name}));process.exitCode=1;}
finally{await client?.close();await fs.rm(root,{recursive:true,force:true});}
