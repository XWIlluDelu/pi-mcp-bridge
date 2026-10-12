import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';
import { operationSchemas, batchSchema, stopSchema } from './tool-schemas.mjs';
import { executeBatch } from './batch.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
export function makeServer(bridge, {execute = run => run()} = {}) {
  const server = new McpServer({name:'pi-session-bridge',version:'0.1.0'});
  const register = (name,description,inputSchema,method) => server.registerTool(name,{description,inputSchema},async (args,extra)=>execute(async()=>{
    try { const result = await diagnostics.measure('tool',{op:name,mcp_id_ref:diagnosticRef(extra.requestId),mutation_ref:diagnosticRef(args.request_id),session_ref:diagnosticRef(args.session_id)},()=>typeof method==='function'?method(args,{signal:extra.signal}):bridge[method](args,{signal:extra.signal})); return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}; }
    catch(e) { return {isError:true,content:[{type:'text',text:publicError(e)}]}; }
  }));
  register('list','Discover configured Pi sessions. Without read permission only an opaque ID is returned. Searches exclude unreadable sessions. Folder IDs are available only where new_session is allowed.',{query:z.string().max(200).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()},'list');
  register('read','Bounded Pi context projection (default), raw tree, existing summaries, or deterministic overview of current turns/checkpoint/tool observations. Overview is extractive and marks omissions; no model call or running-state inference. Not a final provider payload. Continue next_cursor with identical view/filter arguments; restart on STALE_CURSOR. Oversized records return expandable JSON fragments. In context, entry_id + message_index selects decoded content text; arrays require block_index of a text block. field:sections + section selects one named string-valued SystemMessage section instead; no metadata flattening or system-update replay. Old owners ignoring selectors return OWNER_READ_REFRESH_REQUIRED; ordinary reads stay usable. text_offset and projected_text cursors count UTF-16 code units, not JSON excerpt offsets. Nontext or hidden content is not expanded. since is a raw entry ID. status returns lightweight runtime/settlement observation without transcript reads; after_settlement {generation,sequence} with wait_ms (0..10000) waits for a new session-wide event, not request completion.',operationSchemas.read,'read');
  register('send','Send to an attached, reusable or auto-resumed Pi instance. Attached dispatch returns unknown/submitted because Pi extension acceptance is unobservable. native follows Pi prompt semantics; idle_only skips if busy; steer and queue select Pi delivery behavior. Stable caller request_id is required. Repeat the same request ID without text to query its own non-content receipt; never resend under a new ID after unknown. Acceptance is not exclusive completion.',operationSchemas.send.shape,'send');
  register('stop','Stop current native agent/retry/compaction/branch-summary/bash execution and withdraw all native queued prompts, keeping the Pi process/session alive. Requires independent command AND read permissions because the result returns withdrawn text. Never cold-starts, exits or releases ownership. Full native queue order/text is privately retained; withdrawn_text is native-ordered joined text with decoded UTF-16 pagination; pages use revision-bound cursors, continue with the same request_id, and may adjust max_chars. Replays/cursors never stop a later run. native_ack/requested is not task completion; unknown must not be retried under a new ID. A host lacking public cancellation/queue APIs returns STOP_UNSUPPORTED. Not in batch.',stopSchema.shape,'stop');
  register('create','Create and durably persist an empty Pi session in an authorized project folder. Does not send a prompt or grant send/read permission. Repeat request_id to recover the result.',operationSchemas.create.shape,'create');
  register('delete','Recoverably move a session to bridge trash after stopping its owned live instance. Project files are not deleted. Owner restores manually. Repeat request_id to recover the result.',operationSchemas.delete.shape,'delete');
  register('batch','Run 1–10 ordered read/send/create/delete actions. Invalid/conflicting input rejects the entire list before execution. Each item uses its normal permissions and mutation request ID. Runtime failures do not roll back or stop later items. Send then read does not wait for model completion. Reads share a bounded response budget and retain normal cursors.',batchSchema.shape,(args,options)=>executeBatch(bridge,args,options));
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
  let server, initializing, closing, exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode,code);
    if (closing) return closing;
    diagnostics.emit('service.stopping',{transport:'stdio'});
    process.stdin.pause();
    bridge.closing = true;
    // Init may still acquire its lock after a stop arrives. Wait for it to settle
    // before cleanup; never let init create resources after close has finished.
    closing = (async () => {
      await initializing?.catch(()=>{});
      try { await bridge.close(); }
      catch { exitCode = 1; console.error('SHUTDOWN_FAILED'); }
      try { await server?.close(); }
      catch { exitCode = 1; }
      process.exit(exitCode);
    })();
    return closing;
  };
  process.on('SIGINT',()=>{ void close(); });
  process.on('SIGTERM',()=>{ void close(); });
  process.stdin.on('end',()=>{ void close(); });
  process.stdin.on('close',()=>{ void close(); });
  process.stdin.on('error',()=>{ void close(1); });
  process.stdout.on('error',()=>{ void close(1); });
  process.stdout.on('close',()=>{ void close(1); });
  try {
    initializing = bridge.init();
    await initializing;
    if (closing) return closing;
    server = makeServer(bridge);
    server.server.onclose = () => { void close(); };
    await server.connect(new StdioServerTransport());
    diagnostics.emit('service.ready',{transport:'stdio'});
  } catch (error) {
    console.error(publicError(error));
    await close(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(publicError(e));process.exitCode=1;});
