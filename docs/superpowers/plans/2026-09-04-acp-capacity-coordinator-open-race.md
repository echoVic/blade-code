# ACP Capacity Coordinator Open-Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Eliminate the pre-transaction SQLite journal-mode race that makes ACP remote workspace-reference capacity contenders fail as invalid state.

**Architecture:** Install SQLite busy waiting before WAL negotiation in the shared driver, keep the capacity coordinator in WAL mode, and retain BEGIN IMMEDIATE as the serialized capacity boundary. Existing security validation and public errors remain unchanged.

**Tech Stack:** TypeScript strict, Bun SQLite, better-sqlite3, Vitest, Biome.

---

### Task 1: Lock the initialization-order contract

**Files:**
- Modify: packages/cli/tests/unit/agent-runtime/acp/remote-workspace-reference.test.ts
- Create or modify: packages/cli/tests/unit/context/sqlite/driver.test.ts

- [ ] Add a source/behavior RED proving busy_timeout precedes journal_mode=WAL and the coordinator does not switch to DELETE.
- [ ] Preserve the strict two-process capacity outcome and killed-owner recovery assertions.
- [ ] Run the target file repeatedly and record the pre-fix session_surface_state_invalid loser.

### Task 2: Remove the pre-lock journal-mode race

**Files:**
- Modify: packages/cli/src/context/storage/sqlite/driver.ts
- Modify: packages/cli/src/acp/AcpRemoteWorkspaceReference.ts

- [ ] Move PRAGMA busy_timeout=5000 before PRAGMA journal_mode=WAL in the shared driver.
- [ ] Remove only PRAGMA journal_mode=DELETE from coordinator initialization.
- [ ] Keep locking_mode=NORMAL, synchronous=FULL, coordinator busy_timeout=30000, identity validation, and auxiliary-file validation.
- [ ] Run the focused RED to GREEN and repeat the entire workspace-reference file at least ten times.

### Task 3: Review, qualify, and release

**Files:**
- Create bilingual evidence under docs/testing and docs/en/testing.
- Modify CHANGELOG.md, CHANGELOG.zh.md, and packages/cli/package.json only for release metadata.

- [ ] Run focused SQLite/ACP tests, type-check, lint, format, build, and full test suites.
- [ ] Obtain independent specification and quality/concurrency reviews.
- [ ] Publish the next independent patch through main then an annotated tag; verify workflow, npm, Release, SHA, and clean worktree.
