# Working with a Pi session

Grant the operations needed for the workflow in the
[owner configuration](configuration.md#seven-independent-rights).

## Calling workflow

1. Find the session with `list({})`, then open the last three input turns with
   `read({session_id})`. For new work, choose a listed `creatable_projects`
   destination and call `create({project})`.
2. If you need a notification, [subscribe](events.md) to the saved ID before
   sending. Call `send({session_id,text})` and retain any `submission_id`.
3. For an unknown outcome, check the [submission receipt](api.md#submission-receipt).
   If it is unavailable, inspect activity and history before sending further input.
4. On settlement, use the result excerpt or pass `data.read` directly to `read`
   for the completed leaf. Without events, use `list({session_id})` for activity
   and `read({session_id})` for the result.

## Identity and result boundaries

Keep the `session_id` for later work on the same native history. A
[receipt](api.md#submission-receipt) tracks one input's admission. A
[settlement event](events.md#scope-and-completion-meaning) describes the full
native run, which may consume several queued or steering inputs. Inspect the
result to determine whether the task succeeded.
