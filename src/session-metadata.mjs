import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { uiSnapshot } from './rpc-ui.mjs';
import { modelState } from './models.mjs';

// Metadata scanning retains at most one JSONL record, never a second full history.
export async function sessionMetadata(session, cache) {
  const stat = await fs.stat(session.file);
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const previous = cache?.get(session.file);
  if (previous?.signature === signature) return previous.metadata;
  let name = null,
    fragments = [];
  const consume = (line) => {
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
  };
  for await (const chunk of createReadStream(session.file, { encoding: 'utf8' })) {
    let start = 0,
      end;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      fragments.push(chunk.slice(start, end));
      consume(fragments.join(''));
      fragments = [];
      start = end + 1;
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
  }
  if (fragments.length) consume(fragments.join(''));
  const metadata = { name, last_activity: new Date(stat.mtimeMs).toISOString() };
  // Bound retained names, not the accepted name or history size. No transcript
  // bytes enter this cache; append, replacement and truncation invalidate it.
  if (cache && (name?.length ?? 0) <= 4096) {
    cache.delete(session.file);
    cache.set(session.file, { signature, metadata });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  return metadata;
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
  return {
    send: typeof runtime.command === 'function',
    reload: runtime.ownerRecord?.kind === 'rpc',
    command: typeof runtime.executeBash === 'function',
    stop: typeof runtime.stopExecution === 'function',
  };
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
    const state = await runtime.state();
    const selection = modelState(state);
    const pending = state.pendingMessageCount ?? state.activity?.pending_message_count;
    const count = Number.isSafeInteger(pending) && pending >= 0 ? pending : null;
    const busy =
      runtime.promptAdmission ||
      runtime.hasUnsettledWork?.() ||
      state.isBashRunning === true ||
      state.isStreaming ||
      state.isCompacting ||
      state.isIdle === false ||
      state.hasPendingMessages === true ||
      state.activity?.idle === false ||
      state.activity?.streaming === true ||
      state.activity?.compacting === true ||
      state.activity?.pending_messages === true ||
      count > 0;
    // Native RPC get_state alone does not prove idle during input preparation.
    const idle = (state.isIdle === true || state.activity?.idle === true) && !busy;
    return {
      ...(Object.hasOwn(state, 'sessionName') || runtime.ownerRecord?.kind === 'rpc'
        ? { name: typeof state.sessionName === 'string' ? state.sessionName.trim() || null : null }
        : {}),
      status: {
        state: busy ? 'busy' : idle ? 'idle' : 'unknown',
        observed_at,
        pending_messages: count,
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
