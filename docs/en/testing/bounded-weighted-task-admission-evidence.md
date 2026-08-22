# Bounded Weighted Task Admission Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.42`
- Design commit: `bb5c53d8f1b04c408aec53c3cc48f98900473f2f`
- Runtime and deterministic test commit:
  `ad24fafc9105813f535fd53f3581ad8fbd4f80cf`
- Qualified release metadata commit:
  `f6011da977dc1a3747cbcc765ab8a0089aad5d94`
- Final qualification and PTY evidence commit:
  `0ff60440309da59b2dea068417a577b986b7a62f`
- Production command: `bun run qualify:production`
- Final Production Qualification log SHA-256:
  `436a587fcdf8fb0b5a9ee2697fd299b64e514bf9a3a3e972fc5fefa9db3947f5`

## Result

Production Qualification ran from a clean
`0ff60440309da59b2dea068417a577b986b7a62f` worktree and passed all 16
checks.

- Unit: 3,209 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless runtime: 294 passed
- End-to-end: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 418 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 118 passed across 25 files

The release-blocking real-API suite completed in 2184.47s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, built production CLI/Web/VS Code artifacts,
and launched the pinned Playwright Chromium binary.

All four weighted-task target cells passed without framework retry. The four
Headless/raw-PTY non-interference controls and both existing Web task-dispatch
controls also have exact retry-disabled passing evidence. The complete
Production Qualification contained one disclosed retry-assisted pass in the
DeepSeek Pro bounded-output raw-PTY control; its exact final-head
`--retry=0` rerun passed in 24.202s.

The final logs contained no credential literal, Authorization header, Bearer
token, failed test summary, or nonzero qualification exit.

## Closed Retained-Memory Gap

The former process scheduler limited queued task tickets but not the payload
graph retained by each waiting caller. A queued task could retain:

- up to 32,000 prompt characters;
- up to 20 inline attachments and 5 MiB of aggregate inline attachment data;
- an output schema and steering metadata;
- the durable inbox/runtime projection;
- the waiting async caller and generator projection.

The default count limit allowed 100 waiting tasks and configuration allowed up
to 10,000. A count-only bound therefore did not prove a retained-memory bound.
Web prepared inboxes, ACP task Sessions, direct Agent calls, and crash-recovered
durable inboxes all reached the same process scheduler and now use the same
footprint contract.

## Frozen Configuration

`maxQueuedTaskBytes` is a process-wide startup setting.

| Property | Value |
| --- | ---: |
| Minimum | 65,536 bytes |
| Default | 67,108,864 bytes |
| Maximum | 134,217,728 bytes |

Only safe integers in that closed range are accepted. Zero, negative,
fractional, infinite, and out-of-range values fail closed. Project and
Session-local configuration cannot replace the startup scheduler boundary.
The CLI exposes `--max-queued-task-bytes`.

The existing count limit remains independent:

- `maxConcurrentTasks` bounds active task runs;
- `maxQueuedTasks` bounds waiting task tickets;
- `maxQueuedTaskBytes` bounds the aggregate logical retained footprint of
  waiting task inputs.

Public task-capacity surfaces intentionally continue to expose count only.
They do not reveal aggregate bytes, the byte limit, or an individual task
weight.

## Bounded Footprint Estimator

The Provider-specific retained-value walk was extracted into
`src/utils/retainedValueFootprint.ts` and is shared by Provider request and
task admission accounting.

The walk:

- counts UTF-8 string and object-key bytes;
- counts raw Buffer, typed-array, DataView, and ArrayBuffer bytes;
- includes arrays, objects, maps, sets, numbers, bigints, booleans, and null;
- uses object identity to avoid cycles and duplicate object charging;
- never invokes getters;
- ignores functions, symbols, and weak collections;
- saturates above the configured byte ceiling;
- fails closed above 100,000 visited nodes;
- does not stringify or copy the complete payload.

