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
  const scopes = new Map();
  for (const rule of config.grants ?? []) {
    if (!Object.hasOwn(rule, action)) continue;
    const key = rule.session_id
      ? `session:${rule.session_id}`
      : `folder:${path.resolve(rule.folder)}`;
    scopes.set(key, rule[action]);
  }
  const directory = target.cwd ?? target.folder;
  const ownKey = target.session_id
    ? `session:${target.session_id}`
    : typeof directory === 'string'
      ? `folder:${path.resolve(directory)}`
      : null;
  const explicit = ownKey ? scopes.get(ownKey) : config.defaults?.[action];
  if (action !== 'create' && target.session_id) {
    const value = scopes.get(`session:${target.session_id}`);
    if (typeof value === 'boolean')
      return { allowed: value, explicit, sourceScope: { session_id: target.session_id } };
  }
  const ancestors = [...scopes]
    .filter(
      ([key]) =>
        key.startsWith('folder:') &&
        typeof directory === 'string' &&
        inside(directory, key.slice(7)),
    )
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of ancestors) {
    if (typeof value === 'boolean')
      return { allowed: value, explicit, sourceScope: { folder: key.slice(7) } };
  }
  return { allowed: config.defaults?.[action] === true, explicit, sourceScope: { default: true } };
}

export function permitted(config, action, session) {
  return resolvePermission(config, action, { session_id: session.id, cwd: session.cwd }).allowed;
}

// Diagnostics do not add dependencies between permissions or change admission.
export function permissionWarnings(config, target = {}) {
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
  return { warnings };
}

export function permissionsHealth(config, target) {
  const reports = target
    ? [permissionWarnings(config, target)]
    : [
        permissionWarnings(config),
        ...config.folders.map(({ path }) => permissionWarnings(config, { folder: path })),
      ];
  const issues = new Map();
  for (const { warnings } of reports) {
    for (const warning of warnings) {
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
  }
  return {
    domain: 'permissions',
    status: issues.size ? 'warning' : 'ok',
    ...(issues.size ? { issues: [...issues.values()] } : {}),
  };
}
