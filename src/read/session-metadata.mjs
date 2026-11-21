import { withSessionFile, fileRevision } from '../core/data.mjs';
import { uiSnapshot } from '../runtime/rpc-ui.mjs';
import { modelState } from '../ops/models.mjs';
import { scanSavedLines } from '../core/lf-lines.mjs';

// Metadata scanning retains at most one JSONL record, never a second full history.
export async function savedSessionName(session, cache) {
  const previous = cache.get(session.file);
  if (previous?.signature === session.fileRevision) return previous.name;
  return withSessionFile(session.file, async (fd, stat) => {
    // Bind the title to the same inode and revision as the authorized list row.
    if (fileRevision(stat) !== session.fileRevision) return null;
    let name = null;
    const stream = fd.createReadStream({ autoClose: false, end: stat.size - 1 });
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
      stop: typeof stop === 'boolean' ? stop : host ? null : false,
    };
  }
  // Bridge-owned RPC implements every control natively.
  return { send: true, reload: true, command: true, stop: true };
}

function sanitizeContextUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokens =
    Number.isFinite(usage.tokens) && usage.tokens >= 0 ? Math.round(usage.tokens) : null;
  const context_window =
    Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? Math.round(usage.contextWindow)
      : null;
  const percent =
    Number.isFinite(usage.percent) && usage.percent >= 0
      ? Math.round(usage.percent * 10) / 10
      : null;
  if (tokens === null && context_window === null && percent === null) return null;
  return { tokens, context_window, percent };
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
    const context_usage = sanitizeContextUsage(state.contextUsage);
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
        ...(context_usage ? { context_usage } : {}),
        ...uiSnapshot(runtime.uiFacts),
        capabilities: runtimeCapabilities(runtime, state),
      },
    };
  } catch {
    return inactive('unavailable');
  }
}
