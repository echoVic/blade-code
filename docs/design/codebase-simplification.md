# Codebase Simplification

## Objective

Reduce tracked TypeScript/TSX/JavaScript LOC by at least 30% while preserving
the supported runtime surfaces and making ownership easier to follow.

Baseline at `8bcd2696`:

- Tracked TypeScript/TSX/JavaScript LOC: 593,930
- Target maximum: 415,751 LOC
- Required net reduction: 178,179 LOC

The metric excludes generated output, dependencies, Markdown, JSON, and
lockfiles. It compares the same tracked extensions at the baseline and
candidate commits.

## Guardrails

- Preserve CLI, Web, ACP, MCP, browser, LSP, task, team, goal, and provider
  behavior unless a surface is unused or explicitly deprecated.
- Keep deterministic state-machine tests for durable storage, permissions,
  compaction, scheduling, tool execution, and protocol boundaries.
- Keep a focused paid qualification matrix for behavior that cannot be proven
  without a real Provider or production surface.
- Keep one authoritative state machine per behavior. Surfaces project state;
  they do not reimplement it.
- Remove deprecated compatibility paths instead of retaining aliases.
- Prefer data-driven routing and named boundaries over nested conditionals.
- Keep each independently verifiable reduction in its own commit.
- Do not use git worktrees.

## Implemented Changes

### Runtime

- Removed unused subsystems, compatibility APIs, global registries, and
  management surfaces.
- Unified Session metadata updates, local/remote fork projection, event
  projection, compaction telemetry, and inputless resume state.
- Replaced repeated shell and tool policy branches with declarative metadata.
- Split Session run ownership out of the Hono controller.

### Test Architecture

- Centralized Provider, ACP, PTY, Web, Agent loop, and Session fixture
  lifecycles before deleting their repeated consumers.
- Removed source-string gates and tests whose subject was another test harness.
- Replaced broad cross-layer matrices with focused state-machine tests.
- Reduced paid release qualification to nine high-value production paths.

## Resulting Boundaries

### Session Run Lifecycle

- `server/routes/session.ts` owns HTTP/SSE routing, projection residency, and
  controller shutdown.
- `server/routes/sessionRunState.ts` owns active/recent run registration,
  cancellation, pending permission lookup, and mutable Session task projection.
- `server/routes/sessionRunExecutor.ts` owns Agent creation, loop event
  projection, pending-resume evidence, terminal task state, and resource
  release.

The executor depends on the run-state module. Neither extracted module depends
on the Hono controller.

### Test Pyramid

The default deterministic suite remains the primary regression authority. The
production real-API release matrix is limited to:

1. Production Agent edit and verification
2. Structured output
3. Durable interaction recovery
4. Cross-surface release coding
5. Agent Team task coordination
6. Cross-Provider fallback
7. Goal completion
8. Native Browser tools
9. ACP remote filesystem

Provider admission, retry, compaction, queueing, Session identity, event
projection, and resource cleanup remain covered by deterministic unit and
integration tests instead of repeated paid surface grids.

## Result

Representative commits:

| Phase | Commits |
| --- | --- |
| Dead code and compatibility | `8b2d4ea0` through `6e0e4aa6` |
| Runtime unification | `d5373627`, `e7007472`, `953e6a67`, `5c0b67ca` |
| Harness consolidation | `b6a20834` through `877db51d` |
| Qualification focus | `89ba9afd` |
| Regression matrix reduction | `5a36aaf7` |
| Session decomposition | `c214641e` |
| Runtime and static data compaction | `7b07d031` |
| Final focused regression coverage | `a609f0a1` |

At `a609f0a1`, tracked TypeScript/TSX/JavaScript is 414,908 lines:

- Net reduction: 179,022 lines
- Reduction from baseline: 30.1419%
- Margin beyond the required reduction: 843 lines
