# Codebase Simplification

## Objective

Reduce tracked TypeScript/TSX/JavaScript LOC by at least 30% while preserving
supported behavior, keeping coverage above repository thresholds, and making
runtime ownership easier to follow.

Baseline at `8bcd2696`:

- Total source and test LOC: 595,280
- Production LOC: 248,570
- Test LOC: 342,035
- Target maximum: 416,696 LOC
- Required net reduction: 178,584 LOC

The metric excludes generated build output, dependencies, Markdown, JSON, and
lockfiles. Deleting tests without equivalent coverage, compressing formatting,
or moving code into uncounted formats does not count as simplification.

## Guardrails

- Preserve CLI, Web, ACP, MCP, browser, LSP, task, team, goal, and provider
  behavior unless a surface is already unused or explicitly deprecated.
- Do not regress the measured unit-test baseline: 68.20% statements, 62.48%
  branches, 69.97% functions, and 69.54% lines. The Vitest config declares 80%
  thresholds, but the current project runner does not enforce them.
- Keep one authoritative state machine per behavior. Surfaces project state;
  they do not reimplement it.
- Remove deprecated compatibility paths instead of retaining aliases.
- Prefer data-driven routing and named boundaries over nested conditionals.
- Keep each independently verifiable reduction in its own commit.
- Do not use git worktrees.

## Delivery Tracks

### 1. Dead Code And Compatibility

- Remove unreachable files and unused dependencies reported by Knip.
- Remove unused exports and test-only production helpers.
- Remove deprecated singleton and forwarding APIs after migrating consumers.

### 2. Runtime Unification

- Collapse local and remote Session metadata/event construction.
- Share fork, archive, lifecycle, and error-mapping primitives.
- Reduce duplicate state transitions across Web, ACP, Headless, and TUI.

### 3. God File Decomposition

- Split route registration from Session route behavior.
- Split provider/tool execution phases out of the Agent loop.
- Split Session catalog, mutation, fork/rewind, and projection responsibilities.
- Split Web store orchestration from pure event reducers.

Decomposition is accepted only when dependencies become narrower; moving the
same code without simplifying ownership does not count toward the LOC target.

### 4. Test Compression

- Replace repeated scenario bodies with typed table-driven cases.
- Share process, ACP, PTY, Web, and Provider harnesses.
- Remove implementation-only compatibility tests together with deleted APIs.
- Preserve unique assertions and real-boundary qualification coverage.

## Progress

| Commit | Change | Net LOC |
| --- | --- | ---: |
| `84ba35f2` | Remove unused child abort controller | -72 |
| `8bcd2696` | Consolidate subagent delegation dependencies | +24 |
| `8b2d4ea0` | Remove unused subsystems and dependencies | -1,608 |
| `d5beaa46` | Remove obsolete compatibility and context layers | -1,362 |
| `d5373627` | Unify Session metadata update construction | -104 |
| `e7007472` | Share local and remote fork projection | -122 |
| `0efea96c` | Deduplicate shared theme tokens | -374 |
| `99d2dee4` | Encode read-only flags declaratively | -557 |
| `32e7cb0a` | Remove deprecated global subagent tool registry | +29 |
| `db31cb0c` | Make shell safety cases table driven | -266 |
| **Current total** |  | **-4,411** |
