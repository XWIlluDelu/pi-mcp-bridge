import { compactReceipt, nativeCompactReason } from '../ops/compact.mjs';
import { permitted } from './permissions.mjs';
import { prepareSession, persistSession } from '../ops/create-session.mjs';
import { promptInput } from '../ops/prompt-input.mjs';
import { READ_CONTRACT } from '../read/context-read.mjs';
import {
  readSessionIdentity,
  loadSavedSession,
  validateExecutionCwd,
  sameSessionIdentity,
} from './data.mjs';
import { withdrawalOutput } from '../ops/stop-execution.mjs';
import { bashOutput } from '../ops/bash-execution.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import { prepareTrash } from '../ops/trash.mjs';
import { optionalResultFields } from '../mcp/response-budget.mjs';
import { readableOwner } from './bridge-read.mjs';

function rejected(bridge, error) {
  return { status: error.uncertain ? 'unknown' : 'rejected', reason: bridge.safeReason(error) };
}

async function submit(bridge, target, operation, input, acquire, authorize, admitted) {
  const submissionId = bridge.submissions.start(target.id, operation);
  const selection = {};
  const record = (receipt) => bridge.submissions.update(submissionId, receipt) ?? receipt;
  let receipt;
  try {
    const runtime = await acquire();
    receipt = await runtime.submitPrompt(input, {
      submissionId,
      selection,
      authorize,
      onAdmitted: () => admitted(runtime),
      onLate: record,
    });
  } catch (error) {
    receipt = rejected(bridge, error);
  }
  return { ...selection, ...record(receipt), submission_id: submissionId };
}

export async function reloadSession(
  bridge,
  _args,
  { target: session, requestContext, markForAutoRelease, checkInput },
) {
  return bridge.mutationLock(session.id, 'send', requestContext, async () => {
    let runtime,
      replacementStarted = false;
    const assertNoBash = () => {
      checkInput();
      if (bridge.lane(session.id, 'bash')) throw new Error('RELOAD_BUSY');
    };
    try {
      assertNoBash();
      runtime = await bridge.pool.forRead(session);
      if (!runtime) return { status: 'skipped', reason: 'no_active_owner' };
      if (runtime.attached) return await runtime.reload(checkInput);
      const marker = { kind: 'reload', controller: new AbortController() };
      return await bridge.withHandoff(session.id, marker, async () => {
        await bridge.pool.shutdown(runtime, marker.controller.signal, { beforeExit: assertNoBash });
        replacementStarted = true;
        marker.controller.signal.throwIfAborted();
        checkInput();
        const replacement = await bridge.pool.resolve(session);
        markForAutoRelease(replacement);
        if (!(replacement instanceof PiRpc) || replacement === runtime)
          throw new Error('RELOAD_UNCONFIRMED');
        const version = replacement.ownerRecord?.bridgeVersion;
        if (!version || replacement.ownerRecord?.readContract !== READ_CONTRACT)
          throw new Error('RELOAD_UNCONFIRMED');
        return { status: 'completed', owner_version: version, read_compatible: true };
      });
    } catch (error) {
      const uncertain =
        error.uncertain || replacementStarted || runtime?.gracefulExitPromise || runtime?.exitSeal;
      return {
        status: uncertain ? 'unknown' : 'rejected',
        reason: [
          'RUNTIME_BUSY',
          'MODEL_SELECTION_PENDING',
          'PROMPT_ADMISSION_PENDING',
          'RELOAD_IN_PROGRESS',
        ].includes(error.code ?? error.message)
          ? 'RELOAD_BUSY'
          : bridge.safeReason(error),
      };
    }
  });
}

export async function compactSession(
  bridge,
  args,
  { target: session, requestContext, markForAutoRelease, checkInput },
) {
  if (args.interrupt) bridge.check('stop', session, requestContext);
  const body = { instructions: args.instructions ?? '', interrupt: args.interrupt ?? false };
  return bridge.mutationLock(session.id, 'send', requestContext, async () => {
    try {
      const runtime = await bridge.pool.resolve(session, { beforeStart: checkInput });
      markForAutoRelease(runtime);
      const result = await runtime.compact(body, checkInput);
      return { interrupt_requested: body.interrupt, ...compactReceipt(result) };
    } catch (error) {
      const nativeReason =
        error.code === 'PI_REJECTED' ? nativeCompactReason(error.native_reason) : undefined;
      return {
        status: error.uncertain ? 'unknown' : 'rejected',
        reason: bridge.safeReason(error),
        ...(nativeReason ? { native_reason: nativeReason } : {}),
        native_effects:
          error.code === 'PI_REJECTED' || error.uncertain ? 'native_compact_attempted' : 'none',
      };
    }
  });
}

