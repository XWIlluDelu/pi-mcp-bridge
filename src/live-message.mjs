// Ephemeral text/thinking observation only. Final native entries remain the
// authority; this is neither a transcript nor a provider-payload reconstruction.
const MAX_UNITS = 65536;
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
    if (event.type === 'agent_settled') {
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
      this.blocks.clear();
      event.message.content.forEach((block, index) => {
        if (block.type === 'text' || block.type === 'thinking')
          this.replace(index, block.type, block[block.type] ?? '');
      });
      return;
    }
    const update = event.assistantMessageEvent;
    if (
      !Number.isSafeInteger(update?.contentIndex) ||
      update.contentIndex < 0 ||
      update.contentIndex > 1024
    )
      return;
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
    let used = 0;
    for (const [key, value] of this.blocks) if (key !== index) used += value.text.length;
    const available = Math.max(0, MAX_UNITS - used),
      end = Math.min(text.length, available);
    // Avoid returning half of a surrogate pair at the observation memory cap.
    const safe =
      end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
    if (safe < text.length) this.truncated = true;
    this.blocks.set(index, { type, text: text.slice(0, safe) });
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
