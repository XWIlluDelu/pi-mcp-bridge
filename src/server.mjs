import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';
import { operationSchemas, batchSchema } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
export function makeServer(bridge) {
  const server = new McpServer({name:'pi-session-bridge',version:'0.1.0'});
  const register = (name,description,inputSchema,method) => server.registerTool(name,{description,inputSchema},async args=>{
    try { const result = typeof method==='function'?await method(args):await bridge[method](args); return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}; }
    catch(e) { return {isError:true,content:[{type:'text',text:publicError(e)}]}; }
  });
  register('list','Discover configured Pi sessions. Without read permission only an opaque ID is returned. Searches exclude unreadable sessions. Folder IDs are available only where new_session is allowed.',{query:z.string().max(200).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()},'list');
  register('read','Bounded Pi context projection, raw tree entries, or existing summaries. Not a final provider payload. Continue next_cursor with identical view/filter arguments; restart on STALE_CURSOR. Oversized records return expandable JSON fragments. since is a raw entry ID.',operationSchemas.read.shape,'read');
  register('send','Send to an attached, reusable or auto-resumed Pi instance. Attached dispatch returns unknown/submitted because Pi extension acceptance is unobservable. native follows Pi prompt semantics; idle_only skips if busy; steer and queue select Pi delivery behavior. Stable caller request_id is required. Repeat the same request ID without text to query its own non-content receipt; never resend under a new ID after unknown. Acceptance is not exclusive completion.',operationSchemas.send.shape,'send');
  register('create','Create and durably persist an empty Pi session in an authorized project folder. Does not send a prompt or grant send/read permission. Repeat request_id to recover the result.',operationSchemas.create.shape,'create');
  register('delete','Recoverably move a session to bridge trash after stopping its owned live instance. Project files are not deleted. Owner restores manually. Repeat request_id to recover the result.',operationSchemas.delete.shape,'delete');
  register('batch','Run 1–10 ordered read/send/create/delete actions. Invalid/conflicting input rejects the entire list before execution. Each item uses its normal permissions and mutation request ID. Runtime failures do not roll back or stop later items. Send then read does not wait for model completion. Reads share a bounded response budget and retain normal cursors.',batchSchema.shape,args=>executeBatch(bridge,args));
  return server;
}
function publicError(e) {
  return /^[A-Z][A-Z_]{2,60}$/.test(e.message) ? e.message : 'OPERATION_FAILED';
}
async function main() {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('Usage: node src/server.mjs /absolute/path/to/owner-config.json');
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  const bridge = new Bridge(config,undefined,{configFile:path.resolve(configFile)});
  let server, closing, exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode,code);
    if (closing) return closing;
    process.stdin.pause();
    // close() stops bridge admission synchronously, drains receipts and stops only
    // owned RPC children. Keep signal/error handlers installed until it finishes.
    closing = (async () => {
      try { await bridge.close(); }
      catch { exitCode = 1; console.error('SHUTDOWN_FAILED'); }
      try { await server?.close(); }
      catch { exitCode = 1; }
      process.exit(exitCode);
    })();
    return closing;
  };
  try {
    await bridge.init();
    server = makeServer(bridge);
    server.server.onclose = () => { void close(); };
    process.on('SIGINT',()=>{ void close(); });
    process.on('SIGTERM',()=>{ void close(); });
    process.stdin.on('end',()=>{ void close(); });
    process.stdin.on('close',()=>{ void close(); });
    process.stdin.on('error',()=>{ void close(1); });
    process.stdout.on('error',()=>{ void close(1); });
    process.stdout.on('close',()=>{ void close(1); });
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(publicError(error));
    await close(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(publicError(e));process.exitCode=1;});
