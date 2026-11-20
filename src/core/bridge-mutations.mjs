import { compactReceipt, nativeCompactReason } from '../ops/compact.mjs';
import { modelSettings } from '../ops/set-model.mjs';
import { permitted } from './permissions.mjs';
import { prepareSession, persistSession } from '../ops/create-session.mjs';
import { hasPromptSettings, promptInput, promptResult } from '../ops/prompt-input.mjs';
import { READ_CONTRACT } from '../read/context-read.mjs';
import {
  readSessionIdentity,
  loadSavedSession,
  validateExecutionCwd,
  sameSessionIdentity,
} from './data.mjs';
import { stopReceipt, inlineWithdrawal, withdrawalOutput } from '../ops/stop-execution.mjs';
import { bashOutput, inlineBashResult } from '../ops/bash-execution.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import { prepareTrash } from '../ops/trash.mjs';
import { optionalResultFields } from '../mcp/response-budget.mjs';
import { readableOwner } from './bridge-read.mjs';

// Existing owners remain usable without their original cwd; only a new
// writer needs a validated directory. PiRpc validates history under its claim.
async function coldStart(bridge, session, beforeResolve = () => {}) {
  await validateExecutionCwd(session.cwd);
  await beforeResolve();
  return bridge.pool.resolve(session);
}

function submitPrompt(
  bridge,
  runtime,
  input,
  submissionId,
  selection,
  authorize,
  markForAutoRelease,
) {
  return runtime.submitPrompt(input, {
    submissionId,
    selection,
    authorize,
    onAdmitted: () => markForAutoRelease(runtime),
    onLate: (receipt) => bridge.submissions.update(submissionId, receipt),
  });
}

