// Ephemeral text/thinking observation only. Final native entries remain the
// authority; this is neither a transcript nor a provider-payload reconstruction.
const MAX_UNITS = 65536;
const BLOCK_OVERHEAD = 64;
export class LiveMessageObserver {
  constructor(source) {
    this.source = source;
    this.blocks = new Map();
    this.active = false;
    this.truncated = false;
    this.observedAt = null;
  }
  reset() {
    this.blocks.clear();
    this.active = false;
    this.truncated = false;
    this.observedAt = new Date().toISOString();
  }
  update(event) {
    if (
      event.type === 'agent_start' ||
      event.type === 'agent_settled' ||
      (event.type === 'message_start' && event.message?.role === 'user')
    ) {
      this.reset();
      return;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      this.reset();
      return;
    }
    if (event.type === 'message_start') {
      if (event.message?.role !== 'assistant') return;
      this.reset();
      this.active = true;
    }
    if (event.type !== 'message_start' && event.type !== 'message_update') return;
    if (!this.active) return; // Ignore deltas from a stream we did not observe start.
    this.observedAt = new Date().toISOString();
    if (event.message?.role === 'assistant' && Array.isArray(event.message.content)) {
      const content = event.message.content;
      // Cumulative snapshots are already in native order. Walk the tail once
      // rather than sorting/pruning the growing map after every block.
      this.retain(
        (function* () {
          for (let index = content.length - 1; index >= 0; index--) {
            const block = content[index],
              text = block[block.type] ?? '';
            if (['text', 'thinking'].includes(block.type) && typeof text === 'string')
              yield [index, { type: block.type, text }];
          }
        })(),
      );
      return;
    }
    const update = event.assistantMessageEvent;
    if (!Number.isSafeInteger(update?.contentIndex) || update.contentIndex < 0) return;
    const kind = update.type?.startsWith('text_')
      ? 'text'
      : update.type?.startsWith('thinking_')
        ? 'thinking'
        : null;
    if (!kind) return;
    const index = update.contentIndex;
    if (update.type.endsWith('_start')) this.replace(index, kind, '');
    else if (update.type.endsWith('_end') && typeof update.content === 'string')
      this.replace(index, kind, update.content);
    else if (update.type.endsWith('_delta') && typeof update.delta === 'string') {
      const previous = this.blocks.get(index);
      this.replace(index, kind, (previous?.text ?? '') + update.delta);
    }
  }
  replace(index, type, text) {
    if (typeof text !== 'string') return;
    this.blocks.set(index, { type, text });
    this.retain([...this.blocks].sort(([a], [b]) => b - a));
  }
  retain(entries) {
    const retained = new Map();
    let remaining = MAX_UNITS;
    for (const [index, block] of entries) {
      // Charge block metadata as well as text: even empty blocks consume space.
      const allowance = remaining - BLOCK_OVERHEAD;
      if (allowance < 0 || (!allowance && block.text.length)) {
        this.truncated = true;
        break;
      }
      let text = block.text;
      if (text.length > allowance) {
        this.truncated = true;
        let start = text.length - allowance;
        if (
          start > 0 &&
          /[\uDC00-\uDFFF]/.test(text[start]) &&
          /[\uD800-\uDBFF]/.test(text[start - 1])
        )
          start++;
        // Detach the tail from the growing cumulative message's backing string.
        text = structuredClone(text.slice(start));
      }
      retained.set(index, { type: block.type, text });
      remaining -= BLOCK_OVERHEAD + text.length;
    }
    this.blocks = retained;
  }
  snapshot() {
    return {
      available: true,
      source: this.source,
      observed_at: this.observedAt,
      transient: true,
      truncated: this.truncated,
      message: this.active
        ? {
            role: 'assistant',
            content: [...this.blocks]
              .sort((a, b) => a[0] - b[0])
              .map(([index, block]) => ({
                index,
                type: block.type,
                [block.type]: block.text,
              })),
          }
        : null,
    };
  }
}
