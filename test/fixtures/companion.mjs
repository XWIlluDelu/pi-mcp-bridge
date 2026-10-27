// Direct test embedders use their chosen native projection. CLI tests load attach-extension.
import companion from '../../src/companion.mjs';
import { buildSessionProjection } from './pi.mjs';
export default function attachExtension(pi) {
  return companion(pi, { buildSessionProjection });
}
