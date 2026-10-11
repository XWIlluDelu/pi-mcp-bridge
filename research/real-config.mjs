// Pure validation: importing this module never starts a process or network request.
export function realTestSettings(env) {
  if (env.PI_REAL_TEST !== '1') throw new Error('Set PI_REAL_TEST=1 to authorize real-provider requests');
  const baseUrl = env.PI_REAL_BASE_URL;
  let destination;
  try { destination = new URL(baseUrl); } catch { throw new Error('PI_REAL_BASE_URL must be an explicit HTTPS API base URL'); }
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash || (destination.port && destination.port !== '443')) throw new Error('PI_REAL_BASE_URL must use HTTPS port 443 without credentials, query, or fragment');
  if (!baseUrl || env.PI_REAL_ACK_DESTINATION !== baseUrl) throw new Error('Set PI_REAL_ACK_DESTINATION to the exact PI_REAL_BASE_URL to acknowledge the credential recipient');
  if (env.OPENAI_BASE_URL !== baseUrl) throw new Error('OPENAI_BASE_URL must match PI_REAL_BASE_URL');
  if (typeof env.PI_REAL_MODEL !== 'string' || !env.PI_REAL_MODEL.trim()) throw new Error('PI_REAL_MODEL is required');
  if (!env.OPENAI_API_KEY) throw new Error('Missing platform Network-secret placeholder in OPENAI_API_KEY');
  if (env.PI_REAL_THINKING_FORMAT !== undefined && env.PI_REAL_THINKING_FORMAT !== 'deepseek') throw new Error('Optional PI_REAL_THINKING_FORMAT must be deepseek');
  return {baseUrl,model:env.PI_REAL_MODEL,...(env.PI_REAL_THINKING_FORMAT?{thinkingFormat:env.PI_REAL_THINKING_FORMAT}:{})};
}
