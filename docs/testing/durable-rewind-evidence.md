# Durable Turn Rewind Qualification Evidence

## Scope

- append-only `session_rewound` transcript marker;
- cumulative effective-history projection for resume, catalog, fork, search and
  ContextManager;
- user-turn checkpoint listing;
- conversation-only, code-only and conversation + code restore;
- Runtime idle ownership checks;
- TUI `/rewind`, Web GUI/REST/SSE and ACP slash-command integration.

## Deterministic Evidence

- `qualify:local`: 14/14 checks, exit 0;
- unit: 152 files, 1848 passed, 1 skipped;
- integration: 8 files, 56 passed;
- CLI: 3 files, 8 passed;
- headless/runtime: 9 files, 136 passed;
- E2E: 2 files, 14 passed;
- snapshot: 1 file, 9 passed;
- security: 3 files, 38 passed;
- Web: 15 files, 106 passed;
- production CLI/Web/VS Code builds and performance gate: passed;
- focused CLI/Runtime/ACP/API suite: 13 files, 251 tests, exit 0;
- rewind projection, SessionService, SnapshotManager, JSONL transaction and
  TranscriptSearch suites: exit 0;
- monorepo type check: exit 0;
- `git diff --check`: exit 0.

## Web GUI Evidence

An isolated server and synthetic session were created under a temporary
`BLADE_STORAGE_ROOT`. Browser automation used the production Vite UI and session
routes:

1. selected the exact persisted session;
2. verified the Header rewind control changed from disabled to enabled;
3. opened the dialog and observed two user-turn checkpoints;
4. verified the latest checkpoint reported one affected file;
5. enabled **Restore code changes** and submitted;
6. observed only the baseline user/assistant turn remained;
7. verified the browser console contained no errors;
8. verified `fixture.txt` changed from `bad-value` back to `baseline`;
9. verified the transcript appended `session_rewound` and effective load omitted
   the rewound turn.

The browser fixture did not use or mutate user sessions.

## Real API Matrix

Credentials were injected only into test subprocess environments.

| Model | Runtime | TUI | Web | ACP |
|---|---:|---:|---:|---:|
| `deepseek-v4-flash` | PASS | PASS | PASS | PASS |
| `deepseek-v4-pro` | PASS | PASS | PASS | PASS |

Runtime, TUI and Web trajectories used real Read/Edit/Read tool calls, restored
the file to `BASELINE`, removed the target conversation turn from effective
history and retained the durable rewind marker. ACP performed a real response,
rewound through `/rewind`, rebuilt its Agent and completed a second response
using only post-rewind history.

After snapshot manifests were scoped by canonical workspace hash, the complete
Flash/Pro matrix was rerun. A separate `deepseek-chat` Runtime/Web/ACP run also
passed. The scoped browser fixture was rerun and again reported one affected
file, restored `baseline`, appended the marker and emitted no console errors.
Deterministic tests additionally prove that duplicate session IDs in different
workspaces use different manifest directories and that a single-workspace 0.7.6
legacy manifest migrates without losing snapshots.

## Failure And Rerun Evidence

- The first TUI trajectory created its Runtime before applying the fixture cwd,
  so the assertion searched the wrong storage scope. Runtime creation now occurs
  inside `runWithCwdOverride`; the isolated rerun passed.
- The first ACP assertion expected the complete response in one notification.
  ACP correctly emitted multiple text chunks. The qualification now concatenates
  standard `agent_message_chunk` payloads and also verifies persisted assistant
  content; the isolated rerun passed.

This ledger contains no API key, raw authorization header or full environment
dump.
