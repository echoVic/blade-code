# Raw PTY Composer-Ready Handshake Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.116`)

- Implementation commit: `4bd61033180e70a89c6b58b14858828b19d7fa46`
- Goal: eliminate the race where raw PTY runners sent a large bracketed paste
  before the TUI input handler was registered.

### Repaired handshake contract

- The test host creates an independent 32-character lowercase hexadecimal nonce
  for each PTY child and passes it through `BLADE_TUI_COMPOSER_READY_NONCE`.
- The main composer emits the exact
  `ESC]99;blade-composer-ready=<nonce>BEL` OSC marker only after its active input
  handler has been registered.
- An absent or malformed nonce emits nothing, preventing an environment value
  from injecting an arbitrary terminal control sequence.
- All 10 raw PTY runners that submit prompts must observe their child's exact
  marker before sending bracketed paste. Their post-paste acknowledgements and
  existing final-marker contracts remain unchanged.
- The token-budget runner no longer treats five seconds of bracketed-paste mode
  as composer readiness, and its rolling scan retains the complete readiness
  marker across PTY chunk boundaries.

### TDD and review disclosure

- The initial RED cases proved that the production marker module, shared handshake
  helper, and registration callback did not exist.
- The first direct focused run after implementation reported 63 passed and 1
  failed. The readiness component test had omitted the production
  `TerminalInputRouterProvider` topology; this was not treated as a runtime pass.
  After repairing the fixture and adding absent, malformed, and valid nonce
  coverage, the suite passed 71/71.
- The first independent specification review found one Important issue: the
  token-budget rolling scan did not retain enough tail for the readiness marker.
  It also found one Minor issue: the runner source contract did not lock the
  marker-wait-before-paste ordering. Both received a failing assertion before the
  minimal repair.
- The final focused unit run passed 80/80 tests across 3 files.
- Independent specification re-review and independent code-quality review both
  finished with no findings.
- TypeScript type checking, Biome across 1,292 files, `git diff --check`, and the
  complete CLI, Web, and VSCode build all exited 0. The build emitted only the
  existing Browserslist-data and bundle-size warnings.
- The final release-tree `bun run build && bun run test:all` passed 446
  non-performance files with 91 skipped and 4,574 tests with 85 skipped; the
  performance project passed 4 files and 9 tests with 1 file and 1 test skipped.
  There were no failures.

### Real-Provider raw PTY results

Command:

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=0 bun x vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/token-budget-handoff-trajectory.test.ts \
  tests/integration/real-api/large-prompt-offload-trajectory.test.ts \
  --retry=0 --maxWorkers=1 --no-file-parallelism \
  -t 'deepseek:deepseek-v4-(flash|pro):pty'
```

| Trajectory | Model | Duration | Result |
| --- | --- | ---: | --- |
| Large-prompt offload | DeepSeek V4 Flash | 125.614s | passed |
| Large-prompt offload | DeepSeek V4 Pro | 124.859s | passed |
| Token-budget handoff | DeepSeek V4 Flash | 22.100s | passed |
| Token-budget handoff | DeepSeek V4 Pro | 41.796s | passed |

The final result was 2 files passed, 4 target cells passed, and 12 non-target
cells skipped by the name filter, with exit code 0. All four target cells passed
on their first execution with framework retry disabled; the former
`paste:stage_failed` did not recur. Neither the evidence nor command output
records Provider credentials.

### Release boundary

The `0.10.116` tag may add only this evidence, its Chinese counterpart, the
bilingual changelogs, and the package version after the implementation commit
above. The ACP recovered-metadata egress race must remain a separate patch.
