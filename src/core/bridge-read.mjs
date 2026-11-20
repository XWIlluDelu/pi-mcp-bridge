import { loadModelCatalog } from '../ops/model-catalog.mjs';
import { ALL_CONTENT } from '../read/read-schema.mjs';
import { inside, permitted, permissionsHealth } from './permissions.mjs';
import { savedSessionName, runtimeMetadata } from '../read/session-metadata.mjs';
import { prepareContextRead } from '../read/context-read.mjs';
import { captureSessionRead } from '../compat/session-readers.mjs';
import { checkObservation, unavailableObservation } from '../read/context-observation.mjs';
import { readSessionIdentity, loadSavedSession, sameSessionIdentity } from './data.mjs';
import { PiRpc, launchProfile } from '../runtime/rpc.mjs';
import { nativeSdk } from '../runtime/pi-installation.mjs';
import { diagnostics } from './diagnostics.mjs';
import { ownerReadFeatures } from '../read/read-features.mjs';

// A read-only operation waits for an admitted auto-release to finish, then
// reselects the current owner under the same request policy.
export async function readableOwner(bridge, session, requestContext) {
  let runtime = await bridge.pool.forRead(session);
  while (runtime && bridge.handoffs.get(session.id)?.runtime === runtime) {
    await runtime.autoReleaseTask;
    bridge.assertOpen();
    session = await bridge.session(session.id, requestContext);
    bridge.check('read', session, requestContext);
    runtime = await bridge.pool.forRead(session);
  }
  return { session, runtime };
}

export async function acquireNativeRead(bridge, session, runtime, args) {
  if (runtime) return runtime.read(args);
  const sdk = await nativeSdk(bridge.config, launchProfile(bridge.config).env);
  session = await loadSavedSession(session, { omitImageData: true, sdk });
  return prepareContextRead(session, args, {
    buildSessionProjection: sdk.buildSessionProjection,
    readAdapters: bridge.compatibilityServices.readInputs.snapshot(),
  });
}

export async function listModels(bridge, args = {}, { requestContext } = {}) {
  requestContext = await (requestContext ?? bridge.captureRequestContext());
  bridge.assertOpen();
  const policy = requestContext.permissions;
  let allowed = requestContext.scope.folders.some((folder) =>
    ['send', 'command', 'create'].some((action) => permitted(policy, action, { cwd: folder.path })),
  );
  const mayExecuteSession = ['send', 'command'].some(
    (action) =>
      policy.defaults[action] === true || policy.grants.some((rule) => rule[action] === true),
  );
  if (!allowed && mayExecuteSession) {
    // folders configures creation targets, not the universe of native history.
    // Discover identity metadata once; no transcript or owner is acquired.
    allowed = (await bridge.sessions(requestContext)).some((session) =>
      ['send', 'command'].some((action) => permitted(policy, action, session)),
    );
  }
  diagnostics.emit('permission.check', { op: 'models', allowed });
  if (!allowed) throw new Error('NOT_FOUND_OR_DENIED');
  return loadModelCatalog(bridge.config, args);
}

export async function getSubmission(bridge, args, { requestContext } = {}) {
  requestContext = await (requestContext ?? bridge.captureRequestContext());
  bridge.assertOpen();
  const session = await bridge.session(args.session_id, requestContext);
  const policy = requestContext.permissions;
  const canInspect = permitted(policy, 'read', session) || permitted(policy, 'send', session);
  if (!canInspect && !permitted(policy, 'create', session)) throw new Error('NOT_FOUND_OR_DENIED');
  const record = bridge.submissions.get(session.id, args.submission_id);
  if (!canInspect && record.operation !== 'create') throw new Error('NOT_FOUND_OR_DENIED');
  return record;
}

