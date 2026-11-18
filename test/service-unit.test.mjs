import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile),
  base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('user-service template parses with systemd without installing or starting a service', async (t) => {
  try {
    await exec('systemd-analyze', ['--version']);
  } catch (e) {
    if (e.code === 'ENOENT') {
      t.skip('systemd-analyze unavailable');
      return;
    }
    throw e;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-service-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const template = await fs.readFile(path.join(base, 'deploy/pi-mcp-bridge.service'), 'utf8');
  assert.ok(template.includes('StandardInput=null'));
  assert.ok(template.includes('KillMode=mixed'));
  assert.ok(!template.includes('PrivateTmp='));
  const rendered = template
    .replaceAll('%h/.local/share/pi-mcp-bridge', base)
    .replaceAll('%h/.config/pi-mcp-bridge', dir)
    .replaceAll('/usr/bin/node', process.execPath);
  const unit = path.join(dir, 'pi-mcp-bridge.service');
  await fs.writeFile(unit, rendered);
  await exec('systemd-analyze', ['verify', unit], { timeout: 10000 });
});
