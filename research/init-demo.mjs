import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo=path.join(root,'demo');
await fs.mkdir(path.join(demo,'project-a','child'),{recursive:true});
await fs.mkdir(path.join(demo,'project-b'),{recursive:true});
const config={
  principal:'local-demo-caller',
  stateDir:path.join(demo,'state'),
  sessionRoots:[path.join(demo,'sessions')],
  folders:[{id:'folder_a',path:path.join(demo,'project-a')},{id:'folder_a_child',path:path.join(demo,'project-a','child')},{id:'folder_b',path:path.join(demo,'project-b')}],
  grants:[
    {folder:path.join(demo,'project-a'),read:true,send:true,delete:true,new_session:true},
    {folder:path.join(demo,'project-a','child'),read:false,send:true},
    {folder:path.join(demo,'project-b'),read:false,send:false,delete:false,new_session:true},
  ],
  piArgs:['-e',path.join(root,'research/faux-extension.mjs'),'--provider','bridge-fixture','--model','deterministic'],
};
const destination=path.join(demo,'owner-config.json');
try { await fs.writeFile(destination,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600}); }
catch(e) { if (e.code!=='EEXIST') throw e; console.error('Existing owner config preserved.'); }
console.log(`node ${path.join(root,'src/server.mjs')} ${destination}`);
