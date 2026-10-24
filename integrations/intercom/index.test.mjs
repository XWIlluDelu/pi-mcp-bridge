import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CompatibilityModules } from '../../src/compatibility.mjs';
import { CompatibilityServices } from '../../src/compatibility-services.mjs';

const intercom = fileURLToPath(new URL('./index.mjs', import.meta.url));

test('input mapping and daemon environment isolation start and stop together without touching native environment', async () => {
  const services = new CompatibilityServices(),
    manager = new CompatibilityModules([{ module: intercom }], services),
    env = {
      PI_INTERCOM_SESSION: 'other-session',
      PI_INTERCOM_SOCKET: '/socket',
      HOME: '/home',
      OTHER: 'keep',
    };
  await manager.start();
  try {
    assert.deepEqual(services.readInputs.snapshot(), [
      { id: 'pi-intercom', inputCustomTypes: ['intercom_message'] },
    ]);
    assert.deepEqual(services.daemonEnvironment.apply(env), { HOME: '/home', OTHER: 'keep' });
    assert.equal(env.PI_INTERCOM_SESSION, 'other-session');
    assert.throws(
      () => services.readInputs.register('conflict', ['intercom_message']),
      /INVALID_READ_ADAPTER/,
    );
  } finally {
    await manager.stop();
  }
  assert.deepEqual(services.readInputs.snapshot(), []);
  assert.deepEqual(services.daemonEnvironment.apply(env), env);
});
