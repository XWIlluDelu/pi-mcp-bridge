import { loadModelCatalog } from '../ops/model-catalog.mjs';
import { ALL_CONTENT } from '../read/read-schema.mjs';
import { inside, permitted, permissionsHealth } from './permissions.mjs';
import { savedSessionName, runtimeMetadata } from '../read/session-metadata.mjs';
import { prepareContextRead } from '../read/context-read.mjs';
import { captureSessionRead } from '../compat/session-readers.mjs';
import { checkObservation, unavailableObservation } from '../read/context-observation.mjs';
import { readSessionIdentity, loadSavedSession } from './data.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import { launchProfile, nativeSdk } from '../runtime/pi-installation.mjs';
import { diagnostics } from './diagnostics.mjs';
import { nativeReadFeatures } from '../read/read-features.mjs';
import { pick } from '../read/read-render.mjs';

// A read-only operation waits for an admitted auto-release to finish, then
// reselects the current owner under the same request policy.
export async function readableOwner(bridge, session, requestContext) {
  for (;;) {
    const runtime = await bridge.pool.forRead(session);
    if (!runtime || bridge.handoff(session.id)?.runtime !== runtime) return { session, runtime };
    await runtime.autoReleaseTask;
    bridge.assertOpen();
    session = await bridge.authorizedSession('read', session.id, requestContext);
  }
}

async function acquireNativeRead(bridge, session, runtime, args) {
  if (runtime) return runtime.read(args);
  const sdk = await nativeSdk(bridge.config, launchProfile(bridge.config).env);
  session = await loadSavedSession(session, { omitImageData: true, sdk });
  return prepareContextRead(session, args, {
    buildSessionProjection: sdk.buildSessionProjection,
    readAdapters: bridge.compatibilityServices.readInputs.snapshot(),
  });
}

