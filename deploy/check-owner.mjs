// Read-only service preflight. Does not launch Pi, acquire/delete locks or connect.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOwnerConfig } from '../src/owner-config.mjs';
import { inside } from '../src/permissions.mjs';
import { launchProfile } from '../src/rpc.mjs';
const fail=code=>{throw new Error(code);};
async function statOrMissing(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function storage(dir){
 if(typeof dir!=='string'||!path.isAbsolute(dir))fail('INVALID_STORAGE_PATH');
 const stat=await statOrMissing(dir);if(!stat)return;
 if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir||stat.uid!==process.getuid()||(stat.mode&0o077))fail('STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY');
}
export async function checkOwner(file){
 const {config,mode}=await readOwnerConfig(file),stat=await fs.lstat(file);
 if(stat.uid!==process.getuid()||(mode&0o077))fail('OWNER_CONFIG_NOT_PRIVATE');
 if(typeof config.principal!=='string'||!config.principal.trim()||!Array.isArray(config.sessionRoots)||!config.sessionRoots.length||!Array.isArray(config.folders))fail('INVALID_OWNER_CONFIG');
 await storage(config.stateDir);for(const root of config.sessionRoots)await storage(root);
 const dirs=[config.stateDir,...config.sessionRoots];
 for(let i=0;i<dirs.length;i++)for(let j=i+1;j<dirs.length;j++)if(inside(dirs[i],dirs[j])||inside(dirs[j],dirs[i]))fail('OVERLAPPING_STORAGE');
 for(const folder of config.folders){if(typeof folder.path!=='string'||!path.isAbsolute(folder.path)||await fs.realpath(folder.path)!==folder.path||!(await fs.stat(folder.path)).isDirectory())fail('INVALID_PROJECT_FOLDER');}
 if(await statOrMissing(path.join(config.stateDir,'bridge.lock')))fail('BRIDGE_LOCK_REQUIRES_OWNER_CHECK');
 if(config.attachmentDir){await storage(config.attachmentDir);if(await statOrMissing(path.join(config.attachmentDir,'registry.lock')))fail('REGISTRY_LOCK_REQUIRES_OWNER_CHECK');}
 // Validate profile syntax against an empty environment; never inspect credentials.
 launchProfile(config,{});
 return {owner_config_checked:true,network_checked:false,client_checked:false,model_checked:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 checkOwner(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(/^[A-Z][A-Z_]+$/.test(e.message)?e.message:'PREFLIGHT_FAILED');process.exitCode=1;});
}
