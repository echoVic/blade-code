# ACP Terminal Capability Routing Release Evidence

- Date: 2026-08-17
- Version: `blade-code@0.10.45`
- Qualified implementation:
  `4991291e2415f90988580de42cdd5e4dff3c0f93`
- Local Qualification command: `bun run qualify:local`
- Production Qualification command: `bun run qualify:production`
- Local log SHA-256:
  `af0bb9989a16f9365c9fd73f0627e2977f4e382b2a810b828623f9a1299818fa`
- Production log SHA-256:
  `230a8b32406f8e674d609c2ec9b42df4c18af3c209d527361db77a39f23fcf22`

## Result

Local Qualification passed 14/14 checks. Production Qualification passed all
16 checks from the same clean implementation commit.

- Unit: 3,253 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless runtime: 298 passed
- End-to-end: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 418 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 139 passed across 29 files

The release-blocking real-API suite completed in 2383.42s. It exercised
production Chromium Web GUI, real ACP stdio, raw PTY TUI, and production
Headless paths. The new ACP durable fork trajectory is now one of the 29
release-blocking files instead of an optional soak-only file.

The complete run contained two disclosed retry-assisted passes in pre-existing
controls. Both exact final-head cells passed independent `--retry=0` runs.

All retained release logs passed a credential-pattern scan. Debug
instrumentation, its server, record, environment file, and NDJSON evidence were
removed before the qualified commit.

## Closed Runtime Gap

`AcpServiceContext.initializeSession()` previously created
`AcpTerminalService` for every ACP Session, whether or not the Client advertised
the terminal capability.

A paired ACP Client without terminal support could therefore:

1. create a parent Session;
2. complete a real Provider Read turn;
3. fork the durable Session;
4. complete Write through the negotiated filesystem;
5. fail every Bash verification before process creation.

The SDK returned no terminal object for the unadvertised method. Blade then
normalized the resulting `terminalId` access failure as terminal
unavailability. Relative and absolute Bash commands failed identically, so
model retries could not recover.

The bug existed in the `v0.10.42` control and was not introduced by Session
Runtime residency. It escaped release qualification because
`acp-session-fork-trajectory.test.ts` was not in the release-blocking file
list.

## Runtime Evidence

The pre-fix debug run used the exact Flash/Pro paired-SDK trajectory with
framework retry disabled.

Observed invariants:

- durable fork cwd, metadata project path, Runtime workspace, and Bash
  effective cwd were identical;
- child identity was distinct from its parent;
- child mode and persisted permission mode were both `yolo`;
- Bash entered its execution function after permission approval;
- Client terminal capability was false;
- the selected service was nevertheless ACP;
- `createTerminal` produced no terminal object;
- the normalized result was `transport=acp`,
  `failureKind=unavailable`, and `exitCode=null`.

Pre-fix outcome:

```text
DeepSeek Flash: failed after Write success and Bash failure
DeepSeek Pro:   failed after Write success and Bash failure
```

Post-fix evidence changed only the backend selection:

- Client terminal capability false selected `local`;
- the backend default cwd was the owning Session workspace;
- Bash returned `transport=local`, `success=true`, and `exitCode=0`;
- the exact Flash/Pro run passed 2/2 with `--retry=0`.

The post-fix result rejects cwd, residency identity, permission recovery, and
result mapping as root causes. Capability routing was the confirmed cause.

## Final Contract

Terminal ownership is decided once when each ACP Session initializes.

### Advertised terminal capability

- Blade creates `AcpTerminalService` for the exact Session and connection.
- Foreground Bash and user-shell requests retain their Session ID and cwd.
- ACP terminal create or execution failure remains fail-closed.
- Local fallback still requires an explicit per-call opt-in.
- A transient remote terminal error cannot silently execute the command in the
  Agent host.

### Missing terminal capability

- Blade does not call an unnegotiated ACP terminal method.
- It creates a Session-owned `LocalTerminalService`.
- The backend stores the Session workspace as its default cwd.
- An explicit command cwd still overrides the Session default.
- The result is labeled `terminal_transport=local`, not
  `local_fallback`.

This is backend selection, not error fallback. It preserves the security
boundary for Clients that advertise remote terminal ownership.

## Reference Basis

The implementation was compared with:

- Grok Build
  `crates/codegen/xai-grok-workspace/src/session/tool_config.rs`, where a
  Session context is built from the resolved child cwd and terminal backend;
