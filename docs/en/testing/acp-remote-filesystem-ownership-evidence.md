# ACP Remote Filesystem Ownership Qualification Evidence

## 2026-08-30 Final Release Qualification

- Design commit: `d683bf97`
- Implementation-plan commit: `46e7a5c9`
- Scope: record the final release-qualification evidence for ACP
  remote-filesystem ownership, including the user contract, deterministic
  coverage, real DeepSeek qualification results, independent review outcomes,
  and the fresh verification commands run in this round.
- Security claim: once an ACP Client advertises any text filesystem capability
  at Session initialization time, Blade freezes that Session's text-file owner
  as remote. Read / Write / Edit / ApplyPatch are then evaluated only against
  that frozen owner. Missing protocol capabilities fail closed and do not fall
  back to same-named host paths on the Blade machine.
- Limitations: this evidence covers only ACP 1.3.0's existing
  `readTextFile` / `writeTextFile` surface. It does not claim support for
  binary reads, stat, mkdir, delete, rename, remote parent creation, or a true
  multi-file remote transaction API.
- Read-back verification is bounded to 5s. The ACP `writeTextFile` call itself
  still depends on the transport lifecycle bound; that remains an existing
  availability limitation of the current protocol surface, not a gap claimed as
  fixed in this round.

## User contract

### Owner selection and freezing

- If `fs` capability is absent, or both `readTextFile=false` and
  `writeTextFile=false`, the Session keeps the local backend. Local CLI, Web,
  and ACP-local file semantics stay unchanged.
- If either `readTextFile===true` or `writeTextFile===true`, Session
  initialization freezes remote filesystem ownership.
- Transport reconnect does not change the owner. Capability changes require a
  brand-new Session.
- `isAcpMode()` remains a surface/security predicate. It is not the same as the
  remote-filesystem ownership predicate.

### Read / Write / Edit / ApplyPatch

- Remote `Read` accepts UTF-8 text only. Binary encodings, base64, and known
  binary extensions fail closed before any ACP request.
- Remote `Read`, `Write`, `Edit`, and `ApplyPatch` do not fall back to the host
  filesystem after an ACP request failure.
- Remote `Write` and `Edit` require both `readTextFile=true` and
  `writeTextFile=true`. Read-only and write-only Sessions both fail validation
  before any I/O.
- An existing-file remote `Write` / `Edit` requires a prior matching `Read`
  digest from the current Session. If the remote content drifts before the
  mutation, Blade fails on the stale digest and does not send a write request.
- A new-file remote `Write` accepts only an explicit ACP not-found result from
  the preflight read as its read-before-write exception. It does not guarantee
  remote parent creation.
- Remote `ApplyPatch` supports `Update File` only. It performs full preflight
  comparison, per-write read-back verification, and reverse-order verified
  compensation on failure. `Add File`, `Delete File`, and `Move to` fail
  closed.

### Uncertainty and host-private coordination

- `sideEffectsUncertain: true` means Blade cannot prove the final remote state.
  Callers must `Read` again before retrying.
- `sideEffectsUncertain: false` means this path has no remaining unproven
  side effects, or rollback has been verified. It does not guarantee success.
- Opaque host-private coordination is limited to Session-bound hashes, tokens,
  and timing facts. It cannot contain remote path, remote content, or remote
  digest, and it cannot be treated as evidence of remote existence, permission,
  or mutation.

## Implementation commits and responsibilities

