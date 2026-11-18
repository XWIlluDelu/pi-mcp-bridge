import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { uiSnapshot } from './rpc-ui.mjs';
import { modelState } from './models.mjs';
import { scanSavedLines } from './lf-lines.mjs';

// Metadata scanning retains at most one JSONL record, never a second full history.
export async function savedSessionName(session, cache) {
  const stat = await fs.stat(session.file);
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const previous = cache?.get(session.file);
  if (previous?.signature === signature) return previous.name;
  let name = null;
  await scanSavedLines(createReadStream(session.file, { encoding: 'utf8' }), (line) => {
    // Metadata is authorized by list, not read. Ignore incomplete/corrupt body
    // records here; content reads validate identity and the selected branch.
    if (!line.includes('"session_info"')) return;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session_info')
        name = typeof entry.name === 'string' ? entry.name.trim() || null : null;
    } catch {
      /* A live writer may still be finishing the final record. */
    }
  });
  // Bound retained names, not the accepted name or history size. No transcript
  // bytes enter this cache; append, replacement and truncation invalidate it.
  if (cache && (name?.length ?? 0) <= 4096) {
    cache.delete(session.file);
    cache.set(session.file, { signature, name });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  return name;
}

function runtimeCapabilities(runtime, state) {
  if (runtime.attached) {
    const host = runtime.record?.kind === 'host';
    // Companions and hosts require a send path. Optional host controls must be
    // declared by the owner; AttachedRuntime's wrappers do not prove support.
    return {
      send: true,
      reload: runtime.record?.reloadSupported === true,
      command: host ? state.capabilities.command : false,
      stop: host ? state.capabilities.stop : false,
    };
  }
  // Bridge-owned RPC implements every control natively.
  return { send: true, reload: true, command: true, stop: true };
}

export async function runtimeMetadata(pool, session) {
  const observed_at = new Date().toISOString();
  try {
    const runtime = await pool.forRead(session);
    if (!runtime)
      return {
        status: {
          state: 'saved',
          observed_at,
          pending_messages: null,
          model: null,
          thinking_level: null,
        },
      };
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
    return {
      status: {
        state: 'unavailable',
        observed_at,
        pending_messages: null,
        model: null,
        thinking_level: null,
      },
    };
  }
}
