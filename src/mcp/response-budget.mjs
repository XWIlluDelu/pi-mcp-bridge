// UTF-8 wire bounds are separate from selectors and structured read budgets.
export const MCP_RESPONSE_LIMIT = 256 * 1024;
// A 1024-byte request ID may escape to 6144 JSON bytes. Also reserve modern
// metadata and framing overhead; never assume wire bytes equal string length.
export const TOOL_RESULT_LIMIT = MCP_RESPONSE_LIMIT - 8192;
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const toolResultFrameBytes =
  jsonBytes({ content: [{ type: 'text', text: '' }], structuredContent: null }) - 4;

export function resultSize(value, includeWire) {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  return {
    bytes,
    wireBytes: includeWire
      ? toolResultFrameBytes + bytes + Buffer.byteLength(JSON.stringify(json), 'utf8') - 2
      : 0,
  };
}
export function fitsResult(result, budget) {
  if (!budget) return true;
  const { bytes, wireBytes } = resultSize(result, true);
  return bytes <= budget.maxBytes && wireBytes <= budget.maxWireBytes;
}
// Optional, repeatable metadata must not displace an operation's essential result.
// Without a batch budget standalone renderers retain every existing field.
export function optionalResultFields(required, optional, budget) {
  const full = { ...required, ...optional };
  return fitsResult(full, budget) ? full : required;
}
export function largestFittingSize(high, fits) {
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function fitDecodedText(text, maxChars, render, fits = () => true) {
  const end = (offset) => (text.codePointAt(offset - 1) > 0xffff ? offset - 1 : offset);
  return end(
    largestFittingSize(Math.min(text.length, maxChars), (offset) => {
      const value = render(text.slice(0, end(offset)));
      return JSON.stringify(value).length <= maxChars && fits(value);
    }),
  );
}

export function toolResultBytes(result) {
  return resultSize(result, true).wireBytes;
}
