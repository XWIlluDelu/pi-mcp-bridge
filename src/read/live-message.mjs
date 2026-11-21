// Ephemeral text/thinking observation only. Final native entries remain the
// authority; this is neither a transcript nor a provider-payload reconstruction.
const MAX_UNITS = 65536;
const BLOCK_OVERHEAD = 64;
export class LiveMessageObserver {
  constructor(source) {
    this.source = source;
    this.blocks = null;
    this.truncated = false;
    this.observedAt = null;
  }
  reset() {
    this.blocks = null;
    this.truncated = false;
    this.observedAt = new Date().toISOString();
  }
  update({ type, message }) {
    const role = message?.role;
    if (
      type === 'agent_start' ||
      type === 'agent_settled' ||
      (type === 'message_start' && role === 'user') ||
      (type === 'message_end' && role === 'assistant')
    )
      return this.reset();
    if (role !== 'assistant') return;
    if (type === 'message_start') {
      this.reset();
      this.blocks = [];
    } else if (type !== 'message_update' || !this.blocks) return;
    this.observedAt = new Date().toISOString();
    const { content } = message;
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
        if (text.codePointAt(start - 1) > 0xffff) start++;
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
      message: this.blocks
        ? { role: 'assistant', content: this.blocks.map((block) => ({ ...block })) }
        : null,
    };
  }
}
