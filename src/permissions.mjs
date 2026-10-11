import path from 'node:path';
export const ACTIONS = ['read', 'send', 'delete', 'new_session'];
export function inside(file, folder) {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
// Owner-only configuration. Later rules replace individual fields at the same scope.
// null means unset/inherit. Specificity wins before recency.
export function resolvePermission(config, action, target) {
  if (!ACTIONS.includes(action)) return {allowed:false,explicit:undefined,sourceScope:null};
  const scopes = new Map();
  for (const rule of config.grants ?? []) {
    if (!Object.hasOwn(rule, action)) continue;
    const key = rule.session_id ? `session:${rule.session_id}` : `folder:${path.resolve(rule.folder)}`;
    scopes.set(key, rule[action]);
  }
  const ownKey=target.session_id?`session:${target.session_id}`:`folder:${path.resolve(target.folder??target.cwd)}`;
  const explicit=scopes.get(ownKey);
  if (action !== 'new_session' && target.session_id) {
    const value = scopes.get(`session:${target.session_id}`);
    if (typeof value === 'boolean') return {allowed:value,explicit,sourceScope:{session_id:target.session_id}};
  }
  const ancestors = [...scopes].filter(([key]) => key.startsWith('folder:') && inside(target.cwd??target.folder, key.slice(7)))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of ancestors) if (typeof value === 'boolean') return {allowed:value,explicit,sourceScope:{folder:key.slice(7)}};
  return {allowed:false,explicit,sourceScope:null};
}
export function permitted(config, action, session) {
  return resolvePermission(config,action,{session_id:session.id,cwd:session.cwd}).allowed;
}
