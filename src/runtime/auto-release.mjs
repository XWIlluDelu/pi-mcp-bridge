import { diagnostics } from '../core/diagnostics.mjs';

// Event-driven owner maintenance. No delay timer, cold-resume fence or external-owner exit.
export function scheduleAutoRelease(bridge, runtime) {
  if (
    !runtime.autoReleaseWanted ||
    bridge.closing ||
    bridge.closePreparation ||
    !runtime.alive ||
    (runtime.exitSeal && !runtime.autoReleaseTask)
  )
    return;
  // Preserve completion hints while the current seal awaits its reply. A
  // definite busy refusal may reopen admission; an unknown result stays fenced.
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
            !runtime.exitSeal &&
            bridge.pool.instances.get(id) === runtime &&
            !bridge.handoffs.has(id) &&
            !bridge.locks.has(`stop:${id}`) &&
            !bridge.locks.has(`bash:${id}`) &&
            !runtime.activeReads &&
            !runtime.hasUnsettledWork();
          if (!eligible()) return;
          const idle = await runtime.idleSnapshot();
          if (idle.status !== 'idle' || !eligible()) return;
          const marker = { kind: 'auto_release', runtime, controller: new AbortController() };
          try {
            // Mutations hold this lane; readers that arrive now wait for this exit.
            await bridge.withHandoff(id, marker, () =>
              bridge.pool.shutdown(runtime, marker.controller.signal, { mode: 'proven_idle' }),
            );
            diagnostics.emit('runtime.auto_released', {
              kind: 'rpc',
              generation: runtime.generation,
            });
          } catch (error) {
            // New native work can arrive after idle proof. Leave this generation
            // open; its settlement/ACK events schedule the next idle check.
            if (!marker.controller.signal.aborted && error.code !== 'RUNTIME_BUSY') throw error;
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
