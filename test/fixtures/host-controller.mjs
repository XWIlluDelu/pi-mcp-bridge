import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { reserveHostSession } from '../../src/host-adapter.mjs';
import { processIdentity } from '../../src/attachments.mjs';
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
// A separate fixture writer waits until its exact identity has been reserved.
const writer = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
 import fs from 'node:fs';
 process.on('message',file=>{fs.openSync(file,'a');process.send('opened');});
 process.on('disconnect',()=>{});
 setInterval(()=>{},1000);
`,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true },
);
const owner = await processIdentity(writer.pid),
  host = await reserveHostSession({ ...config, owner });
const opened = new Promise((resolve) => writer.once('message', resolve));
writer.send(config.session.file);
await opened;
const identity = { sessionFile: config.session.file, sessionId: config.session.header.id };
await host.ready({
  state: async () => identity,
  snapshot: async () => ({ ...identity, entries: [], leafId: null }),
  submit: async () => ({ status: 'unknown' }),
});
await fs.writeFile(config.marker, JSON.stringify({ owner }));
setInterval(() => {}, 1000);