`estimateTaskRunPendingBytes()` charges two conservative projections:

1. the durable inbox and owned Runtime projection;
2. the waiting caller/generator projection.

Crash recovery estimates the actual
`runtime.getPendingSteeringMessages()` contents, including message metadata,
instead of the empty synthetic wake-up message.

## Scheduler Invariants

The process scheduler retains only:

- task key;
- numeric pending byte weight;
- queue snapshot and callbacks;
- abort listener;
- permit state.

It does not retain prompt, attachment, output schema, metadata, Runtime,
worktree, or user-message fields.

Admission order is fixed:

1. validate count/byte limits and numeric weight;
2. apply process-wide scheduler configuration;
3. validate and deduplicate the task key;
4. admit immediately when an active slot is available;
5. reject `pending_count` overflow;
6. reject `pending_bytes` overflow;
7. allocate Promise/callback/listener state;
8. charge bytes and append the FIFO record.

An oversized task may run immediately when active capacity is available
because it retains no waiting-queue charge. The same task is rejected as
`pending_bytes` if it would need to wait. Count wins when count and byte limits
are exhausted simultaneously, preserving the prior overload contract.

Every charged path settles exactly once:

- queued to running;
- explicit cancellation;
- AbortSignal cancellation;
- permit release before execution;
- scheduler test reset;
- coordinated process shutdown.

Promotion uncharges bytes before resolving the waiting admission Promise.
Accounting overflow, double charge, and underflow fail closed.

## Surface Semantics

### Web