export async function listSessions(bridge, args = {}, { requestContext } = {}) {
  requestContext = await (requestContext ?? bridge.captureRequestContext());
  bridge.assertOpen();
  const sessions = args.session_id
    ? await bridge.session(args.session_id, requestContext).then(
        (s) => [s],
        (error) => {
          if (error.message === 'NOT_FOUND_OR_DENIED') return [];
          throw error;
        },
      )
    : await bridge.sessions(requestContext);
  const matches = (value, query) => !query || (value ?? '').toLocaleLowerCase().includes(query);
  const project = args.project?.toLocaleLowerCase(),
    title = args.name?.toLocaleLowerCase(),
    after = args.active_after ? Date.parse(args.active_after) : -Infinity,
    before = args.active_before ? Date.parse(args.active_before) : Infinity;
  const candidates = sessions
    .filter(
      (session) =>
        session.mtimeMs >= after &&
        session.mtimeMs <= before &&
        matches(session.header.cwd, project) &&
        permitted(requestContext.permissions, 'list', session),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const offset = args.offset ?? 0,
    limit = args.limit ?? 30,
    selected = [];
  let matching = title ? 0 : offset,
    hasMore = false;
  const observations = new Map();
  const byFile = new Map(sessions.map((session) => [session.file, session]));
  // Poll just the requested page, or use a small lookahead when filtering by title.
  const observe = (start, count) => {
    for (const session of candidates.slice(start, start + count))
      if (!observations.has(session.id))
        observations.set(session.id, runtimeMetadata(bridge.pool, session));
  };
  if (!title) observe(offset, limit);
  for (let index = matching; index < candidates.length; index++) {
    if (!title && selected.length === limit) {
      hasMore = true;
      break;
    }
    if (title) observe(index, 4);
    const session = candidates[index];
    const observed = await observations.get(session.id);
    observations.delete(session.id);
    const name = Object.hasOwn(observed, 'name')
      ? observed.name
      : await savedSessionName(session, bridge.titleCache).catch(() => null);
    if (!matches(name, title) || matching++ < offset) continue;
    if (selected.length === limit) {
      hasMore = true;
      break;
    }
    const parentFile = session.header.parentSession;
    let parent = byFile.get(parentFile);
    if (
      args.session_id &&
      typeof parentFile === 'string' &&
      requestContext.scope.sessionRoots.some((root) => inside(parentFile, root))
    )
      parent = await readSessionIdentity(parentFile).catch(() => null);
    selected.push({
      session_id: session.id,
      project: session.header.cwd || null,
      name,
      parent_session_id:
        parent && permitted(requestContext.permissions, 'list', parent) ? parent.id : null,
      last_activity: new Date(session.mtimeMs).toISOString(),
      status: observed.status,
    });
  }
  return {
    sessions: selected,
    next_offset: hasMore ? offset + limit : null,
    // Project discovery is independent of existing sessions and their page.
    // Session-specific list grants do not disclose other creation targets.
    creatable_projects: requestContext.scope.folders
      .filter(({ path }) =>
        ['list', 'create'].every((action) =>
          permitted(requestContext.permissions, action, { cwd: path }),
        ),
      )
      .map(({ path }) => path),
  };
}

export async function getHealth(bridge, { session_id } = {}, { requestContext } = {}) {
  requestContext = await (requestContext ?? bridge.captureRequestContext());
  bridge.assertOpen();
  // Diagnose only the requested session, without its metadata or source paths.
  if (session_id) {
    const target = await bridge.session(session_id, requestContext).catch(() => ({
      id: session_id,
      cwd: null,
    }));
    return permissionsHealth(
      { ...requestContext.permissions, folders: requestContext.scope.folders },
      { session_id, cwd: target.cwd },
    );
  }
  return {
    ...permissionsHealth({
      ...requestContext.permissions,
      folders: requestContext.scope.folders,
    }),
    ...(requestContext.restartRequired?.length
      ? { restart_required: requestContext.restartRequired }
      : {}),
    ...(bridge.events.storeError ? { events: bridge.events.health() } : {}),
  };
}

export async function searchSession(bridge, { query, content, ...args }, options = {}) {
  const selected =
    content === undefined
      ? ALL_CONTENT
      : Object.fromEntries(
          Object.entries(ALL_CONTENT).map(([kind, value]) => [
            kind,
            content.includes(kind) ? value : typeof value === 'boolean' ? false : 0,
          ]),
        );
  return bridge.read(
    { ...args, content: selected, ...(args.view !== 'runtime' ? { range: { recent: -1 } } : {}) },
    { ...options, searchQuery: query },
  );
}

export async function readSession(
  bridge,
  args,
  { requestContext, resultBudget, readPins, searchQuery } = {},
) {
  requestContext = await (requestContext ?? bridge.captureRequestContext());
  bridge.assertOpen();
  // Routing metadata only. Cached content is accessed after authorization and
  // today's canonical path/native identity check; a cursor is never a grant.
  const id = bridge.readCache.target(args);
  let s = await bridge.session(id, requestContext);
  bridge.check('read', s, requestContext);
  const target = s;
  const identity = {
    session_id: id,
    file: s.file,
    native_id: s.header.id,
    native_cwd: s.header.cwd,
  };
  if (args.refs) {
    const snapshot = bridge.readCache.expand(args.refs, identity);
    if (snapshot.sourceRequest)
      return bridge.read(
        { ...snapshot.sourceRequest, max_bytes: args.max_bytes },
        { requestContext, resultBudget, readPins },
      );
    return bridge.readCache.render(
      snapshot,
      { max_bytes: args.max_bytes },
      { identity, resultBudget, readPins },
    );
  }
  if (args.cursor) {
    const captured = bridge.readCache.get(args, identity);
    return bridge.readCache.render(captured.snapshot, args, {
      ...captured,
      identity,
      resultBudget,
      readPins,
    });
  }
  args = { ...args, session_id: id };
  let runtime;
  ({ session: s, runtime } = await readableOwner(bridge, s, requestContext));
  diagnostics.emit('read.source', {
    kind: runtime ? (runtime.attached ? 'attached' : 'rpc') : 'saved',
  });
  let captured,
    retained = false;
  if (args.view === 'runtime') {
    captured =
      runtime?.attached || (runtime instanceof PiRpc && runtime.ownerRecord)
        ? await runtime.read(args)
        : runtime
          ? unavailableObservation(id, 'runtime_observer_unavailable')
          : bridge.pool.observations.get(s);
    retained = !runtime;
  } else {
    const nativeRead = ({ entry_ids } = {}) =>
      bridge.acquireNativeRead(s, runtime, {
        ...args,
        view: 'session',
        ...(entry_ids !== undefined ? { entry_ids } : {}),
        ...(searchQuery ? { search_query: searchQuery } : {}),
      });
    const acquire = async () => {
      // Only an explicit view selects a source. Modules assess session-local
      // evidence even without a live owner; reading never starts Pi.
      if (bridge.compatibilityServices.sessionReaders.readers.size && args.view !== 'session') {
        const context = {
          session: Object.freeze({
            id,
            file: s.file,
            native_id: s.header.id,
            cwd: s.header.cwd,
          }),
          owner: await ownerReadFeatures(runtime),
          request: args,
          nativeRead,
        };
        const reader = await bridge.compatibilityServices.sessionReaders.select(context);
        if (reader) return captureSessionRead(reader, context, args, searchQuery);
      }
      return nativeRead();
    };
    captured = runtime instanceof PiRpc ? await runtime.observeRead(acquire) : await acquire();
  }
  const runtimeObservation = runtime && captured.view === 'runtime' ? captured : null;
  let currentLeaf;
  if (runtimeObservation?.observation.reason === 'no_observation') {
    const previous = bridge.pool.observations.get(s);
    if (previous.observation.available) {
      currentLeaf = runtimeObservation.observation.current_leaf_id;
      captured = previous;
      retained = true;
    }
  }
  if (retained && captured.observation.available) {
    s = await loadSavedSession(s, { omitImageData: true, config: bridge.config });
    captured = checkObservation(captured, runtime ? { ...s, leafId: currentLeaf } : s, {
      ownerActive: false,
    });
  }
  const current = await bridge.session(id, requestContext);
  if (!sameSessionIdentity(current, target)) throw new Error('RUNTIME_SESSION_CHANGED');
  bridge.check('read', current, requestContext);
  if (
    runtimeObservation &&
    runtime?.alive &&
    !runtime.handoffPending &&
    bridge.pool.instances.get(id) === runtime
  )
    bridge.pool.observations.put(current, runtimeObservation, runtime);
  const live = searchQuery ? null : captured.live,
    snapshot = {
      session_id: id,
      view: captured.view,
      ...(captured.observation ? { observation: captured.observation } : {}),
      ...(captured.reader ? { reader: captured.reader } : {}),
      request: args,
      leaf_id: captured.leaf_id,
      selection: captured.selection,
      omissions: captured.omissions,
      ...(captured.history ? { history: captured.history } : {}),
      units: captured.units,
      source: retained
        ? 'retained'
        : runtime
          ? runtime.attached
            ? runtime.record.kind
            : 'rpc'
          : 'saved',
    };
  const runtimeEvents =
    !searchQuery && (runtime?.runtimeEvents ?? bridge.pool.runtimeEvents.get(id))?.snapshot();
  return bridge.readCache.navigate(
    snapshot,
    args,
    { identity, resultBudget, live, runtimeEvents, readPins },
    searchQuery,
  );
}
