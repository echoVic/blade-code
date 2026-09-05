# Durable Follow-up Queue

Input submitted while a long-running task is active enters the current Session's
durable follow-up queue. The persisted inbox is the only source of truth. TUI and
Web render versioned Runtime snapshots rather than maintaining a second writable queue.

## Eligible items

An item can be removed or moved only when all of these conditions hold:

- it came directly from the user;
- its content is still inline;
- it has not been reserved, claimed, or persisted to the transcript;
- it has no structured-output schema;
- it is not protected by crash recovery.

Background-subagent completions, team messages, interaction recovery, user-shell
references, artifact-backed prompts, and other internal inputs are immutable barriers.
User items cannot move across a barrier. This exposes the real order without exposing
internal content.

## TUI

Enter `/queue` while a turn is active to open the panel. The status line shows
`Queued N · /queue` whenever input is pending.

| Key | Action |
| --- | --- |
| `j` / `↓` | Select the next item |
| `k` / `↑` | Select the previous item |
| `d` | Delete a mutable item |
| `J` / `K` | Move down / up inside the current mutable segment |
| `g` / `G` | Move to the start / end of the current mutable segment |
| `r` | Reload the authoritative snapshot |
| `Esc` / `q` | Close the panel |

The panel remains usable while the Agent runs and keeps its state across terminal resize.

## Web UI

The **Follow-up queue** panel above the composer shows authoritative order, delivery
phase, lock state, and attachment count. Mutable rows provide move-up, move-down, and
remove buttons, plus drag reordering inside one mutable segment. Reload and SSE reconnect
restore the authoritative snapshot.

Every mutation carries the current 64-character SHA-256 version. If another owner commits
first, the server returns `revision_conflict` with the latest snapshot. Web installs that
snapshot and asks the user to confirm again; it never replays a stale action automatically.

## Persistence and delivery

- Enqueue, reorder, remove, reservation, claim, acknowledgement, and recovery-protection
  changes produce a new version.
- A successful mutation atomically commits the durable inbox before publishing a snapshot.
- Unconsumed order survives crashes and restarts; a previous Runtime owner's version is
  no longer valid.
- Queued input becomes a canonical transcript row only after `steering_applied`; removing
  a pending item cannot leave a ghost user message.
- `session/cancel` cancels the active turn and is not a queue-delete operation.

## ACP

ACP 1.3 has no standard queue-mutation method, so Blade advertises no custom mutation
capability. ACP clients receive this read-only summary through standard
`session_info_update` notifications:

```json
{
  "_meta": {
    "blade/followUpQueue": {
      "version": "opaque-sha256-token",
      "pending": 3,
      "mutable": 2,
      "locked": 1,
      "internal": 0
    }
  }
}
```

The summary is refreshed after Session creation or load, enqueue, claim, acknowledgement,
and recovery reload. It contains no item array, preview, message ID, image data URL,
artifact or path, output schema, request header, or credential.

## Limits

- Queued content cannot be edited in this release.
- Web and TUI cannot mutate an ACP-remote history-only Session.
- Queue controls do not interrupt an in-flight Provider request; the new order takes
  effect at the next safe boundary.
- The queue is capped at 160 items and remains subject to the existing durable-inbox
  item, character, and file-size budgets.

See [Durable Follow-up Queue Qualification Evidence](../testing/durable-follow-up-queue-evidence.md)
for the production verification record.
