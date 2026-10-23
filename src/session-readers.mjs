import { appendUnits, READ_CONTRACT } from './context-read.mjs';

// A distinct capability under the shared module lifecycle, not a replacement
// for input mappings. Each reader assesses the target session's own evidence.
export class SessionReaders {
  constructor() {
    this.readers = new Map();
  }
  register(id, reader) {
    if (
      typeof id !== 'string' ||
      !id ||
      this.readers.has(id) ||
      typeof reader?.matches !== 'function' ||
      typeof reader?.read !== 'function'
    )
      throw new Error('INVALID_SESSION_READER');
    const registration = { id, matches: reader.matches, read: reader.read };
    this.readers.set(id, registration);
    return () => {
      if (this.readers.get(id) === registration) this.readers.delete(id);
    };
  }
  async select(context) {
    const matches = [];
    try {
      for (const reader of this.readers.values())
        if (await reader.matches(context)) matches.push(reader);
    } catch (cause) {
      throw new Error('SESSION_READER_FAILED', { cause });
    }
    if (matches.length > 1) throw new Error('SESSION_READER_CONFLICT');
    return matches[0];
  }
}

export async function captureSessionRead(reader, context, args) {
  let messages;
  try {
    messages = await reader.read(context);
  } catch (cause) {
    throw new Error('SESSION_READER_FAILED', { cause });
  }
  if (!Array.isArray(messages)) throw new Error('INVALID_SESSION_READ');
  const target = { units: [], accountedBytes: 0 };
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message.role !== 'string') throw new Error('INVALID_SESSION_READ');
    appendUnits(target, { type: 'context', source: { reader_index: index }, message });
  }
  return {
    contract: READ_CONTRACT,
    view: 'adapted',
    reader: { id: reader.id },
    session_id: args.session_id,
    leaf_id: context.owner.leaf_id,
    selection: null,
    omissions: null,
    units: target.units,
    live: null,
  };
}
