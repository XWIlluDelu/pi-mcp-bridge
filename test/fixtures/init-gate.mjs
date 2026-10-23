import net from 'node:net';
import fs from 'node:fs/promises';
import { opaqueId } from '../../src/storage.mjs';
import { ownerSocket } from '../../src/owner-runtime.mjs';

// Hold an actual initialization boundary, not an obsolete lockfile operation.
export function holdInit({ config, stage, reached, release }) {
  const listen = net.Server.prototype.listen,
    address =
      stage === 'before-acquire'
        ? '\0pi-mcp-' + opaqueId('bridge:' + config.stateDir)
        : ownerSocket(config);
  net.Server.prototype.listen = function (target, ...args) {
    if (target !== address) return listen.call(this, target, ...args);
    const server = this;
    void (async () => {
      await fs.writeFile(reached, 'ready');
      while (
        !(await fs.stat(release).then(
          () => true,
          () => false,
        ))
      )
        await new Promise((r) => setTimeout(r, 10));
      if (stage === 'owner-listen-failure') throw new Error('FIXTURE_INIT_FAILURE');
      listen.call(server, target, ...args);
    })().catch((error) => server.emit('error', error));
    return server;
  };
}
