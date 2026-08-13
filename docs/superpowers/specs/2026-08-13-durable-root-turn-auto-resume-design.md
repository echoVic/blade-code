# Durable Root-Turn Auto-Resume Design

## 1. Problem

Blade persists accepted input, turn lifecycle events, tool calls, tool results, and
Goals. `SessionRuntime.initialize()` also reconciles an interrupted turn after it
acquires the Session lease. However, some entrypoints build `ChatContext.messages`
before runtime initialization:

- TUI restores the visible/model context before `useAgent` creates the runtime.
- ACP accepts `initialMessages` before `AcpSession.initialize()` creates the runtime.
- Print and Headless resolve history before `SessionRuntime.create()`.

If runtime recovery commits a `turn_aborted` marker or an orphan tool receipt, the
first automatic continuation can therefore run against a stale pre-recovery context.
The next process sees the receipt, but the continuation that matters most may not.
For an orphan write this can hide `sideEffectsUncertain` and repeat a side effect.

Web already creates the runtime before loading the model context in
`executeRunAsync()`, so it is the control surface.

Print and Headless also require a synthetic wake-up prompt. A bare
`--resume <session>` cannot consume the durable inbox or continue an active Goal.

## 2. Reference Behavior

- Claude Code re-enqueues an interrupted prompt on restart and removes the stale
  interrupted copy so the model sees the resumed task exactly once.
- Codex owns pending input in the active turn state, preserves it across abort
  boundaries, and drains it before the next model request.
- Grok Build binds queue/adoption behavior to ACP session lifecycle instead of
  requiring a fabricated user message.
- Neovate treats queued messages as first-class session input.

Blade keeps its stronger JSONL plus sidecar durability model. The patch adopts the
shared invariant, not another project's storage representation.

## 3. Canonical Recovery Contract

1. Runtime acquires the Session lease and performs process, subagent, workspace,
   interaction, and turn reconciliation before an automatic continuation begins.
2. `pendingInputOnly`, `goalContinuationOnly`, and a prepared input whose mode is
   `pending` are recovery entrypoints. Immediately before their first loop, Agent
   replaces the caller's model context with `SessionService.loadSessionModelContext()`
   for the exact runtime workspace.
3. Invalid or unreadable durable context fails closed. It never falls back to the
   stale caller snapshot.
4. The caller's `messages` array is updated in place so post-run context ownership
   remains consistent.
5. Ordinary user turns do not reload context. Their caller-owned ephemeral system
   additions and optimistic UI boundary remain unchanged.
6. Pending input takes precedence over Goal continuation. After pending input is
   acknowledged, the normal Agent loop may continue the active Goal.

## 4. Zero-Input Non-Interactive Resume

Print and Headless distinguish three states:

- explicit input: execute the existing normal user turn;
- no explicit input plus durable pending input: invoke `pendingInputOnly`;
- no explicit input plus active/verifying Goal: invoke `goalContinuationOnly`.

If no input, inbox, or active Goal exists, the command fails with a clear
`No unfinished turn or active goal to resume` error.

Constraints:

- zero-input mode is available only with `--resume <id>` or `--continue`;
- it does not apply to `--fork-session`;
- no empty user message, `Hello`, or wake-up prompt is persisted;
- a durable structured-output schema remains owned by the queued input;
- permission/model/session settings continue to come from the resumed Session.

## 5. Surface Matrix

| Surface | Recovery trigger | Required evidence |
| --- | --- | --- |
| Runtime | recovery-only Agent call | fresh abort/receipt is in provider context |
| Headless | bare `--resume` | original inbox executes once, zero synthetic input |
| Print | bare `--resume` | same behavior and final text output |
| TUI | session activation | raw PTY resumes without user retyping |
| Web | SSE/fresh tab | GUI reconnect still resumes and renders one result |
| ACP | `session/load` | SDK lifecycle resumes after history replay |

## 6. Qualification

Release qualification uses DeepSeek Flash and Pro. The destructive fixture commits
an orphan tool call and an already-applied marker, then starts a fresh runtime. The
resumed model must observe the process-restart receipt, inspect the marker, and must
not issue another write. All surfaces must leave no runtime, process, lease, port,
browser, PTY, or ACP handle behind.

The fixed production qualification list remains release-blocking. Web validation
uses a production build and real Chromium; TUI validation uses a real raw PTY.
