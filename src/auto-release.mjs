import { diagnostics } from './diagnostics.mjs';

// Event-driven owner maintenance. No delay timer, cold-resume fence or external-owner exit.
export function scheduleAutoRelease(bridge, runtime) {
  if (!runtime.autoReleaseWanted || bridge.closing || bridge.closePreparation || !runtime.alive)
    return;
  runtime.autoReleaseAgain = true;
  if (runtime.autoReleaseTask) return runtime.autoReleaseTask;
  const id = runtime.session.id;
  const task = Promise.resolve()
    .then(async () => {
      while (runtime.autoReleaseAgain && runtime.alive && !bridge.closing) {
        runtime.autoReleaseAgain = false;
        await bridge.locked(id, async () => {
          const eligible = () =>
            !bridge.closing &&
            !bridge.closePreparation &&
            runtime.alive &&
            bridge.pool.instances.get(id) === runtime &&
            !bridge.handoffs.has(id) &&
            !bridge.locks.has(`stop:${id}`) &&
            !bridge.locks.has(`bash:${id}`) &&
            !runtime.activeReads &&
            !runtime.activeBashes;
          if (!eligible()) return;
          const idle = await runtime.idleSnapshot();
          if (idle.status !== 'idle' || !eligible()) return;
          await runtime.drainAcks();
          if (!eligible()) return;
          const marker = { kind: 'auto_release', runtime };
          bridge.handoffs.set(id, marker);
          runtime.handoffPending = true;
          try {
            // Mutations hold this lane; readers that arrive now wait for this exit.
            await runtime.gracefulExit();
            diagnostics.emit('runtime.auto_released', {
              kind: 'rpc',
              generation: runtime.generation,
            });
          } catch (error) {
            // New native work can arrive after idle proof. Leave this generation
            // open; its settlement/ACK events schedule the next idle check.
            if (error.code !== 'RUNTIME_BUSY') throw error;
          } finally {
            if (bridge.handoffs.get(id) === marker) bridge.handoffs.delete(id);
            if (!runtime.gracefulExitPromise) runtime.handoffPending = false;
            if (runtime.exited && bridge.pool.instances.get(id) === runtime) {
              bridge.pool.instances.delete(id);
            }
          }
        });
      }
    })
    .catch((error) => {
      diagnostics.emit('runtime.auto_release_failed', {
        code: error.code ?? error.message,
        generation: runtime.generation,
        uncertain: error.uncertain === true,
      });
    })
    .finally(() => {
      bridge.autoReleases.delete(task);
      runtime.autoReleaseTask = null;
      if (runtime.autoReleaseAgain) scheduleAutoRelease(bridge, runtime);
    });
  runtime.autoReleaseTask = task;
  bridge.autoReleases.add(task);
  return task;
}
