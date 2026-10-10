import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RuntimePool } from '../src/rpc.mjs';

test('RPC pipe failure still requires confirmed process exit before stop returns',async()=>{
  const rpc=new PiRpc({},{});const child=new EventEmitter();let terminated=false,exited=false;
  child.kill=()=>{terminated=true;setImmediate(()=>{exited=true;child.emit('exit',0);});};
  rpc.child=child;rpc.alive=false;rpc.exited=false;
  await rpc.stop();assert.equal(terminated,true);assert.equal(exited,true);
});
test('pool terminates an unusable old runtime before replacement',async()=>{
  let stopped=false;
  const pool=new RuntimePool({},async()=>{assert.equal(stopped,true);return {alive:true,stop:async()=>{}};});
  pool.instances.set('s',{alive:false,stop:async()=>{await new Promise(r=>setImmediate(r));stopped=true;}});
  await pool.resolve({id:'s'});await pool.close();
});
