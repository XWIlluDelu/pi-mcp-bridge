import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

async function submit(
  bridge,
  target,
  operation,
  input,
  { requestContext, checkInput, markForAutoRelease, waitMs },
) {
  const submissionId = bridge.submissions.start(target.id, operation);
  const selection = {};
  const record = (receipt) => bridge.submissions.update(submissionId, receipt) ?? receipt;
  let receipt, runtime, baselineSequence;
  try {
    checkInput();
    if (operation === 'send') target = await bridge.revalidateSession(target, requestContext);
    runtime = await bridge.pool.resolve(target, {
      beforeStart: checkInput,
      onStart: markForAutoRelease,
    });
    if (operation === 'create') markForAutoRelease(runtime);
    checkInput();
    if (operation === 'create' && runtime.attached) throw new Error('RUNTIME_SESSION_CHANGED');
    baselineSequence = runtime.settlementSequence;
    receipt = await runtime.submitPrompt(input, {
      submissionId,
      selection,
      authorize: checkInput,
      onAdmitted: () => markForAutoRelease(runtime),
      onLate: record,
    });
  } catch (error) {
    receipt = rejected(bridge, error);
  }
  const base = { ...selection, ...record(receipt), submission_id: submissionId };
  if (waitMs > 0) {
    if (base.status === 'handled') return { ...base, settled: true };
    if (['started', 'queued', 'dispatched'].includes(base.status)) {
      const settled = await bridge.waitForSettlement(target.id, waitMs, {
        runtime,
        baselineSequence,
      });
      if (settled) {
        return {
          ...base,
          settled: true,
          ...(typeof settled.aborted === 'boolean' ? { aborted: settled.aborted } : {}),
          ...(settled.leafId !== undefined ? { leaf_id: settled.leafId } : {}),
          ...(settled.result ? { result: settled.result } : {}),
        };
      }
      return { ...base, settled: false };
    }
  }
  return base;
}

async function reloadSession(bridge, _args, { target: session, markForAutoRelease, checkInput }) {
  let runtime;
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
    const uncertain = error.uncertain || runtime?.gracefulExitPromise || runtime?.exitSeal;
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
}

async function compactSession(bridge, args, { target: session, markForAutoRelease, checkInput }) {
  const body = { instructions: args.instructions ?? '', interrupt: args.interrupt ?? false };
  try {
    const runtime = await bridge.pool.resolve(session, { beforeStart: checkInput });
    markForAutoRelease(runtime);
    const result = await runtime.compact(body, checkInput);
    return { interrupt_requested: body.interrupt, ...compactReceipt(result) };
  } catch (error) {
    const nativeReason =
      error.code === 'PI_REJECTED' ? nativeCompactReason(error.native_reason) : undefined;
    return {
      ...rejected(bridge, error),
      ...(nativeReason ? { native_reason: nativeReason } : {}),
      native_effects:
        error.code === 'PI_REJECTED' || error.uncertain ? 'native_compact_attempted' : 'none',
    };
  }
}

async function appendSavedSessionName(bridge, target, name) {
  const saved = await loadSavedSession(target, { omitImageData: true, config: bridge.config });
  const entry = {
    type: 'session_info',
    id: randomUUID(),
    parentId: saved.leafId ?? saved.entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    name,
  };
  await fs.appendFile(target.file, JSON.stringify(entry) + '\n', 'utf8');
  bridge.titleCache.delete(target.file);
  return { name };
}

async function setSessionModel(bridge, args, { target, requestContext, markForAutoRelease }) {
  // The request policy is frozen and permission was checked for this exact
  // identity. These rechecks bind each dispatch and its result to that target.
  const authorized = async () => {
    bridge.assertOpen();
    const handoff = bridge.handoff(target.id);
    if (handoff && handoff.kind !== 'auto_release') throw new Error('HANDOFF_PENDING');
    await bridge.revalidateSession(target, requestContext);
  };
  await authorized();
  const hasModelSettings = args.model !== undefined || args.thinking_level !== undefined;
  if (!hasModelSettings && args.name !== undefined) {
    const live = await bridge.pool.forRead(target);
    if (!live) return appendSavedSessionName(bridge, target, args.name);
    await authorized();
    const renamed = await live.setSessionName(args.name, authorized);
    bridge.titleCache.delete(target.file);
    await authorized();
    return renamed;
  }
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
  if (args.name !== undefined) {
    await runtime.setSessionName(args.name, authorized);
    bridge.titleCache.delete(target.file);
  }
  await authorized();
  return args.name !== undefined ? { ...actual, name: args.name } : actual;
}

