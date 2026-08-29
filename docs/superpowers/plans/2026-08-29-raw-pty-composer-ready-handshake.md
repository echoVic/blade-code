# Raw PTY Composer-Ready Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent raw PTY qualification runners from sending prompt data before the
TUI input handler is registered.

**Architecture:** Add an opt-in nonce-bound OSC marker at the terminal input
registration boundary. Test helpers create the nonce and every prompt-input PTY runner
waits for the exact marker before using bracketed paste; final-response marker
protocols remain unchanged.

**Tech Stack:** TypeScript, React/Ink, Bun PTY, Vitest, Biome.

---

### Task 1: Define and test the handshake contract

**Files:**
- Create: `packages/cli/src/ui/input/tuiComposerReady.ts`
- Modify: `packages/cli/src/ui/input/TerminalInputRouter.tsx`
- Test: `packages/cli/tests/unit/platform/ui/input/TerminalInputRouter.test.tsx`
- Test: `packages/cli/tests/unit/integration/raw-pty-marker-latching.test.ts`

- [ ] Add RED tests requiring a nonce-validated OSC marker and an
  `onRegistered` callback that fires only after the active router registration.
- [ ] Run the two test files and confirm they fail because the API and marker do not
  exist.
- [ ] Implement the formatter/emitter and the registration callback with exact token
  validation.
- [ ] Run the two test files and confirm the new contract passes.

### Task 2: Emit readiness from the main composer

**Files:**
- Modify: `packages/cli/src/ui/components/CustomTextInput.tsx`
- Test: `packages/cli/tests/unit/platform/ui/CustomTextInput.test.tsx`

- [ ] Add a RED test that enables the nonce and proves the marker is emitted only
  after input registration.
- [ ] Wire the stable readiness emitter through `useTerminalInput(...,
  { onRegistered })`.
- [ ] Run the component and router tests and confirm they pass without emitting when
  the environment variable is absent or malformed.

### Task 3: Migrate prompt-input raw PTY runners

**Files:**
- Modify: `packages/cli/tests/support/ptyInput.ts`
- Modify: every runner listed in `promptInputRunners` in
  `packages/cli/tests/unit/integration/raw-pty-marker-latching.test.ts`
- Test: `packages/cli/tests/unit/integration/raw-pty-marker-latching.test.ts`

- [ ] Add RED source-contract assertions requiring each prompt-input runner to create
  a nonce-bound handshake, pass its environment, and wait for its exact marker.
- [ ] Add a pure helper returning `{ env, marker }` for one PTY child.
- [ ] Replace placeholder waits with exact marker waits and delete the token-budget
  five-second bracketed-mode fallback.
- [ ] Keep each runner's existing post-paste acknowledgement and final-marker logic.
- [ ] Run the raw PTY source-contract and helper tests.

### Task 4: Verify and release independently

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`
- Update: the relevant testing evidence files after commands complete

- [ ] Run focused UI/PTY unit tests, type-check, Biome, `git diff --check`, and build.
- [ ] Run the affected DeepSeek Flash/Pro raw PTY real-API cells with
  `--retry=0 --maxWorkers=1 --no-file-parallelism`.
- [ ] Request independent specification and quality reviews and resolve all findings.
- [ ] Commit only the handshake implementation and its tests.
- [ ] Record observed evidence, bump one patch version, run final release-tree gates,
  create an annotated tag, push main/tag, and verify Actions, npm, and GitHub Release.
