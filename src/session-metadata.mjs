import { withSessionFile, fileRevision } from './data.mjs';
import { uiSnapshot } from './rpc-ui.mjs';
import { modelState } from './models.mjs';
import { scanSavedLines } from './lf-lines.mjs';

// Metadata scanning retains at most one JSONL record, never a second full history.
export async function savedSessionName(session, cache) {
  const previous = cache.get(session.file);
  if (previous?.signature === session.fileRevision) return previous.name;
  return withSessionFile(session.file, async (fd, stat) => {
    // Bind the title to the same inode and revision as the authorized list row.
    if (fileRevision(stat) !== session.fileRevision) return null;
    let name = null;
    const stream = fd.createReadStream({ encoding: 'utf8', autoClose: false, end: stat.size - 1 });
    await scanSavedLines(stream, (line) => {
      if (!line.includes('"session_info"')) return;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_info')
          name = typeof entry.name === 'string' ? entry.name.trim() || null : null;
      } catch {
        // A writer may still be finishing its last record.
      }
    });
    if (fileRevision(await fd.stat()) !== session.fileRevision) return null;
    if ((name?.length ?? 0) <= 4096) {
      cache.delete(session.file);
      cache.set(session.file, { signature: session.fileRevision, name });
      if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    return name;
  });
}

function runtimeCapabilities(runtime, state) {
  if (runtime.attached) {
    const host = runtime.record?.kind === 'host';
    const { command, stop } = state.capabilities ?? {};
    // Companions and hosts require a send path. Optional host controls must be
    // declared by the owner; AttachedRuntime's wrappers do not prove support.
    return {
      send: true,
      reload: runtime.record?.reloadSupported === true,
      command: host ? (typeof command === 'boolean' ? command : null) : false,
      stop: host ? (typeof stop === 'boolean' ? stop : null) : false,
    };
  }
  // Bridge-owned RPC implements every control natively.
  return { send: true, reload: true, command: true, stop: true };
}

export async function runtimeMetadata(pool, session) {
  const observed_at = new Date().toISOString();
  const inactive = (state) => ({
    status: { state, observed_at, pending_messages: null, model: null, thinking_level: null },
  });
  try {
    const runtime = await pool.forRead(session);
    if (!runtime) return inactive('saved');
    const { state, status, pending } = await runtime.idleSnapshot();
    const selection = modelState(state);
    return {
      ...(Object.hasOwn(state, 'sessionName') || runtime.ownerRecord?.kind === 'rpc'
        ? { name: typeof state.sessionName === 'string' ? state.sessionName.trim() || null : null }
        : {}),
      status: {
        state: status,
        observed_at,
        pending_messages: pending,
        model: selection.model,
        thinking_level: selection.thinkingLevel,
        ...uiSnapshot(runtime.uiFacts),
        capabilities: runtimeCapabilities(runtime, state),
      },
    };
  } catch {
    return inactive('unavailable');
  }
}
