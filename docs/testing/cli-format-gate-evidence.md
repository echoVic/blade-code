# CLI Format And Release Qualification Gate Evidence

**Version:** `blade-code@0.10.46`

**Date:** 2026-08-17

## Failure Boundary

The published `v0.10.45` source failed its documented second Local
Qualification check:

```text
bun run --filter blade-code format:check
34 formatter diagnostics
```

The monorepo resolved two different formatter binaries:

```text
root:  @biomejs/biome 2.3.9
CLI:   @biomejs/biome 2.5.7
```

GitHub `Quality Gate` did not execute CLI format or CLI lint. It ran build,
CLI/Web type checks, Web lint, and Web tests, so a commit could be green in CI
while the release-blocking local gate was already red.

## Final Contract

The root, CLI, and Web manifests now pin the exact same formatter:

```text
@biomejs/biome 2.5.7
```

The existing formatter drift was repaired mechanically. No production runtime
source changed in this patch.

GitHub `Quality Gate` now executes this order:

```text
bun install --frozen-lockfile
bun run format:check
bun run --filter blade-code lint
bun run build
```

The source contract test rejects removal or reordering of format/lint before
build.

The release-blocking real-API matrix now uses:

```text
REAL_API_RELEASE_MATRIX=1
Vitest retry=0
global process-tree watchdog=60 minutes
```

The ordinary full real-API soak retains its prior retry policy. Only the
release matrix is forced to zero framework retries.

## Watchdog Evidence

The first Production Qualification attempt exposed the prior gate defect:

- every completed assertion was green;
- a GPT ACP fork request took 208 seconds;
- two cells used framework `retry x1`;
- the 45-minute process-tree watchdog terminated the remaining matrix.

Log SHA-256:

```text
f5f9ebae7cf26347f5d66e56e133c90c8c39f683bdba2538f2b1eca4a525df65
```

The gate was then changed to zero framework retries and a 60-minute watchdog.
The complete matrix was rerun from the final committed source rather than
combining partial runs.

## Deterministic Qualification

Local Qualification:

```text
14/14 checks passed
Unit:       3254 passed, 1 skipped
Web:        418 passed
Performance: 7 passed, 1 skipped
```

Log SHA-256:

```text
4851c20c80767f72913307e5bfc5d7adc585fa6d4ed29b2550d4c8413ed1c79a
```

The final Production run repeated all deterministic checks after the
qualification hardening commit:

```text
Unit:          3255 passed, 1 skipped
Integration:    172 passed
CLI:              8 passed
Headless core:   298 passed
E2E:              14 passed
Snapshot:          9 passed
Security:          38 passed
Web:              418 passed
Performance:        7 passed, 1 skipped
```

## Real Provider And Surface Qualification

Final Production Qualification:

```text
16/16 checks passed
29/29 real-API files passed
139/139 real-API tests passed
2496.14 seconds
framework retry markers: 0
```

The matrix includes real DeepSeek Flash/Pro Provider traffic and the configured
Claude/GPT channels. It exercises production Chromium Web GUI, real ACP stdio,
Headless, and raw PTY TUI paths, including:

- crash and durable turn recovery;
- foreground/background process ownership;
- Provider/tool/task admission;
- Session Runtime residency;
- durable interaction recovery;
- Goal finalization and root-turn auto-resume;
- foreground output and command handoff;
- code review, structured output, and coding trajectories.

Final Production log SHA-256:

```text
4f777220d80e99efc78fd15eb9fabac2e52c8e0b93d1752968e8ffdf829d4679
```

No API credential or Provider response body is stored in this document.

## Release Boundary

`0.10.46` is releasable only when:

- all manifests and the lockfile resolve Biome `2.5.7`;
- full format and CLI lint are green;
- CI executes format and CLI lint before build;
- the release real-API matrix has framework retry disabled;
- Local Qualification remains `14/14`;
- Production Qualification remains `16/16` and `139/139`;
- npm pack, isolated install, GitHub CI, coverage, docs, Pages, and
  cross-platform smoke complete successfully.
