# ACP Pending-Resume Egress Convergence Design

## Problem

The production ACP pending-resume path persists the recovered turn and flushes its
normal prompt updates before emitting the terminal `blade/pendingResume` metadata.
The `recovered` metadata is currently offered to the bounded ACP egress queue without
waiting for delivery. The production qualification runner can therefore observe the
complete durable turn and final ACP text while its client has received only the prior
`retry_scheduled` metadata. The runner currently treats that valid prefix as malformed
terminal evidence and reports `pending_resume_invalid`. Closing the ACP Session after
that false failure rejects the still-queued `recovered` update and makes the race
permanent.

## Contract

Pending-resume completion has two related but distinct boundaries:

1. The runtime owns terminal metadata until the exact `recovered` update settles on
   the ACP egress queue. It must not report itself idle or finish teardown while that
   owned completion is unresolved.
2. The cross-process qualification observer treats the exact one-item prefix
   `retry_scheduled(attempt=2, maxAttempts=4, kind=pending_input)` as incomplete and
   continues its existing bounded poll. The exact two-item sequence ending in
   `recovered(attempt=2)` is complete. Every other shape remains an immediate
   fail-closed protocol error.

An empty metadata sequence is not an accepted prefix. Before durable completion and
the ACP final marker become observable, the prompt's FIFO egress flush must already
have delivered the earlier `retry_scheduled` update. Accepting an empty sequence would
hide a distinct ordering or transport defect.

## Runtime ownership and failure semantics

- `resumePendingIfIdle()` sends terminal `recovered` metadata with the existing
  `sendUpdateAndWait()` primitive, which waits for that exact queue offer.
- State is cleared as recovered only after delivery succeeds and the recovery
  generation still matches.
- An offer rejection, write failure, timeout, connection abort, cancellation, or
  destroy returns from the recovery coroutine without entering Provider retry logic.
  The durable turn is already complete and must never execute again because metadata
  egress failed.
- `AcpSession` keeps a session-owned pending-resume completion promise. Residency is
  non-idle while a request is requested, scheduled, timed, in flight, or has an owned
  completion.
- Destroy first invalidates the generation and closes bounded egress, which settles a
  blocked exact-update wait, then joins the pending-resume completion before destroying
  the Agent and Runtime. No late coroutine may outlive its owner.

## Alternatives considered

### Runner-only tri-state

This is sufficient to remove the observed false failure, but leaves the runtime free
to advertise idleness and begin teardown before its own terminal metadata settles. It
is included as the required observer fix, not used alone.

### `sendUpdate()` followed by `flushUpdates()`

This waits for a queue high-water mark rather than the exact offered update. It also
cannot stop another process from reading durable completion while the flush is still
pending. The exact completion primitive expresses ownership more directly.

### Make every ACP update awaitable

Changing the whole streaming surface would broaden backpressure and failure behavior
beyond this race. Only terminal pending-resume recovery needs the new ownership
boundary.

## Verification

Deterministic tests must prove:

- the runner returns incomplete for the one exact retry prefix and later succeeds when
  `recovered` arrives;
- malformed, reordered, duplicate, failed, and exhausted sequences still fail
  immediately;
- a deferred `recovered` writer keeps the Session non-idle and prevents another wake
  from starting until the exact update settles;
- egress failure or destroy settles the recovery owner without scheduling another
  Provider turn; and
- existing pending-resume retry, cancellation, replay, and bounded-egress tests remain
  green.

Real-Provider qualification reruns the exact production ACP pending-resume cell with
framework retry disabled. This patch remains independent from the released raw PTY
handshake and from any unrelated runtime work.
