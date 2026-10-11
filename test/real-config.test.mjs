import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realTestSettings } from '../research/real-config.mjs';

test('real-provider harness requires explicit destination and model before any network activity',()=>{
  const env={PI_REAL_TEST:'1',OPENAI_API_KEY:'synthetic-fixture',OPENAI_BASE_URL:'https://example.invalid/v1',PI_REAL_BASE_URL:'https://example.invalid/v1',PI_REAL_ACK_DESTINATION:'https://example.invalid/v1',PI_REAL_MODEL:'fixture-model'};
  assert.deepEqual(realTestSettings(env),{baseUrl:'https://example.invalid/v1',model:'fixture-model'});
  for (const key of ['PI_REAL_TEST','OPENAI_API_KEY','OPENAI_BASE_URL','PI_REAL_BASE_URL','PI_REAL_ACK_DESTINATION','PI_REAL_MODEL']) {
    const missing={...env};delete missing[key];assert.throws(()=>realTestSettings(missing));
  }
  assert.throws(()=>realTestSettings({...env,OPENAI_BASE_URL:'https://another.invalid/v1'}),/must match/);
  assert.throws(()=>realTestSettings({...env,PI_REAL_ACK_DESTINATION:'https://another.invalid/v1'}),/credential recipient/);
  assert.equal(realTestSettings({...env,PI_REAL_THINKING_FORMAT:'deepseek'}).thinkingFormat,'deepseek');
  assert.throws(()=>realTestSettings({...env,PI_REAL_THINKING_FORMAT:'invented'}),/must be deepseek/);
  for (const baseUrl of ['http://example.invalid/v1','https://user:password@example.invalid/v1','https://example.invalid:8443/v1','https://example.invalid/v1?key=test','https://example.invalid/v1#fragment']) {
    assert.throws(()=>realTestSettings({...env,OPENAI_BASE_URL:baseUrl,PI_REAL_BASE_URL:baseUrl,PI_REAL_ACK_DESTINATION:baseUrl}));
  }
});
