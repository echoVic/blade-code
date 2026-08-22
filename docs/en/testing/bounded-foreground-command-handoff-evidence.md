# Bounded Foreground Command Handoff Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.36`
- Qualified runtime and test commit:
  `bd594c62f869c3c6d0fe5c3fb65c90c25270ba39`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification passed all 16 checks.

- Unit: 2,994 passed, 1 skipped
- Full CLI suite: 3,242 passed, 71 skipped
- Web: 411 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 94 passed across 18 files

The release-blocking real-API suite completed in 1608.09s. The same production
run type-checked and linted the CLI, VS Code extension, and Web application,
verified formatting, ran the complete deterministic qualification, built the
production CLI/Web/VS Code artifacts, and launched the pinned Playwright
Chromium binary successfully.

The built CLI, `packages/cli/package.json`, and `bun.lock` all reported
`0.10.36`.

## Handoff Matrix

Every cell called a real DeepSeek Provider and required a foreground Bash call
whose timeout exceeded the configured 1,000ms foreground blocking budget. A
host-owned barrier kept that command alive while the model completed an
independent Read. The host then released the same process and required the
model to collect its terminal output through TaskOutput.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 7.381s | 0 | passed |
| DeepSeek V4 Flash | ACP stdio + PTY terminal | 9.095s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 24.423s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 16.234s | 0 | passed |
| DeepSeek V4 Pro | Headless JSONL | 13.955s | 0 | passed |
| DeepSeek V4 Pro | ACP stdio + PTY terminal | 15.589s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 31.710s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 21.034s | 0 | passed |

All eight focused handoff tests also passed without retry in 127.31s before
the complete production qualification.

Each cell proved:

- the fixture launch count remained exactly one before and after handoff;
- one OS PID or one ACP terminal execution crossed the ownership boundary
  without a local fallback or command replay;
- the durable tool order was exactly `Bash -> Read -> TaskOutput`;
- the command remained active while Read completed and before the host barrier
  was released;
- TaskOutput contained output emitted both before and after handoff;
- typed `auto_backgrounded`, `foreground_budget_ms`, `shell_id`, and
  `terminal_transport` facts reached the active surface;
- Web rendered the background state and shell identity in the expanded Bash
  card, then preserved the terminal result after reload;
- every child, lease, terminal, PTY, browser, page, SSE reader, server, port,
  temporary root, and credential-bearing config was reclaimed.

## Graceful Shutdown Control Matrix

The pre-existing graceful-shutdown matrix was rerun after its raw-PTY harness
was hardened. It passed all eight cells without retry in the final production
qualification:

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 21.852s | 0 | passed |
| DeepSeek V4 Flash | ACP stdio + PTY terminal | 27.220s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 27.437s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 48.987s | 0 | passed |
| DeepSeek V4 Pro | Headless JSONL | 34.044s | 0 | passed |
| DeepSeek V4 Pro | ACP stdio + PTY terminal | 29.036s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 34.159s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 22.980s | 0 | passed |

The focused control matrix passed 8/8 with retry disabled in 271.24s. Two
additional isolated Flash raw-PTY runs also passed with retry disabled. This
control proves that shutdown before the 15-second handoff budget still aborts
the foreground process tree, persists one `turn_aborted`, leaves no foreground
lease or delayed side effect, and resumes without replaying Bash.

## Frozen Bounds

The qualified runtime freezes these production limits:

| Setting | Default | Minimum | Maximum |
| --- | ---: | ---: | ---: |
| Foreground handoff budget | 15,000ms | 1,000ms | 300,000ms |
| Background shells, process-wide | 16 | fixed | fixed |
| Background shells, per Session | 4 | fixed | fixed |

`bashForegroundHandoffMs=0` disables automatic handoff. Any other configured
value must be an integer in the documented range.

The same background capacity accounts for explicit background commands,
hidden local foreground candidates, hidden ACP terminal candidates, and
promoted local or ACP commands. Explicit overflow returns typed,
retryable `resource_exhausted/background_shell_busy` metadata without
spawning. Automatic handoff that cannot reserve capacity remains on its
original foreground execution and preserves the original timeout and abort
semantics.

## Proven Runtime Contract

The deterministic and real-API evidence together proves:

- eligibility requires a Session identity, a timeout greater than the budget,
  a supported transport, available background capacity, and a command that is
  neither readonly audit work nor standalone/leading sleep;
- local execution reserves background capacity before spawn, fsyncs the
  foreground lease before releasing user code, registers the background lease
  for the same root PID before removing the foreground lease, and rolls back
  the next owner if removal fails;
- no lease gap exists during promotion, and a failed handoff commit continues
  the original foreground execution without a second spawn;
- ACP retains the original SDK terminal handle, cumulative output polling,
  terminal kill, final read, release, and completion ownership without
  manufacturing a local ChildProcess;
- timeout or abort before promotion kills and finalizes the hidden candidate
  without exposing a shell identity;
- turn abort after promotion is detached from the handed-off command, while
  KillShell, Session disposal, process shutdown, natural exit, and TaskOutput
  retain bounded lifecycle control;
- hidden candidates are not externally discoverable before promotion and
  count against both global and Session background limits;
- fast foreground completion preserves exact total stdout/stderr accounting,
  including output above the retained 1MiB per-stream projection;
- promotion drops the temporary exact foreground capture, so long-running
  background retention remains bounded by the existing consume buffers;
- Headless emits only a schema-validated background subset, Web replay keeps a
  strict Bash metadata allowlist, and TUI/ACP consume the same durable result;
- ACP WriteStdin reports an explicit unsupported result instead of pretending
  stdin reached an external terminal;
- Provider credentials are absent from JSONL, transcripts, logs, browser
  output, ACP traffic, PTY capture, diagnostics, and retained evidence.

## Failure and Retry Disclosure

Development qualification caught a cross-cutting regression: a hidden local
candidate initially retained only the bounded background output buffers, so a
large command that completed before handoff lost exact foreground accounting.
That production run was invalidated. The fix keeps a temporary
`ShellOutputCapture` while hidden, drops it immediately on promotion, and is
covered by a greater-than-1MiB deterministic regression plus the existing
eight-cell bounded-output real-API matrix.

The first graceful-shutdown investigation showed a model rewriting one
semantic marker separator from `_` to `-`; the process had shut down and
resumed correctly. The harness now uses an opaque numeric nonce instead of
treating punctuation reconstruction as runtime evidence. Its PTY runner also
waits within a larger but bounded readiness window, reports bounded/redacted
startup diagnostics, detects early terminal exit, and reclaims the full
terminal tree before retry.

Four pre-existing cells used their configured single retry in the final full
production run:

- background-subagent completion, DeepSeek Pro raw PTY: retry x1;
- permission-mode recovery, ACP cold start: retry x1;
- foreground bounded output, DeepSeek Flash raw PTY: retry x1;
- foreground bounded output, DeepSeek Pro Web: retry x1.

No foreground-command-handoff cell, graceful-shutdown control cell,
tool-admission cell, lease-transfer assertion, accounting regression, or
release-coding trajectory retried.

## Release Boundary

The exact runtime and test source qualified by real API is
`bd594c62f869c3c6d0fe5c3fb65c90c25270ba39`. The next commit may add only this
evidence file. The tag must contain no unqualified runtime or test change.
