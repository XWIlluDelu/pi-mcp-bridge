import path from 'node:path';

export const ACTIONS = ['list', 'read', 'send', 'command', 'stop', 'create', 'delete'];

export function inside(file, folder) {
  const relative = path.relative(path.resolve(folder), path.resolve(file));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

// Specificity wins before recency. A null value removes this scope's override.
// Project rules cover their descendants; the longest matching path wins.
export function resolvePermission(config, action, target = {}) {
  if (!ACTIONS.includes(action)) return { allowed: false, explicit: undefined, sourceScope: null };
  const cwd = target.cwd ?? target.folder;
  const directory = typeof cwd === 'string' ? path.resolve(cwd) : null;
  const ancestors = new Map();
  for (let folder = directory; folder;) {
    ancestors.set(folder, undefined);
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  let explicit = target.session_id || directory ? undefined : config.defaults?.[action];
  for (const rule of config.grants ?? []) {
    if (!Object.hasOwn(rule, action)) continue;
    if (rule.session_id) {
      if (rule.session_id === target.session_id) explicit = rule[action];
    } else if (directory) {
      const folder = path.resolve(rule.folder);
      if (ancestors.has(folder)) ancestors.set(folder, rule[action]);
    }
  }
  if (target.session_id && action !== 'create' && typeof explicit === 'boolean')
    return { allowed: explicit, explicit, sourceScope: { session_id: target.session_id } };
  if (!target.session_id && directory) explicit = ancestors.get(directory);
  for (const [folder, value] of ancestors) {
    if (typeof value === 'boolean') return { allowed: value, explicit, sourceScope: { folder } };
  }
  return { allowed: config.defaults?.[action] === true, explicit, sourceScope: { default: true } };
}

export function permitted(config, action, session) {
  return resolvePermission(config, action, {
    session_id: session.id,
    cwd: session.cwd,
  }).allowed;
}

// Diagnostics do not add dependencies between permissions or change admission.
function permissionWarnings(config, target = {}) {
  const effective = Object.fromEntries(
    ACTIONS.map((action) => [action, resolvePermission(config, action, target)]),
  );
  const allow = (action) => effective[action].allowed;
  const warnings = [];
  const add = (code, message, actions) =>
    warnings.push({
      code,
      message,
      evidence: Object.fromEntries(actions.map((action) => [action, effective[action]])),
    });
  const known = ['read', 'send', 'command', 'stop', 'delete'].filter(allow);
  const work = ['send', 'command'].filter(allow);
  if (!allow('list') && known.length)
    add(
      'KNOWN_ID_ONLY',
      'Other operations are allowed, but sessions cannot be discovered by listing.',
      ['list', ...known],
    );
  if (!allow('read') && work.length)
    add('NO_PROGRESS_READ', 'Work can be submitted, but its conversation history cannot be read.', [
      'read',
      ...work,
    ]);
  const started = [...work, ...(!target.session_id && allow('create') ? ['create'] : [])];
  if (!allow('stop') && started.length)
    add('NO_REMOTE_STOP', 'Work can be started, but this client cannot stop it.', [
      'stop',
      ...started,
    ]);
  if (!target.session_id && allow('create')) {
    const missing = ['list', 'read', 'send'].filter((action) => !allow(action));
    if (missing.length)
      add(
        'LIMITED_NEW_SESSION_ACCESS',
        `New sessions inherit restrictions on: ${missing.join(', ')}.`,
        ['create', ...missing],
      );
  }
  if (allow('send') && !allow('command'))
    add(
      'MODEL_TOOLS_ARE_SEPARATE',
      'Blocking the direct command endpoint does not disable shell tools available to Pi itself.',
      ['send', 'command'],
    );
  return warnings;
}

export function permissionsHealth(config, target) {
  const reports = target
    ? [permissionWarnings(config, target)]
    : [
        permissionWarnings(config),
        ...config.folders.map(({ path }) => permissionWarnings(config, { folder: path })),
      ];
  const issues = new Map();
  for (const warning of reports.flat()) {
    const evidence = Object.fromEntries(
      Object.entries(warning.evidence).map(([action, value]) => [
        action,
        {
          allowed: value.allowed,
          source: target?.session_id
            ? value.sourceScope?.session_id
              ? 'session'
              : value.sourceScope?.folder
                ? 'project'
                : 'default'
            : value.sourceScope,
        },
      ]),
    );
    const folder = Object.values(evidence)
      .map((value) => value.source?.folder)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];
    const issue = {
      code: warning.code,
      message: warning.message,
      scope: target?.session_id
        ? { session_id: target.session_id }
        : folder
          ? { folder }
          : { default: true },
      evidence,
    };
    // Inherited combinations point to their source rules once, not every project.
    issues.set(JSON.stringify(issue), issue);
  }
  return {
    domain: 'permissions',
    status: issues.size ? 'warning' : 'ok',
    ...(issues.size ? { issues: [...issues.values()] } : {}),
  };
}
