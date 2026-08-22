# Durable Session Archive

Blade's Session Archive is a recoverable durable lifecycle, not a delete alias. After archiving, conversation transcripts, task status, fork/subagent lineage, Goals, Snapshots, and worktree metadata are all preserved; the default Session catalog, `/resume`, ACP `session/list`, and Web main sidebar no longer show the session.

## Storage Model

JSONL transcripts remain the single source of truth. The archive root only appends one event:

```json
{
  "type": "session_updated",
  "data": {
    "sessionId": "session-id",
    "archivedAt": "2026-08-09T00:00:00.000Z",
    "updatedAt": "2026-08-09T00:00:00.000Z"
  }
}
```

Restoration appends `archivedAt: null`. Events do not rewrite or move history, so crashes cannot leave half-transcripts.

Fork and subagent descendants inherit the nearest archived ancestor state through `parentId`. Archiving a parent session only commits the parent event, and the entire subtree is hidden atomically in the same catalog projection without requiring pseudo-transactions across multiple JSONL files. Individually archived descendants have their own direct `archivedAt`; after restoring the parent session, such descendants remain archived.

External metadata:

- `archivedAt`: currently effective archive time.
- `archivedBySessionId`: direct archive root; descendants use this to indicate which ancestor should be restored.

## Concurrency and Write Fences

Before archiving, Blade resolves the complete descendant set and acquires each Session lease in stable Session ID order. When any descendant meets the following conditions, the entire operation fails with zero writes:

- task is `queued` or `running`;
- another CLI, TUI, Web server, or ACP owner holds the Session lease;
- transcript changes archive status within the critical section;
- committed workspace does not match requested workspace.

Web first rejects active runs, then releases this process's idle Runtime, then acquires the entire subtree lease. TUI argument-free `/archive` releases the current idle Runtime, archives the current session, and exits; in-flight turns are still rejected by the existing slash-command turn gate. ID-bearing commands only operate on sessions not occupied by other owners.

Archive state blocks continuation at three levels:

1. `SessionRuntime.create` rejects before restoring worktree, model, MCP, LSP, or tools.
2. `SessionService.updateSessionMetadata` rejects direct or inherited archive state within the JSONL atomic append critical section.
3. Web write routes and ACP `session/load` reject before creating an owner.

Reading transcripts and hard deletion remain executable; model turns, forks, rewinds, or metadata modifications are only allowed after restoration.

## Catalog and API

Default catalog returns only active Sessions:

```http
GET /sessions/catalog
```

Archived catalog uses an independent cursor scope:

```http
GET /sessions/catalog?archived=true
```

Active cursors cannot be used with archived catalogs and vice versa. The SQLite read model uses recursive CTEs to compute inherited archive status before pagination, preventing descendant leakage from page boundaries.

```http
POST /sessions/:sessionId/archive?projectPath=/absolute/path
POST /sessions/:sessionId/unarchive?projectPath=/absolute/path
```

Archive response includes `archivedSessionIds`; unarchive response includes `restoredSessionIds` restored this time. The Bus publishes `session.archived` or `session.unarchived` for each affected Session, and other Web tabs converge immediately.

## Surfaces

CLI/TUI:

```text
/archive
/archive <sessionId>
/unarchive <sessionId>
```

Web:

- Custom Popover on session rows provides Archive action.
- Main sidebar shows only active Sessions.
- Footer Archive Popover loads archived Sessions with pagination on demand.
- Inherited-archive descendants show the archive root and disable incorrect local restore operations.
- After restoration, Session returns to project-level navigation and can continue the original transcript.

ACP:

- `session/list` excludes archived Sessions by default.
- `session/load` fails closed before destroying old owner, reading history, or initializing new Runtime.
- ACP has no standard archive wire method; Blade slash commands can be used to operate on other inactive Sessions, or Web/HTTP management plane can execute archive/unarchive.

## Production Qualification

Deterministic tests cover:

- Direct archive, inherited archive, and individually archived descendants.
- active/archived catalogs and cursor scopes.
- queued/running descendants, cross-process leases, and zero partial writes.
- Runtime, Web, TUI, and ACP write blocking.
- SQLite/JSONL parity, cross-workspace identity, and Bus multi-tab convergence.
- Web Popover keyboard focus, Archive/Restore actions, and current Session cleanup.

Real GPT qualification executes two model turns: archive after the first turn, proving both Runtime and metadata writes are rejected; after restoration, complete the second turn from the same durable history.

production DeepSeek Web GUI executes:

```text
Real turn 1
→ Row menu Archive
→ active catalog empties
→ archived write returns HTTP 409
→ Archive Popover Restore
→ Same Session real turn 2
→ fresh-tab recovery
```

Qualification also requires transcripts to contain only two legal migrations `archivedAt: timestamp -> null`, rejected inputs not persisted, fresh tabs with zero application console errors, and server port and temporary root reclamation.