| Commit | Responsibility |
| --- | --- |
| `4f0525cf` | Freeze filesystem backend ownership and prevent in-place owner switching |
| `2e4c8a19` | Snapshot filesystem capabilities so later caller mutation cannot affect a live Session |
| `837feb1a` | Redact remote filesystem errors and remove raw client-error logging |
| `2e3b1987` | Add the Session-scoped remote digest ledger and lexical remote-path normalization |
| `b5c8a40a` | Isolate remote UTF-8 text reads and block host fallback |
| `2282b980` | Preserve ACP-local and local-backend metadata/fallback semantics |
| `786c4d26` | Add read-before-write, read-back verification, and host-canary boundaries for remote mutation |
| `f3cef4e4` | Complete remote mutation classification, uncertainty, and cancellation behavior |
| `2410e060` | Isolate remote ApplyPatch coordination from host-private state |
| `01b3b0b5` | Close patch review gaps around metadata, ledger, host canaries, and typed fixtures |
| `f978189c` | Scope patch-failure metadata to remote ownership only |
| `2c69de31` | Add remote-filesystem ownership qualification coverage, including real API trajectories |
| `e82ef9e2` | Harden qualification cleanup against timer leaks and teardown masking |
| `5617c0e7` | Refresh the durable snapshot fixture contract so snapshot-tool tests match the current AcpServiceContext interface |
| `8cf43def` | Fix duplicate initialize overwriting owner/ledger and remove ApplyPatch ownership predicate re-inference |
| `53229ad3` | Tighten remote Read redaction, complete abort-safe compensation, and make uncertain summaries truthful |

## Exact RED reasons

- Missing ownership-freeze and opaque-coordination APIs let ACP mode and remote
  ownership blur together.
- Duplicate initialize calls within one Session could overwrite a frozen owner
  and its ledger.
- Remote-path handling could fall back to host lexical paths or same-named host
  files.
- ApplyPatch could re-infer ownership instead of obeying the Session's frozen
  ownership predicate.
- Remote error logging exposed raw client errors and sentinel payloads.
- Remote `Read` could still leak the raw ACP error surface.
- No digest ledger or read-before-write barrier meant Blade could not prove that
  the current Session had previously read the same content.
- Remote mutations lacked read-back verification, uncertainty classification,
  and cancellation boundaries.
- ApplyPatch still lacked remote-only metadata, ledger integration, host
  canaries, typed fixtures, and ACP-local predicate separation.
- An abort path could short-circuit compensating rollback after earlier writes
  had already been verified.
- The uncertain summary could over-claim instead of truthfully saying the final
  state was unproven.
- Tool formatters lacked a generic uncertainty warning for failed remote
  mutations.
- The real paired harness lacked enough ENOENT and event-correlation proof.
- The qualification harness had timer-leak and teardown-error-masking gaps.

## What the deterministic suite proves

- Capability matrix: no-fs / all-false stays local; any exact-true text
  capability freezes remote ownership.
- Exact remote request sequences are asserted, including the real-API
  `read:source/read:output/write:output/read:output` trajectory.
- Host canaries prove the host source stays unchanged and the host output parent
  is not created by a remote write.
- The ledger barrier proves existing remote write/edit requires a matching prior
  Session read digest.
- Rollback uncertainty is classified separately from verified rollback.
- Opaque locks and coordination keys remain Session-bound and do not expose host
  paths to the model or transcript.

## Real DeepSeek ACP qualification