export async function setSessionModel(
  bridge,
  args,
  { target, requestContext, markForAutoRelease },
) {
  return bridge.locked(target.id, async () => {
    // The request policy is frozen and permission was checked for this exact
    // identity. These rechecks bind each dispatch and its result to that target.
    const authorized = async () => {
      bridge.assertOpen();
      if (bridge.handoff(target.id) && bridge.handoff(target.id).kind !== 'auto_release')
        throw new Error('HANDOFF_PENDING');
      await bridge.revalidateSession(target, requestContext);
    };
    await authorized();
    const runtime = await bridge.pool.resolve(target, {
      beforeStart: authorized,
      onStart: markForAutoRelease,
    });
    await authorized();
    const actual = await runtime.selectModel(args.model, {
      thinkingLevel: args.thinking_level,
      nativeThinking: true,
      beforeDispatch: authorized,
    });
    await authorized();
    return actual;
  });
}

export function sendPrompt(
  bridge,
  args,
  { target, requestContext, markForAutoRelease, checkInput },
) {
  const acquire = async () => {
    checkInput();
    const session = await bridge.revalidateSession(target, requestContext);
    bridge.check('send', session, requestContext);
    const runtime = await bridge.pool.resolve(session, {
      beforeStart: checkInput,
      onStart: markForAutoRelease,
    });
    checkInput();
    return runtime;
  };
  return bridge.mutationLock(target.id, 'send', requestContext, () =>
    submit(
      bridge,
      target,
      'send',
      { ...promptInput(args), mode: args.mode ?? 'steer' },
      acquire,
      checkInput,
      markForAutoRelease,
    ),
  );
}

// Bash and Stop report a partial native result if their final reply is lost.
async function inlineExecution(bridge, run) {
  let generation;
  try {
    return await run(
      (runtime) => (generation = runtime.generation ?? runtime.record?.generation ?? null),
    );
  } catch (error) {
    return {
      receipt: { ...rejected(bridge, error), ...(generation ? { generation } : {}) },
      output: error.result,
    };
  }
}

export async function runCommand(
  bridge,
  args,
  { target: session, resultBudget, markForAutoRelease, checkInput },
) {
  if (bridge.lane(session.id, 'bash'))
    return { status: 'rejected', reason: 'BASH_IN_PROGRESS', output_available: false };
  const { receipt, output } = await bridge.locked(
    session.id,
    () =>
      inlineExecution(bridge, async (bind) => {
        const release = bridge.autoReleaseInProgress(session.id);
        if (release) await release;
        const beforeDispatch = () => {
          checkInput();
          if (bridge.handoff(session.id)) throw new Error('HANDOFF_PENDING');
        };
        beforeDispatch();
        const runtime = await bridge.pool.resolve(session, { beforeStart: beforeDispatch });
        markForAutoRelease(runtime);
        beforeDispatch();
        const generation = bind(runtime);
        const output = await runtime.executeBash({ ...args, beforeDispatch });
        return { receipt: { status: 'completed', generation }, output };
      }),
    'bash',
  );
  bridge.pool.instances.get(session.id)?.onIdleCandidate?.();
  return output
    ? bashOutput(receipt, output, args, resultBudget)
    : { ...receipt, output_available: false };
}

export async function stopSession(
  bridge,
  args,
  { target: session, requestContext, resultBudget, retainedInputs },
) {
  const result = await bridge.mutationLock(
    session.id,
    'stop',
    requestContext,
    () =>
      inlineExecution(bridge, async (bind) => {
        bridge.assertOpen();
        for (const input of bridge.mutations)
          if (input.sessionId === session.id && !retainedInputs?.has(input)) input.stopped = true;
        const runtime =
          bridge.handoff(session.id)?.kind === 'auto_release'
            ? null
            : await bridge.pool.forRead(session);
        bridge.assertOpen();
        if (!runtime) return { receipt: { status: 'skipped', reason: 'not_running' } };
        const generation = bind(runtime);
        if (bridge.handoff(session.id)) throw new Error('HANDOFF_PENDING');
        const { withdrawal, ...receipt } = await runtime.stopExecution(args);
        return { receipt: { ...receipt, generation }, output: { withdrawal } };
      }),
    'stop',
  );
  bridge.pool.instances.get(session.id)?.onIdleCandidate?.();
  const receipt = result.receipt ?? result;
  const withdrawn =
    receipt.status === 'skipped'
      ? { text: '', includesEditorDraft: false, complete: true }
      : result.output?.withdrawal;
  return withdrawn
    ? withdrawalOutput(receipt, withdrawn, args, resultBudget)
    : { ...receipt, withdrawn_available: false };
}

