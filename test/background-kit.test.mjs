import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkOwner } from '../deploy/check-owner.mjs';
const exec=promisify(execFile),base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-service-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={...isolatedRuntime(dir),principal:'offline-service-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,new_session:true}]},file=path.join(dir,'owner.json');
 await fs.writeFile(file,JSON.stringify(config),{mode:0o600});return {dir,config,file};
}
test('service preflight is read-only and refuses unsafe config or existing locks without repairing them',async t=>{
 const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 assert.deepEqual(await checkOwner(f.file),{owner_config_checked:true,network_checked:false,client_checked:false,model_checked:false});
 assert.deepEqual((await fs.readdir(f.dir)).sort(),['owner.json','project']);
 await fs.chmod(f.file,0o644);await assert.rejects(checkOwner(f.file),/OWNER_CONFIG_NOT_PRIVATE/);await fs.chmod(f.file,0o600);
 await fs.mkdir(f.config.stateDir,{mode:0o700});const lock=path.join(f.config.stateDir,'bridge.lock');await fs.writeFile(lock,'public stale fixture');await assert.rejects(checkOwner(f.file),/BRIDGE_LOCK_REQUIRES_OWNER_CHECK/);assert.equal(await fs.readFile(lock,'utf8'),'public stale fixture');await fs.unlink(lock);
 f.config.attachmentDir=path.join(f.dir,'ipc');await fs.mkdir(f.config.attachmentDir,{mode:0o700});await fs.writeFile(f.file,JSON.stringify(f.config));const registry=path.join(f.config.attachmentDir,'registry.lock');await fs.writeFile(registry,'public fixture');await assert.rejects(checkOwner(f.file),/REGISTRY_LOCK_REQUIRES_OWNER_CHECK/);assert.equal(await fs.readFile(registry,'utf8'),'public fixture');
});
test('user-service template parses with systemd without installing or starting a service',async t=>{
 try{await exec('systemd-analyze',['--version']);}catch(e){if(e.code==='ENOENT'){t.skip('systemd-analyze unavailable');return;}throw e;}
 const f=await fixture();t.after(()=>fs.rm(f.dir,{recursive:true,force:true}));
 const run=path.join(f.dir,'run-client');await fs.writeFile(run,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const template=await fs.readFile(path.join(base,'deploy/pi-mcp-bridge.service'),'utf8');
 assert.ok(template.includes('StandardInput=null'));assert.ok(template.includes('KillMode=mixed'));assert.ok(!template.includes('PrivateTmp='));
 const rendered=template.replaceAll('%h/.local/share/pi-mcp-bridge',base).replaceAll('%h/.config/pi-mcp-bridge',f.dir).replaceAll('/usr/bin/node',process.execPath);
 const unit=path.join(f.dir,'pi-mcp-bridge.service');await fs.writeFile(unit,rendered);
 await exec('systemd-analyze',['verify',unit],{timeout:10000});
 const dropins=unit+'.d';await fs.mkdir(dropins);await fs.copyFile(path.join(base,'deploy/tunnel-restart.conf.example'),path.join(dropins,'tunnel-restart.conf'));
 await exec('systemd-analyze',['verify',unit],{timeout:10000});
});
test('bounded detached MCP client survives launcher exit and reloads owner grants without a TUI',async()=>{
 const f=await fixture();let pid;
 const ready=path.join(f.dir,'ready'),changed=path.join(f.dir,'changed'),stop=path.join(f.dir,'stop'),stopped=path.join(f.dir,'stopped');
 // writeFile can expose an empty/partial JSON marker before the writer finishes.
 async function wait(file,parse=value=>value){const end=Date.now()+10000;while(Date.now()<end){try{return parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}await new Promise(r=>setTimeout(r,30));}throw new Error('Detached fixture deadline');}
 const clientFile=path.join(f.dir,'client.mjs'),launcherFile=path.join(f.dir,'launcher.mjs');
 const sdk=path.join(base,'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
 await fs.writeFile(clientFile,`import fs from 'node:fs/promises';import {Client} from ${JSON.stringify(path.join(sdk,'index.js'))};import {StdioClientTransport} from ${JSON.stringify(path.join(sdk,'stdio.js'))};
 const client=new Client({name:'offline-detached-fixture',version:'1'});const dir=${JSON.stringify(f.dir)};
 const transport=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(path.join(base,'src/server.mjs'))},${JSON.stringify(f.file)}],env:{PATH:process.env.PATH,HOME:dir,PI_OFFLINE:'1'},stderr:'pipe'});
 try{await client.connect(transport);const first=await client.callTool({name:'list',arguments:{}});if(first.structuredContent.folders.length!==1)throw new Error('Fixture grant missing');await fs.writeFile(dir+'/ready',JSON.stringify({pid:process.pid,ppid:process.ppid}));
 const end=Date.now()+8000;while(Date.now()<end){if(await fs.stat(dir+'/stop').then(()=>true,()=>false))break;if(await fs.stat(dir+'/check').then(()=>true,()=>false)){const next=await client.callTool({name:'list',arguments:{}});await fs.writeFile(dir+'/changed',JSON.stringify({folders:next.structuredContent.folders.length}));}await new Promise(r=>setTimeout(r,50));}
 }finally{await client.close();await fs.writeFile(dir+'/stopped','closed');}
 `);
 await fs.writeFile(launcherFile,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(clientFile)}],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});child.unref();`);
 try{
  const launcher=spawn(process.execPath,[launcherFile],{stdio:'ignore',env:{PATH:process.env.PATH}});const launcherPid=launcher.pid;assert.equal(await new Promise(r=>launcher.once('exit',r)),0);
  const identity=await wait(ready,JSON.parse);pid=identity.pid;assert.notEqual(identity.ppid,launcherPid);process.kill(pid,0);
  f.config.grants[0].new_session=false;await fs.writeFile(f.file,JSON.stringify(f.config));await fs.writeFile(path.join(f.dir,'check'),'check');assert.equal((await wait(changed,JSON.parse)).folders,0);
  await fs.writeFile(stop,'stop');await wait(stopped);await assert.rejects(fs.stat(path.join(f.config.stateDir,'bridge.lock')),{code:'ENOENT'});
 }finally{
  await fs.writeFile(stop,'stop');if(pid)await wait(stopped).catch(()=>{try{process.kill(pid,'SIGTERM');}catch{}});await fs.rm(f.dir,{recursive:true,force:true});
 }
});
