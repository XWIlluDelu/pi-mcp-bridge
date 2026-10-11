import path from 'node:path';
export const ACTIONS = ['read', 'send', 'delete', 'new_session'];
export function inside(file, folder) {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
// Owner-only configuration. Later rules replace individual fields at the same scope.
// null means unset/inherit. Specificity wins before recency.
export function permitted(config, action, session) {
  if (!ACTIONS.includes(action)) return false;
  const scopes = new Map();
  for (const rule of config.grants ?? []) {
    if (!Object.hasOwn(rule, action)) continue;
    const key = rule.session_id ? `session:${rule.session_id}` : `folder:${path.resolve(rule.folder)}`;
    scopes.set(key, rule[action]);
  }
  if (action !== 'new_session' && session.id) {
    const value = scopes.get(`session:${session.id}`);
    if (typeof value === 'boolean') return value;
  }
  const ancestors = [...scopes].filter(([key]) => key.startsWith('folder:') && inside(session.cwd, key.slice(7)))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [, value] of ancestors) if (typeof value === 'boolean') return value;
  return false;
}
