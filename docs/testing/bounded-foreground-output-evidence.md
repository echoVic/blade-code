# Bounded Foreground Output Qualification Evidence

## Candidate

- Version: `0.10.28`
- Qualified candidate:
  `25c496e751b402fe22483a4e7f0b257ed24dff1b`
- Candidate branch: `feat/bounded-foreground-shell-output`
- Qualification date: 2026-08-13

## Production Qualification

`bun run qualify:production` exited `0` and passed all 16 checks:

1. Type check
2. Format check
3. Lint
4. Unit tests
5. Integration tests
6. CLI tests
7. Headless runtime tests
8. End-to-end tests
9. Snapshot tests
10. Security tests
11. Production build
12. Web tests
13. Web type check
14. Performance regression tests
15. Chromium browser preflight
16. Release-blocking real API trajectories

Deterministic suite summaries:

- unit: 2835 passed, 1 explicit skip;
- Web: 405 passed;
- security: 38 passed;
- performance: 7 passed, 1 explicit skip;
- Chromium preflight: pinned Playwright Chromium launched and closed;
- release-blocking real API: 35/35 passed across 11 files in 484.20 seconds.

The existing headless permission-recovery trajectory used its configured single
retry and passed. The bounded foreground output cells all passed on their first
attempt.

## Six-Cell Matrix

| Model | Surface | Result | Duration |
| --- | --- | --- | ---: |
| `deepseek-v4-flash` | production Chromium Web | PASS | 13.130s |
| `deepseek-v4-flash` | raw PTY TUI | PASS | 12.316s |
| `deepseek-v4-flash` | ACP SDK terminal | PASS | 10.222s |
| `deepseek-v4-pro` | production Chromium Web | PASS | 13.240s |
| `deepseek-v4-pro` | raw PTY TUI | PASS | 14.488s |
| `deepseek-v4-pro` | ACP SDK terminal | PASS | 12.013s |

Every cell used exactly one foreground Bash call. Local Web/TUI cells emitted
1,114,112 bytes on each of stdout and stderr. ACP cells observed one merged
2,228,224-byte stream. Host assertions proved:

- retained bytes never exceeded 1 MiB per captured stream;
- omitted-byte counters were positive and accounting was complete;
- omitted-prefix sentinels were absent while both tail sentinels remained;
- durable metadata identified the expected local or ACP transport;
- foreground leases were empty after completion;
- owned launcher, PTY and ACP terminal processes no longer matched their
  captured process identities;
- structured evidence contained no provider credential.

## Surface Evidence

Web used the production `dist/blade.js serve` entrypoint and a real pinned
Chromium. The driver selected YOLO through the visible GUI and confirmation
dialog, submitted through the composer, checked the live Bash card, reloaded
the page, and checked the fresh-load card again. Both cards retained stdout and
stderr tails, exposed one truncation notice, and stayed within the 500-character
display budget. Page errors, console errors, HTTP 4xx/5xx responses and
unexpected request failures were release-blocking.

TUI used `bun-pty`, bracketed paste, a real resize, EOF/TERM/KILL cleanup and a
bounded ANSI tail. Serialized evidence stripped terminal control sequences and
kept only the latest 8 KiB while preserving the expected marker, both stream
tails and the truncation notice before and after resize.

ACP used real `ClientSideConnection` and `AgentSideConnection` NDJSON codecs
with a Bun child-backed PTY terminal. Raw terminal output did not enter progress
updates. The terminal result retained both merged tails, omitted both prefixes,
released the handle exactly once, exited its captured process identity, and
`session/load` replayed zero historical tool calls or private metadata.

## Failure And Rerun Evidence

The first production run used candidate `f8245afd3bd1617239ab84e10bed42c8dd1f68f9`.
It completed 28/35 real API tests and exposed seven release-blocking failures:
all six new cells plus the existing ACP model-switch trajectory.

- Web was waiting for permission because the browser's default `autoEdit` mode
  overrode the isolated config. The final driver selects and confirms YOLO
  through the real GUI, waits on authoritative run status, and distinguishes
  intentional EventSource cancellation from network failure.
- PTY kept a bounded raw ANSI tail, but JSON escaping could exceed the outer
  serialized budget. Evidence now strips control sequences and applies a second
  explicit serialized-output bound.
- ACP attempted to load `bun-pty` inside the Node Vitest process and surfaced an
  internal terminal-unavailable result. The final matrix runs ACP through a Bun
  subprocess while retaining the real SDK NDJSON connection and PTY lifecycle.
- The ACP model-switch fixture advertised no terminal capability after terminal
  execution became fail closed. It now supplies a real child-process terminal
  and proves the selected Pro model performs the edit and `node --test`.

After deterministic regressions passed, each affected surface and ACP
model-switch passed in isolation. A complete six-cell run then passed 6/6
without retries. The frozen final candidate subsequently passed the full
16/16 production qualification and 35/35 release-blocking real API suite.
