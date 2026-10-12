import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client=new Client({name:'pi-bridge-demo-client',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs'),path.join(root,'demo/owner-config.json')],env:{PATH:process.env.PATH,HOME:path.join(root,'demo'),PI_OFFLINE:'1'},stderr:'inherit'});
const call=async(name,args)=>{
  const result=await client.callTool({name,arguments:args});
  if(result.isError)throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
};
try {
  await client.connect(transport);
  console.log('Tools:',(await client.listTools()).tools.map(t=>t.name).join(', '));
  const made=await call('create',{folder_id:'folder_a',request_id:randomUUID()});console.log('Create:',made);
  if(made.status!=='created')throw new Error('Create did not succeed');
  const session_id=made.session_id,request_id=randomUUID();
  console.log('Send:',await call('send',{session_id,request_id,text:'Return a synthetic response.',mode:'idle_only'}));
  console.log('Same receipt:',await call('send',{session_id,request_id}));
  const deadline=Date.now()+10000;let result;
  do {
    result=await call('read',{session_id,view:'context'});
    if(result.items.some(item=>item.message?.role==='assistant'))break;
    await new Promise(r=>setTimeout(r,100));
  }while(Date.now()<deadline);
  if(!result.items.some(item=>item.message?.role==='assistant'))throw new Error('No synthetic assistant reply observed');
  console.log('Observed context:',JSON.stringify(result,null,2));
  console.log('Recoverable delete:',await call('delete',{session_id,request_id:randomUUID()}));
} finally {await client.close();}
