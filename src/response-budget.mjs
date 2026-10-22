// UTF-8 wire bounds are separate from selectors and structured read budgets.
export const MCP_RESPONSE_LIMIT = 256 * 1024;
// A 1024-byte request ID may escape to 6144 JSON bytes. Also reserve modern
// metadata and framing overhead; never assume wire bytes equal string length.
export const TOOL_RESULT_LIMIT = MCP_RESPONSE_LIMIT - 8192;
export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function fitsResult(result, budget) {
  return (
    !budget ||
    (jsonBytes(result) <= budget.maxBytes && toolResultBytes(result) <= budget.maxWireBytes)
  );
}
// Optional, repeatable metadata must not displace an operation's essential result.
// Without a batch budget standalone renderers retain every existing field.
export function optionalResultFields(required, optional, budget) {
  const full = { ...required, ...optional };
  return fitsResult(full, budget) ? full : required;
}
export function toolResultBytes(result) {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    }),
    'utf8',
  );
}