Command:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
```

Result:

| Qualification ID | Result | Duration | Framework retry |
| --- | --- | ---: | ---: |
| `deepseek:deepseek-v4-flash` | passed | 6.373s | 0 |
| `deepseek:deepseek-v4-pro` | passed | 5.000s | 0 |

The real-API trajectory asserts:

- the exact model IDs are `deepseek:deepseek-v4-flash` and
  `deepseek:deepseek-v4-pro`;
- each cell ends with `stopReason=end_turn`;
- each cell has exactly one successful `Write` result;
- the request sequence is exactly
  `read:source/read:output/write:output/read:output`;
- host source unchanged, host output parent absent, final marker present, and
  host canary absent all hold;
- framework retry stays at 0;
- secret scanning passes, and the evidence never records API keys, raw remote
  content, raw user-content digests, or client-private error payloads.

The canonical evidence digest includes only:

- `qualificationId`
- `frameworkRetryBudget`
- labeled `requestSequence`
- `writeResultCount`
- `hostSourcePreserved`
- `hostOutputParentAbsent`
- `outputContainsFinalMarker`
- `outputExcludesHostCanary`

It explicitly excludes random path, sessionId, nonce, raw content, credentials,
and client-private errors.

Canonical evidence digests:

| Model | Digest |
| --- | --- |
| `deepseek:deepseek-v4-flash` | `b2aef283d1853f971820e0761a68ffab94b4790cf1cb09008657f74d8dc17898` |
| `deepseek:deepseek-v4-pro` | `62e65bc4554273fc5d837ea7fd00cde2ce55dc8e008ddaa0302d1e81adfdf297` |

This run's real-API stdout did not print the digest values directly. The
numbers above are retained from the stable canonical helper output. Because the
trajectory assertions still passed in this run and the canonical input field
set is unchanged, we keep them here as reproducible digests rather than
claiming they were freshly extracted from stdout.

## Independent review

- Final whole-patch specification review completed after `8cf43def` with
  conclusion `✅ Spec compliant`.
- A narrow regression specification review completed after `53229ad3` with
  conclusion `✅ Spec compliant`.
- The final quality review initially found `2 Critical + 1 Minor`.
- After `53229ad3`, the closure review concluded `APPROVED` with
  `0 Critical / 0 Important` remaining.
- Reader test: `PASS`.

Together these reviews confirm that owner selection, owner freezing, reconnect
boundaries, uncertainty handling, and ApplyPatch compensation all fail closed,
and that evidence stays structural instead of retaining secrets or remote
content.

## Stage A fresh verification

### Focused

Command:

```bash
cd packages/cli
bun x vitest run --config vitest.config.ts \
 tests/unit/agent-runtime/acp/file-system-service.test.ts \
 tests/unit/agent-runtime/acp/service-context.test.ts \
 tests/integration/acp-remote-file-tools.test.ts \
 tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
 tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
 tests/integration/apply-patch-tool.test.ts \
 tests/integration/apply-patch-transaction.test.ts \
 tests/unit/integration/remote-filesystem-qualification-harness.test.ts \
 tests/unit/platform/ui/utils/tool-formatters.test.ts \
 tests/unit/tooling/tools/builtin/file/durable-snapshot-tool-integration.test.ts
```

Result: exit 0; `10 files passed`, `193 tests passed`, `0 failed`.

### Repo root

- `bun run type-check`: exit 0.
- `bun run lint`: exit 0.
- `bun run build`: exit 0. Only the existing Browserslist-data and Web chunk
  size warnings remained.
- `bun run test:all`: exit 0.
  The non-performance result was
  `Test Files 454 passed | 92 skipped (546)` and
  `Tests 4910 passed | 84 skipped (4994)` with duration `304.68s`.
  The performance result was
  `Test Files 4 passed | 1 skipped (5)` and
  `Tests 9 passed | 1 skipped (10)` with duration `5.12s`.

### Real API ACP filesystem

Command:

```bash
cd packages/cli
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
```

Result: exit 0; `1 file passed`, `2 tests passed`; `deepseek:deepseek-v4-flash`
completed in `6.373s`, and `deepseek:deepseek-v4-pro` completed in `5.000s`.

### Final verification after release metadata

After updating `packages/cli/package.json` to `0.10.126` and synchronizing the
two authoritative changelogs, the repository-root command was run again:

```bash
bun run build && bun run test:all
```

Result: exit 0. The CLI, Web, and VSCode builds all succeeded; the only build
warnings were the existing stale Browserslist data and Web chunk-size warning.
The non-performance suite reported
`Test Files 454 passed | 92 skipped (546)` and
`Tests 4910 passed | 84 skipped (4994)` with duration `300.59s`; the performance
suite reported `Test Files 4 passed | 1 skipped (5)` and
`Tests 9 passed | 1 skipped (10)`.

### Diff hygiene

Command:

```bash
git diff --check
```

Result: exit 0.

## What this does not prove

- It does not prove ACP 1.3.0 supports binary reads, stat, mkdir, delete,
  rename, or remote parent creation.
- `sideEffectsUncertain=false` does not prove upper-layer success. It proves
  only that Blade no longer has an unclassified remote side effect on that path.
- The real-API qualification proves one controlled paired-ACP ownership
  trajectory, not every possible workflow a model might attempt.
