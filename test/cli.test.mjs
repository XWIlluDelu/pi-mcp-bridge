import { shortTempDir } from './fixtures/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initConfig, runDoctor, runCli } from '../bin/pi-mcp-bridge.mjs';

test('CLI init and doctor create and validate a working owner configuration', async (t) => {
  const root = await shortTempDir('pi-bridge-cli-');
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

    // Long stateDir (like macOS ~/Library/Application Support/...) automatically gets a short attachmentDir.
    const longState = path.join(
      root,
      'Application Support',
      'very-long-user-state-dir-' + 'x'.repeat(35),
    );
    const longCfg = path.join(root, 'cfg2', 'owner.json');
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await initConfig([
        longCfg,
        '--project',
        project,
        '--sessions',
        sessions,
        '--state',
        longState,
        '--json',
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
    const written = JSON.parse(await fs.readFile(longCfg, 'utf8'));
    assert.ok(written.attachmentDir, 'expected short attachmentDir for long stateDir');
    assert.ok(written.attachmentDir.startsWith(root));
    assert.ok(
      Buffer.byteLength(path.join(written.attachmentDir, '2147483647-12345678.sock')) <= 100,
    );
    const longReport = await runDoctor([longCfg, '--json']);
    assert.equal(longReport.ok, true);
  } finally {
    console.log = prevLog;
  }

  // Missing required args reject before spawning child processes.
  await assert.rejects(runCli(['stdio']), /Missing required arguments/);
  await assert.rejects(runCli(['release', configFile]), /Missing required arguments/);
  await assert.rejects(runCli(['unknown-subcmd']), /Unknown command/);
});
