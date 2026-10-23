import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { readRecord, writeRecord, HerdrControl } from './herdr-control.mjs';

async function run() {
  const file = process.argv[2];
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192)
    throw new Error('HERDR_INVALID_TICKET');
  const ticket = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.unlink(file);
  const sockets = {};
  let child,
    launch,
    stopping = false;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  try {
    for (const channel of ['control', 'rpc', 'stderr']) {
      const socket = connect({ path: ticket.address, allowHalfOpen: true });
      sockets[channel] = socket;
      socket.on('error', stop);
      if (channel === 'control') socket.on('close', stop);
      await once(socket, 'connect');
      writeRecord(socket, { token: ticket.token, channel });
    }
    launch = await readRecord(sockets.control, AbortSignal.timeout(30000), 1024 * 1024);
    if (stopping) return;
    const env = { ...launch.env };
    for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
    for (const [key, value] of Object.entries(process.env))
      if (key.startsWith('HERDR_')) env[key] = value;
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    child.on('error', stop);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', stop);
    await once(child, 'spawn');
    writeRecord(sockets.control, { pid: child.pid });
    child.stdout.pipe(sockets.rpc);
    child.stderr.pipe(sockets.stderr);
    sockets.rpc.pipe(child.stdin); // Half-close is native EOF, not transport loss.
    sockets.control.on('end', stop);
    sockets.control.resume();
    process.stdout.write('Bridge Pi RPC worker\n');
    const result = await closed;
    // Child close is not socket flush. Drain both byte streams before reporting exit.
    await Promise.all(
      [sockets.rpc, sockets.stderr].map((socket) =>
        finished(socket, { readable: false, cleanup: true }),
      ),
    );
    writeRecord(sockets.control, result);
    await new Promise((resolve) => sockets.control.end(resolve));
  } finally {
    stop();
    for (const socket of Object.values(sockets)) socket.destroy();
    // Host loss still removes only this allocated pane, after Pi really exits.
    // Normal cleanup is performed by the host after this scope becomes empty.
    if (stopping && child && child.exitCode === null && child.signalCode === null)
      await once(child, 'close');
    // Remove only the ticket's own empty IPC directory, including after host loss.
    if (path.dirname(ticket.address) === path.dirname(file)) {
      await fs.unlink(ticket.address).catch(() => {});
      await fs.rmdir(path.dirname(file)).catch(() => {});
    }
    if (launch?.pane && sockets.control.destroyed && !sockets.control.writableFinished) {
      const control = new HerdrControl(launch.pane.address, launch.pane.identity);
      await control.request('pane.close', { pane_id: launch.pane.id }).catch(() => {});
    }
  }
}
run().catch(() => {
  process.stderr.write('Bridge Herdr worker failed\n');
  process.exitCode = 1;
});