- Grok Build
  `crates/codegen/xai-grok-workspace/src/handle.rs`, where each fork owns a
  distinct terminal backend and tests verify cwd override ownership;
- Codex
  `codex-rs/app-server/src/request_processors/thread_processor.rs`, where
  terminal cwd remains explicit request state;
- ACP capability negotiation, which prohibits calling Client methods that were
  not advertised.

Blade keeps its existing ACP remote-terminal implementation and durable fork
model. The change is limited to capability-aware backend selection and a
Session-bound local cwd.

## Deterministic Coverage

`service-context.test.ts` now proves that a Session without terminal capability:

- executes through a local transport;
- creates a relative marker under the Session workspace without an explicit
  command cwd;
- never sends an ACP terminal create request;
- cleans the temporary workspace.

The existing service-context matrix continues to prove:

- two terminal-capable Sessions route to distinct ACP connections;
- cumulative output is serialized and bounded;
- nonzero exits preserve output without transport misclassification;
- timeout, abort, output-stall, and finalization cleanup;
- advertised ACP terminal creation failure is fail-closed;
- explicit local fallback remains separately labeled;
- local process-tree capture and cleanup remain bounded.

`test-runner.test.ts` now source-gates the ACP fork trajectory in the fixed
release-blocking file list.

Focused deterministic result:

```text
2 files passed
24 tests passed
```

## Real API Target Matrix

The focused target used the same parent Read, durable fork, child Write, and
Bash verification contract for every configured Provider. Framework retry was
disabled.

| Provider class | Result | Duration | Framework retry |
| --- | --- | ---: | ---: |
| DeepSeek Flash | passed | 6.980s | 0 |
| DeepSeek Pro | passed | 25.466s | 0 |
| Claude | passed | 20.003s | 0 |
| GPT | passed | 20.039s | 0 |
| Domestic | passed | 55.099s | 0 |

Focused five-Provider log SHA-256:

```text
e28551fce908b888ad970be1186e71a9de4bc5f24ad4613d56e9430d8473f750
```

The complete Production Qualification included the nine deterministic ACP
harness cases plus Flash, Pro, Claude, and GPT real fork cells:

| Provider class | Full-run result | Duration |
| --- | --- | ---: |
| DeepSeek Flash | passed | 9.764s |
| DeepSeek Pro | passed | 22.416s |
| Claude | passed | 20.741s |
| GPT | passed | 99.438s |

Domestic remains an explicitly enabled optional qualification Provider and is
proven by the focused zero-retry target above.

The target checks exact file content and hash, child-only writes, inherited
Read evidence, parent transcript immutability, child lineage, standard
`session/close`, connection cleanup, and absence of credential text.

## Surface Non-Interference

The complete release matrix also passed:

- production Chromium Web GUI Session, Task, reload, and admission controls;
- raw PTY TUI root turns, crash recovery, foreground output, and Goal controls;
- production Headless coding, recovery, shutdown, and single-Runtime controls;
- terminal-capable ACP output, handoff, recovery, admission, close, and model
  switch controls.

These controls prove that selecting local terminal only for a missing ACP
capability does not alter Web, TUI, Headless, or terminal-capable ACP behavior.

## Retry Disclosure

The complete 139-test Production Qualification contained two retry-assisted
passes:

```text
Goal finalization, DeepSeek Pro raw PTY: retry x1
Foreground bounded output, DeepSeek Pro Web: retry x1
```

Neither is an ACP terminal capability target.

The exact final-head Goal finalization cell passed 1/1 with `--retry=0` in
20.393s. Its log SHA-256 is:

```text
0e81fe6e7f5b7719b907099b65e2a4ec770b5c2b2d35a7c742994a10ae262f86
```

The exact final-head bounded-output Web cell passed 1/1 with `--retry=0` in
16.875s. Its log SHA-256 is:

```text
9853709ca82e85dfbdfd86aff7ec4ed0c4522837320a0a8cc2f1c6763ee424a2
```

Neither exact log contains a retry marker. Business-level retry and recovery
tests remain release-blocking and passed; they are not framework retries.

## Release Boundary

The exact qualified implementation is
`4991291e2415f90988580de42cdd5e4dff3c0f93`.

The next commit may add only this evidence file. The annotated `v0.10.45` tag
must contain no unqualified runtime, test, release-matrix, version, lockfile,
changelog, or user-documentation change.