Production Task Home submits through the real composer. Byte overload returns:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Task admission capacity is full",
    "details": {
      "resource": "pending_bytes"
    }
  }
}
```

The inline error is visible. The unaccepted Session, inbox, Runtime, worktree,
and in-memory projection are removed. Reload does not materialize a ghost
task. The browser target permits only the one expected `/tasks` HTTP 429
console resource error; all other console, page, request, and SSE errors must
be absent.

### ACP

Multiple task Sessions share the process scheduler. Rejected task prompts
produce no assistant text and persist:

```json
{
  "code": "capacity",
  "message": "Task admission capacity is full. Retry after running tasks complete.",
  "retryable": true,
  "resource": "pending_bytes"
}
```

`session/list` retains that durable failure. A normal third task observes
queued position one and then running after the held task releases.

### Headless And TUI

Headless task-mode coding runs at the legal 64 KiB task byte minimum and
completes real Read/Edit/Bash work for both DeepSeek models. The root TUI is
not a top-level task Session; raw-PTY bounded-output coding proves that the
new task limit does not interfere with ordinary root turns.

## Deterministic Coverage

Focused scheduler, footprint, failure, route, configuration, and source-gate
tests cover:

- exact and one-over count/byte boundaries;
- immediate oversized admission and queued oversized rejection;
- count precedence;
- FIFO promotion and exact uncharge;
- cancellation, abort, reset, and reconfiguration;
- UTF-8, multimodal attachment, output schema, and metadata accounting;
- direct, prepared Web inbox, and recovered durable inbox entry points;
- process-startup configuration ownership;
- typed Web 429 and durable ACP capacity failures;
- hostile error objects;
- public byte-accounting privacy;
- scheduler payload-field and production-bypass search gates.

The final clean-head unit suite passed 3,209 tests with one unrelated skipped
test. Integration, Headless, E2E, snapshot, security, Web, and performance
gates passed with the counts listed above.

## Real API Target Matrix

Every target used:

- DeepSeek V4 Flash or DeepSeek V4 Pro;
- real Provider traffic through the configured endpoint;
- a loopback recording proxy;
- `maxConcurrentTasks=1`;
- `maxQueuedTasks=100`;
- `maxQueuedTaskBytes=65,536`;
- framework retry disabled in the exact feature runs.

| Model | Surface | Result | Final full-run duration |
| --- | --- | --- | ---: |
| Flash | production Chromium Task Home | passed | 12.135s |
| Pro | production Chromium Task Home | passed | 13.290s |
| Flash | ACP stdio task Sessions | passed | 19.137s |
| Pro | ACP stdio task Sessions | passed | 18.771s |

Each target proved:

1. task A held one real Provider request;
2. oversized task B failed as `pending_bytes`;
3. task B's unique marker reached zero Provider requests;
4. normal task C entered FIFO position one;
5. releasing A promoted C;
6. A and C completed independently;
7. proxy maximum in-flight requests remained one;
8. all Runtime, browser/ACP, socket, worktree, HOME, storage, and workspace
   resources were reclaimed.

The focused Flash target log passed 2/2 and the focused Pro target log passed
2/2 without a retry marker.

## Non-interference And Positive Controls

| Model | Control | Result | Duration |
| --- | --- | --- | ---: |
| Flash | Headless task-mode coding | passed | 7.096s |
| Pro | Headless task-mode coding | passed | 8.945s |
| Flash | root raw-PTY coding | passed | 14.100s |
| Pro | root raw-PTY coding, `--retry=0` exact rerun | passed | 24.202s |
| Flash | existing Web worktree task dispatch | passed | 11.787s |
| Pro | existing Web worktree task dispatch | passed | 22.126s |

The focused Headless control log passed 2/2, the focused raw-PTY control log
passed 2/2, and the focused existing Web task-dispatch log passed 2/2. No
focused target or control log contains `retry xN`.

The complete control suite also kept Provider retry/recovery, graceful
shutdown, weighted and fair Provider admission, tool admission, bounded
foreground output, foreground command handoff, Goal, durable interaction and
root-turn recovery, subagent completion/adoption, permission recovery,
structured output, code review, action stationarity, and production coding
trajectories green.

## Failure And Retry Disclosure

The first clean-head Production Qualification passed deterministic checks but
finished the real-API gate at 117/118. DeepSeek Pro's overweight background
child wrote the correct `pending_bytes` sidecar and the raw TUI visibly said
that the child task had failed, but the harness accepted only the narrower
phrases `background subagent failed` and `后台子代理失败`.

The retained failing log has SHA-256:

```text
8b82d111a7f969b5755bef2511c320943d2d4ac4037163df32558619ef6018a3
```

The fix:

- recognizes equivalent visible child-task/agent/subagent failure wording;
- keeps the durable sidecar requirement for the exact `pending_bytes`
  resource;
- adds 10 positive/negative deterministic phrase tests;
- redacts and preserves bounded PTY runner diagnostics on failure.

The exact DeepSeek Pro background-child PTY target then passed 1/1 with
`--retry=0` in 91.147s. Its log SHA-256 is:

```text
837c14b7d8e88b8f7856c2f6c8669ffc3906c61db0450d8982fd260ed18a5eba
```

The second complete Production Qualification passed 16/16 and 118/118. It
contained one retry-assisted pass:

```text
bounded foreground output, DeepSeek Pro raw PTY: retry x1
```

That exact final-head control passed a separate `--retry=0` run in 24.202s.
Its log SHA-256 is:

```text
a3d38da91caf0771d4fbf32a821b900ea2d73702ec3d5bccd06564a17ab4a70d
```

No weighted-task target used framework retry. Every non-interference control
has exact retry-disabled passing evidence. The complete Production
Qualification retry is disclosed and is not reported as a zero-retry full
run. Business-level Provider retry and recovery tests remain release-blocking
and passed; they are not framework retries.

## Release Boundary

The exact design is
`bb5c53d8f1b04c408aec53c3cc48f98900473f2f`. The exact runtime,
configuration, Web UI, deterministic tests, and real-API harness are
`0ff60440309da59b2dea068417a577b986b7a62f`.

The next commit may add only this evidence file. The annotated `v0.10.42` tag
must contain no unqualified runtime, test, configuration, version, lockfile,
or changelog change.
