import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';
export function makeServer(bridge) {
  const server = new McpServer({name:'pi-session-bridge',version:'0.1.0'});
  const id = z.string().min(1).max(128);
  const request = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
  const register = (name,description,inputSchema,method) => server.registerTool(name,{description,inputSchema},async args=>{
    try { const result = await bridge[method](args); return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}; }
    catch(e) { return {isError:true,content:[{type:'text',text:publicError(e)}]}; }
  });
  register('list','Discover configured Pi sessions. Without read permission only an opaque ID is returned. Searches exclude unreadable sessions. Folder IDs are available only where new_session is allowed.',{query:z.string().max(200).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()},'list');
  register('read','Bounded Pi context projection, raw tree entries, or existing summaries. Not a final provider payload. Continue next_cursor with identical view/filter arguments; restart on STALE_CURSOR. Oversized records return expandable JSON fragments. since is a raw entry ID.',{session_id:id,view:z.enum(['context','raw','summary']).optional(),entry_id:id.optional(),leaf_id:z.string().nullable().optional(),since:id.optional(),query:z.string().max(200).optional(),cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(50).optional(),max_chars:z.number().int().min(256).max(32768).optional()},'read');
  register('send','Send to an attached, reusable or auto-resumed Pi instance. Attached dispatch returns unknown/submitted because Pi extension acceptance is unobservable. native follows Pi prompt semantics; idle_only skips if busy; steer and queue select Pi delivery behavior. Stable caller request_id is required. Repeat the same request ID without text to query its own non-content receipt; never resend under a new ID after unknown. Acceptance is not exclusive completion.',{session_id:id,request_id:request,text:z.string().min(1).max(100000).optional(),mode:z.enum(['native','idle_only','steer','queue']).optional(),timeout_ms:z.number().int().min(50).max(30000).optional()},'send');
  register('create','Create and durably persist an empty Pi session in an authorized project folder. Does not send a prompt or grant send/read permission. Repeat request_id to recover the result.',{folder_id:id,request_id:request},'create');
  register('delete','Recoverably move a session to bridge trash after stopping its owned live instance. Project files are not deleted. Owner restores manually. Repeat request_id to recover the result.',{session_id:id,request_id:request},'delete');
  return server;
}
function publicError(e) {
  return /^[A-Z][A-Z_]{2,60}$/.test(e.message) ? e.message : 'OPERATION_FAILED';
}
async function main() {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('Usage: node src/server.mjs /absolute/path/to/owner-config.json');
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  const bridge = await new Bridge(config,undefined,{configFile:path.resolve(configFile)}).init();
  const server = makeServer(bridge);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await bridge.close(); await server.close(); };
  server.server.onclose = () => { void close(); };
  process.once('SIGINT',()=>{ void close().then(()=>process.exit(0)); });
  process.once('SIGTERM',()=>{ void close().then(()=>process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(publicError(e));process.exitCode=1;});
