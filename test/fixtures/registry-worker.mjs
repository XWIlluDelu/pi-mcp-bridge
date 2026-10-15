// A cooperative writer, or the previous wx protocol, controlled over test IPC.
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {registryTransaction,processIdentity} from '../../src/attachments.mjs';
const dir=process.argv[2],request=once(process,'message');
process.send({type:'ready'});
const [{mode}]=await request;
const action=async()=>{
  const owner=await processIdentity(),release=once(process,'message');
  const marker=path.join(dir,'critical');
  // The marker is only a test assertion, never a recovery lock.
  await fs.writeFile(marker,String(process.pid),{flag:'wx'});
  try{process.send({type:'entered',owner});await release;}
  finally{await fs.unlink(marker);}
};
try{
  if(mode==='legacy'){
    const lock=path.join(dir,'registry.lock'),handle=await fs.open(lock,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(await processIdentity()));await action();}
    finally{await handle.close();await fs.unlink(lock);}
  }else await registryTransaction(dir,action);
  process.send({type:'done'});
}catch(error){process.send({type:'done',error:error.code??error.message});}
process.disconnect();