export async function createSession(
  bridge,
  args,
  { requestContext, markForAutoRelease, mutation, checkInput },
) {
  const folder = requestContext.scope.folders.find((folder) => folder.path === args.project);
  if (!folder || !permitted(requestContext.permissions, 'create', { cwd: folder.path }))
    return {
      status: 'rejected',
      reason: 'NOT_FOUND_OR_DENIED',
    };
  const input = promptInput(args);
  let child,
    created = false;
  try {
    await validateExecutionCwd(folder.path);
    let parent, captureFork;
    if (args.fork_from) {
      parent = await bridge.session(args.fork_from, requestContext);
      bridge.check('read', parent, requestContext);
      let runtime;
      ({ session: parent, runtime } = await readableOwner(bridge, parent, requestContext));
      captureFork = async (sdk) => {
        if (!runtime) return loadSavedSession(parent, { sdk });
        const { entries, leafId } = runtime.attached
          ? await runtime.snapshot()
          : await runtime.entries();
        if (!Array.isArray(entries)) throw new Error('INVALID_RUNTIME_ENTRIES');
        if (!sameSessionIdentity(parent, await readSessionIdentity(parent.file)))
          throw new Error('RUNTIME_SESSION_CHANGED');
        // A live writer supplies current entries even if discovery saw an older header.
        return {
          header: { ...parent.header, version: sdk.CURRENT_SESSION_VERSION },
          entries,
          leafId,
        };
      };
    }
    const prepared = await prepareSession(
      { ...bridge.config, ...requestContext.scope },
      folder.path,
      {
        name: args.name,
        parentSession: parent?.file,
        captureFork,
      },
    );
    child = prepared.session;

    bridge.assertOpen();
    return await bridge.locked(child.id, async () => {
      bridge.registerInput(child.id, mutation);
      const beforeDispatch = () => {
        checkInput();
        if (bridge.handoff(child.id)) throw new Error('HANDOFF_PENDING');
      };
      beforeDispatch();
      await persistSession(child, prepared.entries);
      created = true;
      bridge.sessionFiles.set(child.id, child.file);
      if (!input) return { status: 'created', created, session_id: child.id };
      const acquire = async () => {
        const runtime = await bridge.pool.resolve(child, { beforeStart: beforeDispatch });
        markForAutoRelease(runtime);
        beforeDispatch();
        if (runtime.attached) throw new Error('RUNTIME_SESSION_CHANGED');
        return runtime;
      };
      const { submission_id, ...send } = await submit(
        bridge,
        child,
        'create',
        { ...input, mode: 'steer' },
        acquire,
        beforeDispatch,
        markForAutoRelease,
      );
      return { status: send.status, created, session_id: child.id, submission_id, send };
    });
  } catch (error) {
    const failure = rejected(bridge, error);
    if (!child) return failure;
    return {
      status: failure.status,
      created: created || error.sessionPublished === true,
      session_id: child.id,
      ...(input ? { send: failure } : failure),
    };
  }
}

export async function deleteSession(bridge, args, { target, requestContext, resultBudget }) {
  // Delete has its own serialization lane: a normal EOF/handoff may hold
  // the session lane indefinitely. Fence new work before interrupting that
  // lifecycle, then drain the session lane before moving the saved history.
  return bridge.locked(
    args.session_id,
    async () => {
      let trash, failure;
      try {
        const s = await bridge.revalidateSession(target, requestContext);
        trash = await prepareTrash(bridge.config, s);
        const prior = bridge.handoff(s.id);
        await bridge.withHandoff(s.id, { kind: 'delete' }, async () => {
          let finishDeletion;
          try {
            prior?.controller?.abort();
            // This gate covers termination, lane drain and the trash move.
            finishDeletion = await bridge.pool.stopForDelete(s);
            await bridge.locked(s.id, async () => {
              await bridge.revalidateSession(s, requestContext);
              await trash.move();
            });
          } catch (error) {
            failure = error;
          } finally {
            await trash.cancel().catch(() => {});
            if (trash.moved) {
              bridge.completionSequences.delete(s.id);
              bridge.sessionFiles.delete(s.id);
            }
            await finishDeletion?.(trash.moved);
          }
        });
      } catch (error) {
        failure ??= error;
      }
      return optionalResultFields(
        {
          status: failure ? (trash?.moved ? 'unknown' : 'rejected') : 'deleted',
          ...(failure ? { reason: bridge.safeReason(failure) } : {}),
          ...(trash?.moved ? { recoverable: true, restore_token: trash.token } : {}),
        },
        { project: target?.cwd ?? null },
        resultBudget,
      );
    },
    'delete',
  );
}
