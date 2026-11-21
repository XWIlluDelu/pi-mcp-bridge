import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { opaqueId } from '../../src/core/storage.mjs';
import { ownerSocket } from '../../src/owner-runtime.mjs';
import { until } from './until.mjs';

// Hold an actual initialization boundary before ownership can be published.
export function holdInit({ config, stage, reached, release }) {
  async function pause() {
    await fs.writeFile(reached, 'ready');
    await until(() => fs.stat(release).catch(() => null), 'initialization release');
    if (stage === 'owner-listen-failure') throw new Error('FIXTURE_INIT_FAILURE');
  }
  const namespace = opaqueId('bridge:' + config.stateDir);
  if (stage === 'before-acquire' && process.platform === 'darwin') {
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (
        path.basename(source).startsWith('pending-') &&
        path.basename(target) === `${namespace}.sock`
      )
        await pause();
      return rename(source, target);
    };
    return;
  }
  const listen = net.Server.prototype.listen;
  const address = stage === 'before-acquire' ? '\0pi-mcp-' + namespace : ownerSocket(config);
  net.Server.prototype.listen = function (target, ...args) {
    if (target !== address) return listen.call(this, target, ...args);
    void pause()
      .then(() => listen.call(this, target, ...args))
      .catch((error) => this.emit('error', error));
    return this;
  };
}
