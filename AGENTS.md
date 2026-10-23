# Development principles

This is an early-stage project. Support only the current Bridge and matching
companion/host components. Do not add or retain compatibility with older Bridge
protocols, configuration, parameters or behavior. Remove obsolete branches and
their dedicated tests, fixtures and documentation; do not translate, migrate or
silently accept old formats. Report a clear protocol mismatch and require the
components to be updated together.

Project quality, clear semantics and a simple correct design take precedence
over implementation effort, minimal diffs and uninterrupted operation. Refactor
when needed; do not replace obsolete mechanisms with generic compatibility,
migration or recovery frameworks.

Preserve user data, current native Pi capabilities, authorization, identity,
concurrency and actual in-flight-work protections. Native history projection and
the raw snapshot used for fork are current functionality, not Bridge-version
compatibility. Production changes, interruptions and deployment require the
authorization given for that operation; source cleanup does not authorize them.