export async function reloadSession(
  bridge,
  args,
  { requestContext, markForAutoRelease, checkInput },
) {
  const session = await bridge.session(args.session_id, requestContext);
  bridge.check('send', session, requestContext);
  return bridge.mutationLock(session.id, 'send', requestContext, async () => {
    let runtime,
      replacementStarted = false;
    const assertNoBash = () => {
      checkInput();
      if (bridge.locks.has(`bash:${session.id}`)) throw new Error('RELOAD_BUSY');
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
  { requestContext, markForAutoRelease, checkInput },
) {
  const session = await bridge.session(args.session_id, requestContext);
  bridge.check('send', session, requestContext);
  if (args.interrupt) bridge.check('stop', session, requestContext);
  const body = { instructions: args.instructions ?? '', interrupt: args.interrupt ?? false };
  return bridge.mutationLock(session.id, 'send', requestContext, async () => {
    try {
      let runtime = await bridge.pool.forRead(session);
      runtime ??= await coldStart(bridge, session, checkInput);
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

export async function setSessionModel(bridge, args, { requestContext, markForAutoRelease }) {
  const target = await bridge.session(args.session_id, requestContext);
  bridge.check('send', target, requestContext);
  return bridge.locked(target.id, async () => {
    let runtime;
    const authorized = async () => {
      bridge.assertOpen();
      if (bridge.handoffs.has(target.id) && bridge.handoffs.get(target.id).kind !== 'auto_release')
        throw new Error('HANDOFF_PENDING');
      const current = await bridge.session(target.id, requestContext);
      if (!sameSessionIdentity(current, target)) throw new Error('RUNTIME_SESSION_CHANGED');
      bridge.check('send', current, requestContext);
    };
    await authorized();
    runtime = await bridge.pool.forRead(target);
    if (!runtime) {
      runtime = await coldStart(bridge, target, authorized);
      markForAutoRelease(runtime);
    }
    await authorized();
    const actual = await runtime.selectModel(args.model, {
      thinkingLevel: args.thinking_level,
      nativeThinking: true,
      beforeDispatch: authorized,
    });
    await authorized();
    return modelSettings(actual);
  });
}

export async function sendPrompt(
  bridge,
  args,
  { requestContext, markForAutoRelease, checkInput: beforeDispatch },
) {
  const body = { ...promptInput(args), mode: args.mode ?? 'steer' };
  const target = await bridge.session(args.session_id, requestContext).catch(() => null);
  if (!target || !permitted(requestContext.permissions, 'send', target))
    return {
      status: 'rejected',
      reason: 'NOT_FOUND_OR_DENIED',
    };
  return bridge.mutationLock(args.session_id, 'send', requestContext, async () => {
    const selection = {};
    const submissionId = bridge.submissions.start(target.id, 'send');
    const outcome = (receipt) => ({
      ...selection,
      ...(bridge.submissions.update(submissionId, receipt) ?? receipt),
      submission_id: submissionId,
    });
    let runtime;
    try {
      beforeDispatch();
      const s = await bridge.session(args.session_id, requestContext);
      if (!sameSessionIdentity(s, target)) throw new Error('RUNTIME_SESSION_CHANGED');
      bridge.check('send', s, requestContext);
      runtime = await bridge.pool.forRead(s);
      if (!runtime) {
        runtime = await coldStart(bridge, s);
        markForAutoRelease(runtime);
      }
      await beforeDispatch();
      let input = body;
      if (runtime.attached && hasPromptSettings(body)) {
        const actual = await runtime.selectModel(body.model, {
          thinkingLevel: body.thinking_level,
          nativeThinking: true,
          beforeDispatch,
        });
        selection.model_selection = modelSettings(actual);
        const { model: _model, thinking_level: _thinking, ...rest } = body;
        input = rest;
        await beforeDispatch();
      }
      return outcome(
        await submitPrompt(
          bridge,
          runtime,
          input,
          submissionId,
          selection,
          beforeDispatch,
          markForAutoRelease,
        ),
      );
    } catch (e) {
      return outcome(
        promptResult({
          ok: false,
          code: bridge.safeReason(e),
          uncertain: e.uncertain,
        }),
      );
    }
  });
}

export async function runCommand(
  bridge,
  args,
  { requestContext, resultBudget, markForAutoRelease, checkInput },
) {
  const session = await bridge.session(args.session_id, requestContext);
  bridge.check('command', session, requestContext);
  const lane = `bash:${session.id}`;
  if (bridge.locks.has(lane))
    return { status: 'rejected', reason: 'BASH_IN_PROGRESS', output_available: false };
  let output;
  const receipt = await bridge.locked(lane, async () => {
    let generation;
    try {
      if (bridge.handoffs.get(session.id)?.kind === 'auto_release')
        await bridge.pool.instances.get(session.id)?.autoReleaseTask;
      const beforeDispatch = async () => {
        checkInput();
        if (bridge.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
      };
      await beforeDispatch();
      const runtime = (await bridge.pool.forRead(session)) ?? (await coldStart(bridge, session));
      markForAutoRelease(runtime);
      await beforeDispatch();
      generation = runtime.generation ?? runtime.record?.generation ?? null;
      output = inlineBashResult(await runtime.executeBash({ ...args, beforeDispatch }));
      return { status: 'completed', generation };
    } catch (error) {
      if (error.result) output = inlineBashResult(error.result);
      return {
        status: error.uncertain ? 'unknown' : 'rejected',
        reason: bridge.safeReason(error),
        ...(generation ? { generation } : {}),
      };
    }
  });
  // Stop and bash lanes block auto-release; their end is a release opportunity.
  bridge.pool.instances.get(session.id)?.onIdleCandidate?.();
  return output
    ? bashOutput(receipt, output, args, resultBudget)
    : { ...receipt, output_available: false };
}

export async function stopSession(bridge, args, { requestContext, resultBudget, retainedInputs }) {
  const session = await bridge.session(args.session_id, requestContext);
  bridge.check('stop', session, requestContext);
  let withdrawn;
  const receipt = await bridge.mutationLock(
    session.id,
    'stop',
    requestContext,
    async () => {
      let generation;
      try {
        bridge.assertOpen();
        for (const input of bridge.inputs)
          if (input.sessionId === session.id && !retainedInputs?.has(input)) input.stopped = true;
        if (bridge.handoffs.get(session.id)?.kind === 'auto_release')
          return { status: 'skipped', reason: 'not_running' };
        const runtime = await bridge.pool.forRead(session);
        bridge.assertOpen();
        if (!runtime) return { status: 'skipped', reason: 'not_running' };
        generation = runtime.generation ?? runtime.record?.generation ?? null;
        if (bridge.handoffs.has(session.id)) throw new Error('HANDOFF_PENDING');
        const result = await runtime.stopExecution(args);
        withdrawn = inlineWithdrawal(result.withdrawal);
        return { ...stopReceipt(result), generation };
      } catch (error) {
        if (error.result?.withdrawal) withdrawn = inlineWithdrawal(error.result.withdrawal);
        return {
          status: error.uncertain ? 'unknown' : 'rejected',
          reason: bridge.safeReason(error),
          ...(generation ? { generation } : {}),
        };
      }
    },
    `stop:${session.id}`,
  );
  bridge.pool.instances.get(session.id)?.onIdleCandidate?.();
  if (receipt.status === 'skipped')
    withdrawn = { text: '', includesEditorDraft: false, complete: true };
  return withdrawn
    ? withdrawalOutput(receipt, withdrawn, args, resultBudget)
    : { ...receipt, withdrawn_available: false };
}

export async function createSession(bridge, args, { requestContext, markForAutoRelease }) {
  const folder = requestContext.scope.folders.find((folder) => folder.path === args.project);
  if (!folder || !permitted(requestContext.permissions, 'create', { cwd: folder.path }))
    return {
      status: 'rejected',
      reason: 'NOT_FOUND_OR_DENIED',
    };
  const input = promptInput(args);
  let child,
    submissionId,
    created = false;
  const selection = {};
  const outcome = (result) => {
    if (submissionId) result = bridge.submissions.update(submissionId, result) ?? result;
    return {
      ...(input ? { status: result.status } : result),
      created,
      session_id: child?.id,
      ...(submissionId ? { submission_id: submissionId } : {}),
      ...(input ? { send: { ...selection, ...result } } : {}),
    };
  };
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
    return await bridge.locked(child.id, () =>
      bridge.withInput(child.id, bridge.registerInput(child.id), async (checkInput) => {
        const beforeDispatch = async () => {
          checkInput();
          if (bridge.handoffs.has(child.id)) throw new Error('HANDOFF_PENDING');
        };
        await beforeDispatch();
        await persistSession(child, prepared.entries);
        created = true;
        bridge.sessionFiles.set(child.id, child.file);
        if (!input) return outcome({ status: 'created' });
        submissionId = bridge.submissions.start(child.id, 'create');

        const runtime = await bridge.pool.resolve(child);
        markForAutoRelease(runtime);
        await beforeDispatch();
        if (runtime.attached) throw new Error('RUNTIME_SESSION_CHANGED');
        return outcome(
          await submitPrompt(
            bridge,
            runtime,
            { ...input, mode: 'steer' },
            submissionId,
            selection,
            beforeDispatch,
            markForAutoRelease,
          ),
        );
      }),
    );
  } catch (error) {
    if (error.sessionPublished) created = true;
    const result = promptResult({
      ok: false,
      code: bridge.safeReason(error),
      uncertain: error.uncertain,
    });
    return child ? outcome(result) : result;
  }
}

export async function deleteSession(bridge, args, { requestContext, resultBudget }) {
  const target = await bridge.session(args.session_id, requestContext).catch(() => null);
  if (!target || !permitted(requestContext.permissions, 'delete', target))
    return {
      status: 'rejected',
      reason: 'NOT_FOUND_OR_DENIED',
    };
  // Delete has its own serialization lane: a normal EOF/handoff may hold
  // the session lane indefinitely. Fence new work before interrupting that
  // lifecycle, then drain the session lane before moving the saved history.
  return bridge.locked(`delete:${args.session_id}`, async () => {
    let trash, release, failure;
    const marker = { kind: 'delete' };
    try {
      const s = await bridge.session(args.session_id, requestContext);
      if (!sameSessionIdentity(s, target)) throw new Error('RUNTIME_SESSION_CHANGED');
      trash = await prepareTrash(bridge.config, s);
      const prior = bridge.handoffs.get(s.id);
      bridge.handoffs.set(s.id, marker);
      prior?.controller?.abort();
      // One session-wide deletion gate covers termination, lane drain and
      // the trash move. Do not reselect a writer in a second termination pass.
      release = await bridge.pool.stopForDelete(s);
      await bridge.locked(s.id, async () => {
        const current = await bridge.session(s.id, requestContext);
        if (!sameSessionIdentity(current, s)) throw new Error('RUNTIME_SESSION_CHANGED');
        await trash.move();
      });
    } catch (error) {
      failure = error;
    } finally {
      try {
        await trash?.cancel().catch(() => {});
        await release?.(trash?.moved === true);
      } catch (error) {
        failure ??= error;
      } finally {
        if (bridge.handoffs.get(args.session_id) === marker)
          bridge.handoffs.delete(args.session_id);
        if (trash?.moved) {
          bridge.completionSequences.delete(args.session_id);
          bridge.sessionFiles.delete(args.session_id);
        }
      }
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
  });
}
