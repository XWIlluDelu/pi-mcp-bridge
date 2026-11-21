import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initConfig, runDoctor } from '../bin/pi-mcp-bridge.mjs';

test('CLI init and doctor create and validate a working owner configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-cli-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const project = path.join(root, 'proj');
  const sessions = path.join(root, 'sessions');
  const state = path.join(root, 'state');
  const configFile = path.join(root, 'cfg', 'owner.json');
  await fs.mkdir(project, { recursive: true });

  const prevLog = console.log;
  console.log = () => {};
  try {
    const created = await initConfig([
      configFile,
      '--project',
      project,
      '--sessions',
      sessions,
      '--state',
      state,
      '--http-port',
      '43211',
      '--json',
    ]);
    assert.equal(created.httpPort, 43211);
    const report = await runDoctor([configFile, '--json']);
    assert.equal(report.ok, true);
  } finally {
    console.log = prevLog;
  }
});
