// Argument schemas are enforced once, at the MCP tool boundary.
import assert from 'node:assert/strict';
import { callBridgeTool } from '../../src/protocol.mjs';

export async function assertInvalidArguments(bridge, name, args) {
  const result = await callBridgeTool(bridge, name, args);
  assert.equal(result.structuredContent?.error?.code, 'INVALID_ARGUMENTS');
}
