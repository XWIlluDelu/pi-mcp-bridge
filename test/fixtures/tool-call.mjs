// Argument schemas are enforced once, at the MCP tool boundary.
import assert from 'node:assert/strict';
import { callBridgeTool, META, MODERN_VERSION } from '../../src/mcp/protocol.mjs';

export async function assertInvalidArguments(bridge, name, args) {
  const result = await callBridgeTool(bridge, name, args);
  assert.equal(result.structuredContent?.error?.code, 'INVALID_ARGUMENTS');
}

export function mcpRequest(method, params = {}, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
    },
  };
}
