# Development principles

This is an early-stage project. Support only the current Bridge control protocol
and matching companion/host components. Do not add or retain compatibility with
older requests, responses, configuration or parameters. Remove obsolete branches
and their dedicated tests, fixtures and documentation; do not translate or migrate
old control formats. Report a clear mismatch when using an unsupported live
endpoint and require the components to be updated together.

Use `package.json` as the single Bridge product version source. Owner read
compatibility uses the explicit current read contract in `src/context-read.mjs`;
change it only for incompatible read semantics, never for a product release alone.
Keep control-interface checks independent. Main releases use a plain semantic
version and a matching Git tag.
Auto-dev iterations use the next intended release's prerelease suffix, starting
at `-dev.1` for each release cycle. Remove that suffix when publishing main;
do not duplicate the product version in another release counter.

Ownership evidence is separate from control-interface compatibility. Scope
checks to the target path or exact process, preserve live writers and explicit
local pauses, and allow native replacement or confirmed process exit to end
ephemeral claims. A fresh registration is not a translation of an old endpoint.

Project quality, clear semantics and a simple correct design take precedence
over implementation effort, minimal diffs and uninterrupted operation. Refactor
when needed; do not replace obsolete mechanisms with generic compatibility,
migration or recovery frameworks.

Preserve user data, current native Pi capabilities, authorization, identity,
concurrency and actual in-flight-work protections. Native history projection and
the raw snapshot used for fork are current functionality, not Bridge-version
compatibility. Production changes, interruptions and deployment require the
authorization given for that operation; source cleanup does not authorize them.
