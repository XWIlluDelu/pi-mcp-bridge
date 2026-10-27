// Pi's loader resolves this import to the actual CLI class, including bundled
// installations. Keep the implementation injectable for public SDK embedders.
import { AgentSession, buildSessionProjection } from '@earendil-works/pi-coding-agent';
import companion from './companion.mjs';
export default function attachExtension(pi) {
  return companion(pi, { AgentSession, buildSessionProjection });
}
