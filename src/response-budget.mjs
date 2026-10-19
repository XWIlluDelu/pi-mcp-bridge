// UTF-8 wire bounds are separate from selectors and structured read budgets.
export const MCP_RESPONSE_LIMIT = 256 * 1024;
// A 1024-byte request ID may escape to 6144 JSON bytes. Also reserve modern
// metadata and framing overhead; never assume wire bytes equal string length.
export const TOOL_RESULT_LIMIT = MCP_RESPONSE_LIMIT - 8192;
export function toolResultBytes(result) {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    }),
    'utf8',
  );
}
