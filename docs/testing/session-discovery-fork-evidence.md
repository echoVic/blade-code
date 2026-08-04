# Session Discovery and Durable Fork Qualification Evidence

## Build identity

- Base: `194fd603`
- Head: `19e6e9ac262bd42bf517a730fc98eabd6304d017`
- Worktree: `.worktrees/session-discovery-fork`

## Prompt-to-artifact checklist

| Requirement | Artifact | Deterministic evidence | Real API evidence | Status |
|---|---|---|---|---|
| Runtime stability and tool chain | SessionService catalog/fork | catalog + fork tests | Runtime trajectory | LOCAL PASS; PRODUCTION PENDING |
| CLI/UI experience | `/fork`, selector, activation | TUI unit tests | TUI trajectory | LOCAL PASS; PRODUCTION PENDING |
| Web complete path | route, store, Sidebar | server + Web tests | HTTP/SSE trajectory | LOCAL PASS; PRODUCTION PENDING |
| ACP mode | list/fork methods | BladeAgent tests | NDJSON trajectory | LOCAL PASS; PRODUCTION PENDING |
| Parent immutability | JSONL fork contract | real-file fork tests | all four trajectories | LOCAL PASS; PRODUCTION PENDING |
| No Mock integration evidence | production entrypoints | N/A | real configured providers | PENDING |
| Small independent patch | commit series | diff + patch validation | N/A | PENDING |

## Exact local commands

Run from the repository root:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/services/session-service-catalog.test.ts \
  tests/unit/services/session-service-fork.test.ts \
  tests/unit/context/jsonl-store.test.ts \
  tests/unit/integrations/api/schemas.test.ts \
  tests/unit/cli/session-context.test.ts \
  tests/unit/cli/slash-commands/fork.test.ts \
  tests/unit/platform/ui/utils/sessionActivation.test.ts \
  tests/unit/platform/ui/components/session-selector-model.test.ts \
  tests/unit/platform/ui/utils/slashCommandRouter.test.ts \
  tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/agent-runtime/server/session-ref.test.ts \
  tests/unit/agent-runtime/agent/subagent-event-forwarding.test.ts \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/integration/real-api-harness.test.ts
bunx vitest run --config vitest.config.ts --project integration \
  tests/integration/acp-session-fork.test.ts
bunx vitest run --config vitest.config.ts --project cli \
  tests/integration/cli/session-selector-fork.test.tsx
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/sessionIdentity.test.ts \
  tests/components/chat/ChatMessage.test.tsx \
  tests/components/layout/Sidebar.test.tsx \
  tests/components/layout/Layout.test.tsx \
  tests/components/preview/FilePreview.test.tsx
cd ../../..
bun run qualify:local
git diff --check 194fd603..HEAD
git status --short
```

Focused final results on 2026-08-04 (Asia/Shanghai):

- unit: 17 files, 302 tests, exit 0;
- ACP integration: 1 file, 1 test, exit 0;
- CLI/Ink integration: 1 file, 2 tests, exit 0;
- Web: 7 files, 46 tests, exit 0;
- `qualify:local`: 14/14 checks, exit 0;
- `git diff --check 194fd603..HEAD`: exit 0, no output.

## Exact production commands

```bash
bun run qualify:production
```

Status: `PENDING`. Task 10 does not treat development-time paid-model runs as the
final production gate.

## Exit codes

- Focused deterministic commands: `0` after rerun.
- `qualify:local`: `0`, 14/14 checks.
- Production qualification: `PENDING`.
- Patch packaging/checksums: `PENDING`.

## Model matrix

- Required: `deepseek-v4-flash`, `deepseek-v4-pro`.
- Additional: every explicitly configured Claude, GPT, or domestic-provider model.
- Final production matrix result: `PENDING`.

## First failure

The first combined focused unit run reported three rename/patch failures in
`session-routes.test.ts` (expected 200/500 responses were observed as 404/200/500).
The source was unchanged in this phase. The same file then passed 32/32, the exact
three tests passed 3/3, and the original 17-file command passed 302/302. Record these
as intermittent failures in unchanged sources; do not treat them as silently removed
or as a proven product defect.

## Rerun evidence

- `session-routes.test.ts`: 32/32, exit 0.
- Exact three rename/patch tests: 3/3, exit 0.
- Original focused unit command: 302/302, exit 0.
- `qualify:local` unit phase: 134 files, 1675 passed, 1 skipped, exit 0.
- Full local integration: 8 files, 50 tests, exit 0.
- Full CLI: 3 files, 6 tests, exit 0.
- Headless: 9 files, 108 tests, exit 0.
- E2E: 2 files, 14 tests, exit 0.
- Snapshot: 1 file, 9 tests, exit 0.
- Security: 3 files, 38 tests, exit 0.
- Web: 13 files, 60 tests, exit 0.
- Performance: 2 files passed, 1 skipped; 15 tests passed, 1 skipped; exit 0.
- Production build: CLI and VS Code builds, exit 0.

## Review findings

- Task 1-9 spec and quality review checkpoints were completed in the implementation
  session; a consolidated on-disk final review record is `PENDING`.
- Final cross-task review: `PENDING`.

## Patch filenames and checksums

PENDING. Task 11 generates patch files and SHA-256 checksums after final review.

## Uncovered long-term objective items

PENDING. Task 11 records the post-qualification gap audit and selects the next
four-surface increment.

This ledger must not contain API keys, base URLs, full environment dumps, raw request
headers, or other secret-bearing transport data.
