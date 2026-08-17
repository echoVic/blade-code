# Release Qualification Determinism Evidence

- Date: 2026-08-17
- Version: `blade-code@0.10.47`
- Qualified commit: `4372090e0dc62513c33b9509e1140810231ad8ba`
- Local command: `bun run qualify:local`
- Production command: `bun run qualify:production`

## Result

The qualified commit passed every release gate.

- Local Qualification: 14/14
- Production Qualification: 16/16
- Unit: 3,257 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless core: 298 passed
- E2E: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 418 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 139 passed across 29 files
- Framework retry: 0

The release-blocking real-API suite completed in 2,859.90 seconds.

The retained local log has SHA-256:

```text
5a287ea634058c13ccdc2aac73e50dba3eb8e784e87488a81c4657b67fbef8a2
```

The retained production log has SHA-256:

```text
db85ae0bec0502e8dabc13609fa28e2b2424e401e5fc038008fa899204d85372
```

## Interrupted Shutdown Contract

All eight DeepSeek Flash/Pro x Headless/ACP/raw PTY/production Chromium
shutdown cells passed. Each cell:

- started one real foreground Bash through a real Provider response;
- sent the production shutdown signal after a host-visible PID barrier;
- persisted one model-visible `<turn_aborted>` system marker before the
  cancelled turn terminal;
- resumed the same durable input with exactly one additional Provider request;
- did not launch Bash a second time;
- removed the foreground lease and complete process tree;
- left the delayed forbidden side effect absent.

The real Provider payload, canonical JSONL, process/lease state, and delayed
side-effect control are the authorities. Model paraphrasing is not used as the
only proof that the interrupted marker was recovered.

## Root-Turn Terminal Boundary

An earlier full Production Qualification exposed one failure:

```text
Test Files 28 passed, 1 failed
Tests 138 passed, 1 failed
deepseek-v4-pro auto-resumes through the real TUI raw PTY
```

The old driver searched terminal output for the same marker that already
appeared in the recovered user prompt and the `Read` result. It therefore
started a fixed ten-second inbox-removal window while the TUI still displayed
the active spinner. Flash happened to complete inside that window; Pro did not.

The final fixture and driver use two independent authorities:

1. The expected assistant response is a token that does not appear in the
   prompt, marker file, or `Read` output. The prompt provides separated quoted
   segments, so a history or tool-result replay cannot satisfy the terminal
   assertion.
2. The raw PTY driver receives the exact durable input message ID. After the
   unique response becomes visible, it loads canonical Session events and
   requires an `inbox_acknowledged` containing that ID plus a later
   `turn_completed` for the turn that claimed the same ID.

The authoritative root-turn matrix passed:

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 4.271s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 3.269s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 16.010s | passed |
| DeepSeek V4 Flash | production Chromium Web + reload | 16.336s | passed |
| DeepSeek V4 Pro | Headless bare resume | 4.460s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 3.583s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 23.196s | passed |
| DeepSeek V4 Pro | production Chromium Web + reload | 27.124s | passed |

All eight cells passed in the full Production Qualification with framework
retry disabled.

## Additional Determinism Evidence

The same Production run also proved:

- production Task Home waits for explicit workspace/model dispatch readiness
  before submitting an overweight task;
- TUI subagent failure state contains a bounded host-rendered terminal summary;
- weighted Provider raw PTY completion waits for hidden inbox acknowledgement
  and a later turn completion before teardown;
- Goal PTY follow-up input does not contain the complete expected response;
- durable Web interaction recovery uses a completion window later than the
  runtime watchdog and always shuts down its route controller;
- virtualized completed Bash cards are expanded through durable tool-call
  identity instead of a detachable element handle;
- hard-killed descendant detection uses a host-released gate after lease
  removal, not a wall-clock side-effect race;
- foreground gate-release failure is injected only after observed stdout
  exceeds the retained budget;
- permission-mode Web/ACP/Headless recovery uses the unified 180-second
  Provider timeout and `maxRetries=0`.

## Optional Provider Disclosure

A separate non-release-blocking ACP root-turn soak used the configured domestic
model profile after the response-marker false positive was removed. The model
did not produce a final response before the 180-second runtime hard timeout or
the 210-second test completion window. The failure was retained as a real
Provider/channel soak failure and was not converted into a pass by matching
replayed user input.

The fixed release matrix excludes optional domestic-provider soak by default.
Its required DeepSeek Flash/Pro, Claude, and GPT ACP fork cells passed. The
optional domestic root-turn result is not counted in the 139/139 release claim.

## Package Verification

`npm pack` rebuilt the package from the qualified source. The resulting
`blade-code-0.10.47.tgz` has SHA-256:

```text
e4ed47fabfd89c66422149c451d5beec0aa5170c4b6cf852c18c415d537c5ead
```

A canonical-path fresh npm application installed the tarball and verified:

- `npm ls --depth=0`: `blade-code@0.10.47`
- `blade --version`: `0.10.47`
- `blade --help`: successful, 7,355 bytes

## Release Boundary

The exact runtime, tests, package metadata, lockfile, and build inputs qualified
by real API are at
`4372090e0dc62513c33b9509e1140810231ad8ba`.

The release tag may add only this evidence file after the qualified commit. No
runtime, test, package, lockfile, build input, or user-facing behavior may
differ from the qualified commit.
