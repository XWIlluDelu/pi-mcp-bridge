import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { readClaim,ownerAlive,waitOwnerExit } from '../src/attachments.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function until(fn,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('Lifecycle fixture deadline');}
const exists=file=>fs.stat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-life-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const marker=path.join(dir,'dispatch'),extension=path.join(dir,'command.mjs');
 // Official RPC command dispatch exercises an in-flight receipt without a model call.
 await fs.writeFile(extension,`import fs from 'node:fs/promises'; export default function(pi){pi.registerCommand('lifecycle-fixture',{handler:async()=>{await fs.writeFile(${JSON.stringify(marker)},'started');await new Promise(r=>setTimeout(r,300));}});}`);
 const config={principal:'lifecycle-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,new_session:true}],attachmentDir:path.join(dir,'ipc'),piArgs:['-e',extension]};
 const bridge=await new Bridge(config).init();const made=await bridge.create({folder_id:'project',request_id:'seed'});const session=await bridge.session(made.session_id);await bridge.close();
 const configFile=path.join(dir,'owner.json');await fs.writeFile(configFile,JSON.stringify(config));
 t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
 return {dir,cwd,config,configFile,session,id:made.session_id,marker,lock:path.join(config.stateDir,'bridge.lock')};
}
function launch(t,f){
 const child=spawn(process.execPath,[path.join(base,'src/server.mjs'),f.configFile],{cwd:base,env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1'},stdio:['pipe','pipe','pipe']});
 let stderr='',next=0;const pending=new Map();child.stderr.on('data',b=>{stderr+=b;});child.stdin.on('error',()=>{});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);const resolve=pending.get(value.id);if(resolve){pending.delete(value.id);resolve(value);}});
 const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;lines.close();});
 const write=value=>child.stdin.write(JSON.stringify(value)+'\n');
 const request=(method,params)=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);write({jsonrpc:'2.0',id,method,params});});
 const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP fixture timeout')),10000);timer.unref();})]);
 const call=async(name,args)=>{const result=(await bounded(request('tools/call',{name,arguments:args}))).result;assert.ok(result&&!result.isError);return result.structuredContent;};
 return {child,call,request,done,stderr:()=>stderr,initialize:async()=>{const r=await bounded(request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'lifecycle-fixture',version:'1'}}));assert.ok(r.result);write({jsonrpc:'2.0',method:'notifications/initialized'});},exit:async()=>{const result=await bounded(done);assert.equal(result.signal,null,stderr);return result.code;}};
}
async function stopped(f,owner){assert.equal(await exists(f.lock),false);if(owner)assert.equal(await ownerAlive(owner),false);assert.equal(await readClaim(f.config.attachmentDir,f.session),null);}
async function ownClaim(f){return until(async()=>{const r=await readClaim(f.config.attachmentDir,f.session);return r?.phase==='ready'?r:null;});}

test('stdin EOF without a runtime releases its lock and permits normal restart',async t=>{
 const f=await fixture(t),first=launch(t,f);await first.initialize();first.child.stdin.end();assert.equal(await first.exit(),0);await stopped(f);
 const second=launch(t,f);await second.initialize();second.child.kill('SIGTERM');assert.equal(await second.exit(),0);await stopped(f);
});
test('stdin EOF drains an in-flight official RPC receipt, stops its child and preserves replay',async t=>{
 const f=await fixture(t),first=launch(t,f);await first.initialize();
 const pending=first.call('send',{session_id:f.id,request_id:'in-flight',text:'/lifecycle-fixture'});
 await until(()=>exists(f.marker));const claim=await ownClaim(f);first.child.stdin.end();
 const receipt=await pending;assert.equal(receipt.status,'accepted');assert.equal(receipt.disposition,'handled');
 assert.equal(await first.exit(),0);await stopped(f,claim.owner);
 const second=launch(t,f);await second.initialize();assert.deepEqual(await second.call('send',{session_id:f.id,request_id:'in-flight'}),receipt);assert.equal(await readClaim(f.config.attachmentDir,f.session),null);
 second.child.kill('SIGINT');assert.equal(await second.exit(),0);await stopped(f);
});
test('broken stdout drains a pending receipt and cleans up the owned official RPC process',async t=>{
 const f=await fixture(t),server=launch(t,f);await server.initialize();server.request('tools/call',{name:'send',arguments:{session_id:f.id,request_id:'owned',text:'/lifecycle-fixture'}});await until(()=>exists(f.marker));
 const claim=await ownClaim(f);server.child.stdout.destroy();server.request('tools/list',{});
 assert.equal(await server.exit(),1);await stopped(f,claim.owner);assert.ok(!server.stderr().includes('Unhandled'));
 const bridge=await new Bridge(f.config).init();try{const receipt=await bridge.send({session_id:f.id,request_id:'owned'});assert.equal(receipt.status,'accepted');assert.equal(receipt.disposition,'handled');assert.equal(bridge.pool.instances.size,0);}finally{await bridge.close();}
});
test('repeated stop signals share draining cleanup rather than interrupting the owned RPC receipt',async t=>{
 const f=await fixture(t),server=launch(t,f);await server.initialize();const pending=server.call('send',{session_id:f.id,request_id:'signals',text:'/lifecycle-fixture'});
 await until(()=>exists(f.marker));const claim=await ownClaim(f);server.child.kill('SIGTERM');await new Promise(r=>setTimeout(r,30));server.child.kill('SIGINT');
 assert.equal((await pending).status,'accepted');assert.equal(await server.exit(),0);await stopped(f,claim.owner);
});
test('EOF disconnects an actual external Pi TUI without stopping it',async t=>{
 const f=await fixture(t),agentDir=path.join(f.dir,'agent');await fs.mkdir(agentDir);await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
 const args=[process.execPath,path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--session',f.session.file,'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','-e',path.join(base,'src/attach-extension.mjs')];
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const tui=spawn('script',['-qefc',args.map(quote).join(' '),'/dev/null'],{cwd:f.cwd,env:{PATH:process.env.PATH,HOME:f.dir,PI_CODING_AGENT_DIR:agentDir,PI_MCP_ATTACH_DIR:f.config.attachmentDir,PI_OFFLINE:'1',TERM:'xterm-256color'},stdio:['pipe','pipe','pipe']});tui.stdout.resume();tui.stderr.resume();
 let claim;t.after(async()=>{if(claim&&await ownerAlive(claim.owner)){process.kill(claim.owner.pid,'SIGTERM');await waitOwnerExit(claim.owner);}tui.stdin.destroy();if(tui.exitCode===null)tui.kill('SIGTERM');});
 claim=await ownClaim(f);assert.equal(claim.kind,'tui');const server=launch(t,f);await server.initialize();await server.call('read',{session_id:f.id});
 server.child.stdin.end();assert.equal(await server.exit(),0);assert.equal(await exists(f.lock),false);assert.equal(await ownerAlive(claim.owner),true);assert.equal((await readClaim(f.config.attachmentDir,f.session)).generation,claim.generation);
});
test('an existing crash lock is neither removed nor bypassed on startup failure',async t=>{
 const f=await fixture(t);await fs.writeFile(f.lock,'retained-crash-fixture\n');const server=launch(t,f);
 assert.equal(await server.exit(),1);assert.equal(await fs.readFile(f.lock,'utf8'),'retained-crash-fixture\n');assert.equal(await readClaim(f.config.attachmentDir,f.session),null);
});
