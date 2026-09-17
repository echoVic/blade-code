# Blade Code Testing and Production Qualification

Blade Code separates deterministic regression checks from paid model
verification. Both gates must pass before a feature patch is production-ready.

## Controlled Coding Benchmark

`bun run benchmark:repo -- --model <configured-model-id>` runs
`controlled-coding-v2`: read-only diagnosis, single-file repair, and a
cross-module API migration in fixed small projects. It uses the production
distribution, Node, npm, and configured API-key authentication. It does not
install dependencies or create worktrees.

Each task receives an isolated project, HOME, and Session store, with MCP, LSP,
hooks, and plugins disabled. The host verifies real file reads, limited path
changes, `npm test` after the final edit, boundary examples in an independent
directory, and returned values. Changing tests or `package.json`, adding
unrequested files, omitting tool evidence, claiming success, or returning only
`exit(0)` cannot pass.

Results default to `.blade/benchmarks/controlled-coding-v2-history.json`. This
is not a large-repository benchmark and does not establish overall parity with
other coding agents.

## Local Gate

Run from the repository root:

```bash
bun run qualify:local
```

The command executes 14 checks in order:

1. TypeScript type checking
2. format checking
3. lint
4. unit tests
5. integration tests
6. CLI tests
7. Headless/runtime core regressions
8. E2E
9. snapshots
10. security tests
11. production build
12. Web tests
13. Web type checking
14. performance regressions

The first non-zero exit stops the gate. This gate does not access paid models.

`test:headless-core` explicitly runs `headless-boundaries.test.ts` and
`headless-event-contract.test.ts`. The latter directly verifies
`HEADLESS_EVENT_VERSION`, `createHeadlessJsonlEvent`, and
`HeadlessJsonlEventSchema`. Every explicit test inventory is checked before
Vitest starts; a missing path fails immediately.

V8 coverage runs separately through `bun run test:coverage`. It covers unit,
integration, CLI, E2E, snapshot, security, and keyless real-api fixtures while
excluding the wall-clock performance project.

## Real API Gate

Real API tests must use `packages/cli/dist/blade.js` freshly built from the
current source. Provider credentials may be injected by a secret manager or
stored in `~/.blade/real-api-credentials.json`. That file must be a regular
file owned by the current user, mode `0600`, and at most 64 KiB. Symlinks,
loose permissions, and unknown fields fail closed.

Do not put credential values in inline `KEY=value` commands, shell history, or
evidence documents. Logs retain only variable names, model IDs, counts,
timings, and redacted host evidence.

Install Chromium after the first checkout or a Playwright version change:

```bash
bun run --filter blade-code browser:install
```

Run production qualification with:

```bash
bun run qualify:production
```

This command runs the 14 local checks, a keyless Chromium preflight, and only
then paid Provider tests. A preflight failure cannot produce Provider traffic.

### Release-Blocking Matrix

`test:real-api:qualification` is controlled by a fixed allowlist in
`scripts/test-config.js`. It contains nine test files:

1. `agent-trajectory.test.ts`: production Agent read, edit, and test
2. `structured-output-trajectory.test.ts`: structured output
3. `durable-interaction-recovery-trajectory.test.ts`: durable recovery
4. `release-coding-trajectory.test.ts`: cross-surface coding migration
5. `task-list-team-trajectory.test.ts`: Agent Team coordination
6. `cross-provider-fallback-trajectory.test.ts`: cross-Provider fallback
7. `goal-mode-trajectory.test.ts`: Goal creation, execution, and completion
8. `browser-tool-trajectory.test.ts`: native Browser Tool
9. `acp-remote-filesystem-trajectory.test.ts`: ACP remote filesystem

The release matrix sets `REAL_API_TEST=1` and
`REAL_API_RELEASE_MATRIX=1`, fixes Vitest retry at zero, and requires DeepSeek
Flash and Pro. Cross-Provider cells that require Claude or GPT fail closed when
their credentials are unavailable; they do not degrade to mocks.

These trajectories require real Provider requests and host-observable effects:
file content, durable events, tool results, browser state, ACP updates, or test
process results. Model claims, HTTP `200`, mocked ToolExecutors, and jsdom-only
coverage are not substitutes.

### General Real API Inventory

`bun run test:real-api` also uses an explicit inventory rather than scanning
the directory. The current inventory contains the nine files above plus:

10. `goal-paused-usage-trajectory.test.ts`
11. `workspace-agent-resources-trajectory.test.ts`

The 40-cell `goal-paused-usage` extension is enabled only with
`REAL_API_RELEASE_MATRIX=1`. `workspace-agent-resources` always runs its
built-in DeepSeek skill trajectory and adds workspace isolation when GPT
credentials are configured. To run every release-only cell in the current
inventory, use:

```bash
REAL_API_RELEASE_MATRIX=1 bun run test:real-api
```

Deleting or renaming an inventory file makes the runner fail before Vitest
starts. New real API trajectories must be added explicitly to the relevant
inventory and source-contract test so directory changes cannot silently shrink
the gate.

Ordinary `test:all` and CI do not issue paid requests. Domestic model channels
are excluded from the release gate unless
`REAL_API_INCLUDE_OPTIONAL_PROVIDERS=1` is explicitly set.

## Qualification Evidence

Each independent patch retains at least:

- the frozen candidate SHA, version, and date;
- command, result, and exit code for `bun run qualify:local`;
- command, per-file results, and exit code for `bun run qualify:production`;
- browser preflight, process/lease/terminal/port/temp-root cleanup, and
  credential-absence assertions;
- bounded redacted diagnostics and cleanup results for the first failing cell;
- `git diff --check`, build, type-check, and lint results.

Only a Provider transient with unchanged source permits a complete rerun.
Skipped tests, model prose, and prefilled `PASS` text are not qualification
evidence.
