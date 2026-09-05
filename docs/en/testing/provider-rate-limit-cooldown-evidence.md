# Provider 429 Shared Cooldown Qualification Evidence

- Date: 2026-09-05
- Target version: `blade-code@0.10.139`
- Design baseline: `62a062e1`
- Real-API implementation baseline: `27a6accc`
- Final release HEAD: `df2ff5c9db9b5992e63f0a1257e3f7d71092608f`
- Scope: first authoritative `429 + Retry-After`, same-domain cross-Session suppression, one HalfOpen probe, and TUI/Web/ACP/Headless projection

## Deterministic Production-Surface Qualification

`provider-rate-limit-cooldown.test.ts` launches real Headless, ACP stdio, raw PTY
TUI, and Chromium Web processes from the current production `dist`. Its local HTTP
Provider fixture returns a private-body `429` with `Retry-After-Ms: 5000` only for the
first request, then emits deterministic Bash tool calls and final markers.

The suite passed three consecutive runs, `4/4` each and `12/12` in total. It proves:

- the first 429 opens `opened -> waiting` with one failure sample;
- a second same-domain Session creates no physical request during cooldown;
- process-wide admission grants exactly one `probe`, whose success reaches `closed`;
- Headless JSONL carries `provider_circuit`, `provider_recovery`, `turn_activity`, and terminal clears;
- ACP revisions are monotonic and expose `blade/providerRecovery` plus `blade/turnActivity`;
- raw PTY directly renders the rate-limit wait, probe, Bash activity, and restored composer;
- Web reload restores the rate-limit banner, then the active-tool strip, and clears both at terminal state;
- the API key and private 429 response body are absent from JSONL, ACP, PTY, DOM, SSE, and transcripts.

## Real Provider Matrix

Command:

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/provider-rate-limit-cooldown-trajectory.test.ts
```

The final explicit run used framework retry `0` and passed `8/8` in 115.11s:

| Model | Headless | ACP stdio | raw PTY TUI | Chromium Web |
| --- | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 8.917s | 10.070s | 10.317s | 15.363s |
| `deepseek-v4-pro` | 12.629s | 16.060s | 15.107s | 25.349s |

Each cell injects one local `429 + Retry-After-Ms: 2000` before forwarding to the
real DeepSeek endpoint. Headless and PTY verify single-Session recovery. ACP and Web
also start a second same-domain Session during cooldown and prove zero early upstream
requests, one probe, and eventual completion of both Sessions. Every trajectory requires
the exact Edit, exact Bash verification, final marker, bounded diff, and no secret or
private-body disclosure.

During development, ACP and PTY passed the first matrix run, while Headless and Web
still carried attempt assertions from the older four-503 trajectory. After changing the
contract to `attempt=1` and circuit-first recovery projection, the complete eight-cell
matrix passed once with framework retries disabled in release mode.

The first pre-tag rerun then caught a raw-PTY race under full-suite load: the probe
could complete before the TUI painted that short-lived state, although the same test
had passed the earlier three deterministic runs and coverage. The fixture now holds
the first probe response for a one-second observation window without changing product
code or cooldown duration. Three focused raw-PTY reruns passed after that correction.

## Final Gates

Evidence collected at implementation-and-documentation HEAD
`d28fdcd28085b1940b87101200f0ebd29565dc50`:

- `bun run build`, `bun run type-check`, and `bun run lint`: passed; CLI lint checked
  1,403 files and Web lint checked 208 files;
- `bun run test:all`: passed; the non-performance stage passed 495 files and 5,767
  tests with 99 files and 88 tests skipped; performance passed 4 files and 9 tests with
  one file and one test skipped; total duration was 439.50s;
- `bun run test:coverage`: passed; 495 files and 5,767 tests passed, with 99 files and
  88 tests skipped; statements 73.79%, branches 67.19%, functions 75.65%, lines 75.16%;
- `bun run test:web`: passed; 69 files and 663 tests.

Version metadata was frozen at
`df2ff5c9db9b5992e63f0a1257e3f7d71092608f`; `bun run build && bun run test:all`
will be rerun before tagging and appended below.
