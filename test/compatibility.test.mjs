import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { CompatibilityModules } from '../src/compatibility.mjs';
import { CompatibilityServices } from '../src/compatibility-services.mjs';
import { Bridge } from '../src/bridge.mjs';
import { publicError } from '../src/errors.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const intercom = fileURLToPath(new URL('../integrations/intercom/index.mjs', import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-compatibility-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    async module(name, start, id = name) {
      const file = path.join(dir, name + '.mjs');
      await fs.writeFile(
        file,
        `export default {id: ${JSON.stringify(id)}${start ? ', ' + start : ''}};`,
      );
      return file;
    },
    config: {
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: dir }],
      defaults: denyAllPermissions(),
    },
  };
}

test('one module lifecycle supports independent capabilities, options and reverse cleanup', async (t) => {
  const f = await fixture(t),
    events = [],
    bus = new EventEmitter(),
    ports = new CompatibilityServices(),
    services = { ...ports, events, bus };
  const input = await f.module(
    'input',
    {
      start({ id, services, onStop }, options) {
        services.events.push('input-start');
        onStop(services.readInputs.register(id, options.types));
        onStop(() => services.events.push('input-stop'));
        options.types.push('local-only');
      },
    }.start,
  );
  const listener = await f.module(
    'listener',
    {
      async start({ services, onStop }, options) {
        services.events.push('listener-start');
        const receive = (value) => services.events.push(options.prefix + value);
        services.bus.on('message', receive);
        onStop(async () => {
          services.bus.off('message', receive);
          services.events.push('listener-stop');
        });
      },
    }.start,
  );
  const entries = [
    { module: input, options: { types: ['fixture-input'] } },
    { module: listener, options: { prefix: 'received:' } },
    { module: path.join(f.dir, 'not-installed.mjs'), enabled: false },
  ];
  const manager = new CompatibilityModules(entries, services);
  t.after(() => manager.stop());
  const starting = manager.start();
  assert.strictEqual(manager.start(), starting);
  await starting;
  assert.deepEqual(
    manager.active.map((m) => m.id),
    ['input', 'listener'],
  );
  assert.deepEqual(entries[0].options.types, ['fixture-input']);
  const mappings = ports.readInputs.snapshot();
  mappings[0].inputCustomTypes.push('snapshot-only');
  assert.deepEqual(ports.readInputs.snapshot(), [
    { id: 'input', inputCustomTypes: ['fixture-input'] },
  ]);
  bus.emit('message', 'hello');
  const stopping = manager.stop();
  assert.strictEqual(manager.stop(), stopping);
  await stopping;
  assert.equal(bus.listenerCount('message'), 0);
  assert.deepEqual(ports.readInputs.snapshot(), []);
  assert.deepEqual(events, [
    'input-start',
    'listener-start',
    'received:hello',
    'listener-stop',
    'input-stop',
  ]);
  await assert.rejects(manager.start(), /COMPATIBILITY_MODULES_CLOSED/);
});

test('module import and registration failures are explicit, and partial activation unwinds', async (t) => {
  const f = await fixture(t),
    services = { ...new CompatibilityServices(), events: [] };
  const first = await f.module(
    'first',
    {
      start({ id, services, onStop }) {
        onStop(services.readInputs.register(id, ['first-input']));
        onStop(() => services.events.push('first-stop'));
      },
    }.start,
  );
  const fail = await f.module(
    'fail',
    {
      start({ services, onStop }) {
        onStop(services.daemonEnvironment.register((env) => delete env.TEST));
        onStop(() => services.events.push('fail-stop'));
        throw new Error('PRIVATE_PLUGIN_FAILURE');
      },
    }.start,
  );
  const manager = new CompatibilityModules([{ module: first }, { module: fail }], services);
  await assert.rejects(
    manager.start(),
    (error) => publicError(error) === 'COMPATIBILITY_MODULE_START_FAILED',
  );
  assert.deepEqual(services.events, ['fail-stop', 'first-stop']);
  assert.deepEqual(services.readInputs.snapshot(), []);
  assert.deepEqual(services.daemonEnvironment.apply({ TEST: 'retained' }), { TEST: 'retained' });
  await manager.stop();
  const invalid = await f.module('invalid');
  const duplicate = await f.module('duplicate', 'start() {}', 'first');
  for (const [entries, code] of [
    [[{ module: path.join(f.dir, 'missing.mjs') }], 'COMPATIBILITY_MODULE_LOAD_FAILED'],
    [[{ module: invalid }], 'INVALID_COMPATIBILITY_MODULE'],
    [[{ module: first }, { module: duplicate }], 'INVALID_COMPATIBILITY_MODULE'],
  ]) {
    const failed = new CompatibilityModules(entries, services);
    await assert.rejects(failed.start(), { message: code });
    await failed.stop();
    assert.deepEqual(services.readInputs.snapshot(), []);
  }
});

test('Bridge activation failure releases its namespace; modules stop only after runtime drain', async (t) => {
  const f = await fixture(t);
  const module = await f.module(
    'startup-failure',
    {
      start({ id, services, onStop }) {
        onStop(services.readInputs.register(id, ['fixture']));
        throw new Error('PRIVATE_STARTUP_FAILURE');
      },
    }.start,
  );
  const failed = new Bridge({ ...f.config, compatibilityModules: [{ module }] });
  await assert.rejects(failed.init(), /COMPATIBILITY_MODULE_START_FAILED/);
  assert.deepEqual(failed.compatibilityServices.readInputs.snapshot(), []);
  await failed.close();
  const bridge = await new Bridge({
    ...f.config,
    compatibilityModules: [{ module: intercom }],
  }).init();
  const draining = Promise.withResolvers(),
    drained = Promise.withResolvers();
  t.mock.method(bridge.pool, 'close', async () => {
    draining.resolve();
    await drained.promise;
  });
  t.after(async () => {
    drained.resolve();
    await bridge.close();
  });
  const closing = bridge.close();
  await draining.promise;
  assert.equal(bridge.compatibilityServices.readInputs.snapshot().length, 1);
  drained.resolve();
  await closing;
  assert.deepEqual(bridge.compatibilityServices.readInputs.snapshot(), []);
  const restarted = await new Bridge(f.config).init();
  assert.deepEqual(restarted.compatibilityServices.readInputs.snapshot(), []);
  await restarted.close();
});