function sendPrompt(bridge, args, admission) {
  return submit(
    bridge,
    admission.target,
    'send',
    { ...promptInput(args), mode: args.mode ?? 'steer' },
    { ...admission, waitMs: args.wait_ms },
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

async function runCommand(
  bridge,
  args,
  { target: session, resultBudget, markForAutoRelease, checkInput },
) {
  const { receipt, output } = await inlineExecution(bridge, async (bind) => {
    const release = bridge.autoReleaseInProgress(session.id);
    if (release) await release;
    checkInput();
    const runtime = await bridge.pool.resolve(session, { beforeStart: checkInput });
    markForAutoRelease(runtime);
    checkInput();
    const generation = bind(runtime);
    const output = await runtime.executeBash({ ...args, beforeDispatch: checkInput });
    return { receipt: { status: 'completed', generation }, output };
  });
  return output
    ? bashOutput(receipt, output, args, resultBudget)
    : { ...receipt, output_available: false };
}

async function stopSession(bridge, args, { target: session, resultBudget, retainedInputs }) {
  const { receipt, output } = await inlineExecution(bridge, async (bind) => {
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
  });
  const withdrawn =
    receipt.status === 'skipped'
      ? { text: '', includesEditorDraft: false, complete: true }
      : output?.withdrawal;
  return withdrawn
    ? withdrawalOutput(receipt, withdrawn, args, resultBudget)
    : { ...receipt, withdrawn_available: false };
}

async function createSession(bridge, args, admission) {
  const { requestContext, mutation, checkInput } = admission;
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
      parent = await bridge.authorizedSession('read', args.fork_from, requestContext);
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
      checkInput();
      await persistSession(child, prepared.entries);
      created = true;
      bridge.sessionFiles.set(child.id, child.file);
      if (!input) return { status: 'created', created, session_id: child.id };
      const { submission_id, ...send } = await submit(
        bridge,
        child,
        'create',
        { ...input, mode: 'steer' },
        { ...admission, waitMs: args.wait_ms },
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

async function deleteSession(bridge, _args, { target, requestContext, resultBudget }) {
  let trash, failure;
  try {
    const session = await bridge.revalidateSession(target, requestContext);
    trash = await prepareTrash(bridge.config, session);
    const prior = bridge.handoff(session.id);
    // The delete lane can interrupt native EOF before draining the work lane.
    await bridge.withHandoff(session.id, { kind: 'delete' }, async () => {
      let finishDeletion;
      try {
        prior?.controller?.abort();
        finishDeletion = await bridge.pool.stopForDelete(session);
        await bridge.locked(session.id, async () => {
          await bridge.revalidateSession(session, requestContext);
          await trash.move();
        });
      } catch (error) {
        failure = error;
      } finally {
        await trash.cancel().catch(() => {});
        if (trash.moved) {
          bridge.completionSequences.delete(session.id);
          bridge.sessionFiles.delete(session.id);
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
    { project: target.cwd ?? null },
    resultBudget,
  );
}

function maintainSession(bridge, args, admission) {
  return args.action === 'reload'
    ? reloadSession(bridge, args, admission)
    : compactSession(bridge, args, admission);
}

export const mutations = {
  send: [sendPrompt, 'send', 'work'],
  command: [runCommand, 'command', 'bash'],
  maintain_session: [maintainSession, 'send', 'work'],
  update_session: [setSessionModel, 'send', 'work'],
  stop: [stopSession, 'stop', 'stop'],
  create_session: [createSession],
  delete_session: [deleteSession, 'delete', 'delete'],
};