async function listModels(bridge, args = {}, { requestContext }) {
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

async function getSubmission(bridge, args, { requestContext }) {
  const session = await bridge.session(args.session_id, requestContext);
  const policy = requestContext.permissions;
  const canInspect = permitted(policy, 'read', session) || permitted(policy, 'send', session);
  if (!canInspect && !permitted(policy, 'create', session)) throw new Error('NOT_FOUND_OR_DENIED');
  const record = bridge.submissions.get(session.id, args.submission_id);
  if (!canInspect && record.operation !== 'create') throw new Error('NOT_FOUND_OR_DENIED');
  return record;
}

async function listSessions(bridge, args = {}, { requestContext }) {
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
    page = title ? candidates : candidates.slice(offset, offset + limit),
    selected = [];
  let matching = 0,
    hasMore = !title && candidates.length > offset + limit;
  const byFile = new Map(sessions.map((session) => [session.file, session]));
  // Poll just the requested page, or use a small lookahead when filtering by title.
  const observe = (session) => runtimeMetadata(bridge.pool, session);
  const pending = page.slice(0, title ? 4 : limit).map(observe);
  for (const [index, session] of page.entries()) {
    if (title && index && page[index + 3]) pending.push(observe(page[index + 3]));
    const observed = await pending.shift();
    const name = Object.hasOwn(observed, 'name')
      ? observed.name
      : await savedSessionName(session, bridge.titleCache).catch(() => null);
    if (title && (!matches(name, title) || matching++ < offset)) continue;
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

async function getHealth(bridge, { session_id } = {}, { requestContext }) {
  const policy = { ...requestContext.permissions, folders: requestContext.scope.folders };
  // Diagnose only the requested session, without its metadata or source paths.
  if (session_id) {
    const target = await bridge.session(session_id, requestContext).catch(() => ({
      id: session_id,
      cwd: null,
    }));
    return permissionsHealth(policy, { session_id, cwd: target.cwd });
  }
  return {
    ...permissionsHealth(policy),
    ...(requestContext.restartRequired?.length
      ? { restart_required: requestContext.restartRequired }
      : {}),
    ...(bridge.events.storeError ? { events: bridge.events.health() } : {}),
  };
}

async function searchSession(bridge, { query, content, ...args }, options = {}) {
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

async function readSession(bridge, args, { requestContext, resultBudget, readPins, searchQuery }) {
  // Routing metadata only. Cached content is accessed after authorization and
  // today's canonical path/native identity check; a cursor is never a grant.
  const id = bridge.readCache.target(args);
  const target = await bridge.authorizedSession('read', id, requestContext);
  const identity = {
    session_id: id,
    file: target.file,
    native_id: target.header.id,
    native_cwd: target.header.cwd,
  };
  const renderOptions = { identity, resultBudget, readPins };
  if (args.refs) {
    const snapshot = bridge.readCache.expand(args.refs, identity);
    if (snapshot.sourceRequest)
      return bridge.read(
        { ...snapshot.sourceRequest, max_bytes: args.max_bytes },
        { requestContext, resultBudget, readPins },
      );
    return bridge.readCache.render(snapshot, { max_bytes: args.max_bytes }, renderOptions);
  }
  if (args.cursor) {
    const captured = bridge.readCache.get(args, identity);
    return bridge.readCache.render(captured.snapshot, args, { ...captured, ...renderOptions });
  }
  args = { ...args, session_id: id };
  const { session: s, runtime } = await readableOwner(bridge, target, requestContext);
  const kind = runtime ? (runtime.attached ? 'attached' : 'rpc') : 'saved';
  diagnostics.emit('read.source', { kind });
  let captured,
    runtimeObservation,
    retained = false;
  if (args.view === 'runtime') {
    if (runtime)
      runtimeObservation =
        runtime.attached || (runtime instanceof PiRpc && runtime.ownerRecord)
          ? await runtime.read(args)
          : unavailableObservation(id, 'runtime_observer_unavailable');
    captured = runtimeObservation;
    if (!captured || captured.observation.reason === 'no_observation') {
      const previous = bridge.pool.observations.get(s);
      if (!captured || previous.observation.available) {
        captured = previous;
        retained = true;
      }
    }
    if (retained && captured.observation.available) {
      const saved = await loadSavedSession(s, { omitImageData: true, config: bridge.config });
      if (runtimeObservation) saved.leafId = runtimeObservation.observation.current_leaf_id;
      captured = checkObservation(captured, saved, { ownerActive: false });
    }
  } else {
    const nativeRead = ({ entry_ids } = {}) =>
      acquireNativeRead(bridge, s, runtime, {
        ...args,
        view: 'session',
        ...(entry_ids !== undefined ? { entry_ids } : {}),
        ...(searchQuery ? { search_query: searchQuery } : {}),
      });
    const readers = bridge.compatibilityServices.sessionReaders;
    if (args.view === 'session' || !readers.readers.size) captured = await nativeRead();
    else {
      const acquire = async () => {
        const context = {
          session: Object.freeze({ id, file: s.file, native_id: s.header.id, cwd: s.header.cwd }),
          owner: runtime ? await runtime.readFeatures() : nativeReadFeatures(),
          request: args,
          nativeRead,
        };
        const reader = await readers.select(context);
        return reader ? captureSessionRead(reader, context, args, searchQuery) : nativeRead();
      };
      // Keep the owner through feature discovery and the reader's full capture.
      captured = runtime instanceof PiRpc ? await runtime.observeRead(acquire) : await acquire();
    }
  }
  const current = await bridge.revalidateSession(target, requestContext);
  if (
    runtimeObservation &&
    (runtime.attached || runtime.alive) &&
    !runtime.handoffPending &&
    bridge.pool.instances.get(id) === runtime
  )
    bridge.pool.observations.put(current, runtimeObservation, runtime);
  const live = searchQuery ? null : captured.live,
    snapshot = {
      session_id: id,
      ...pick(captured, [
        'view',
        'observation',
        'reader',
        'leaf_id',
        'selection',
        'omissions',
        'history',
        'units',
      ]),
      source: retained ? 'retained' : runtime?.attached ? runtime.record.kind : kind,
    };
  const runtimeEvents =
    !searchQuery && (runtime?.runtimeEvents ?? bridge.pool.runtimeEvents.get(id))?.snapshot();
  return bridge.readCache.navigate(
    snapshot,
    args,
    { ...renderOptions, live, runtimeEvents },
    searchQuery,
  );
}

export const queries = {
  list: listSessions,
  read: readSession,
  search: searchSession,
  models: listModels,
  health: getHealth,
  submission: getSubmission,
};
