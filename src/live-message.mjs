// Ephemeral text/thinking observation only. Final native entries remain the
// authority; this is neither a transcript nor a provider-payload reconstruction.
const MAX_UNITS = 65536;
const BLOCK_OVERHEAD = 64;
export class LiveMessageObserver {
  constructor(source) {
    this.source = source;
    this.blocks = [];
    this.active = false;
    this.truncated = false;
    this.observedAt = null;
  }
  reset() {
    this.blocks = [];
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
    if (!this.active || event.message?.role !== 'assistant') return;
    this.observedAt = new Date().toISOString();
    const content = event.message.content;
    if (!Array.isArray(content)) return;
    const retained = [];
    let remaining = MAX_UNITS;
    for (let index = content.length - 1; index >= 0; index--) {
      const block = content[index];
      if (block.type !== 'text' && block.type !== 'thinking') continue;
      const value = block[block.type] ?? '';
      if (typeof value !== 'string') continue;
      // Charge block metadata as well as text: even empty blocks consume space.
      const allowance = remaining - BLOCK_OVERHEAD;
      if (allowance < 0 || (!allowance && value.length)) {
        this.truncated = true;
        break;
      }
      let text = value;
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
      retained.push({ index, type: block.type, [block.type]: text });
      remaining -= BLOCK_OVERHEAD + text.length;
    }
    this.blocks = retained.reverse();
  }
  snapshot() {
    return {
      available: true,
      source: this.source,
      observed_at: this.observedAt,
      transient: true,
      truncated: this.truncated,
      message: this.active
        ? { role: 'assistant', content: this.blocks.map((block) => ({ ...block })) }
        : null,
    };
  }
}
