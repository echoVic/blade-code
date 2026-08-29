# Raw PTY Composer-Ready Handshake Design

## Problem

Raw PTY qualification runners currently infer that the TUI composer is ready from
rendered placeholder text. The token-budget runner additionally treats bracketed
paste mode being enabled for five seconds as a readiness signal. The terminal mode
is enabled by `App` before initialization finishes and before the main input handler
is registered, so a large bracketed paste can be written into the PTY too early. The
result is an intermittent `paste:stage_failed` with no Provider request.

## Contract

The production TUI exposes an opt-in, invisible readiness handshake only when a test
provides a valid per-process nonce. The main `CustomTextInput` emits the corresponding
OSC sequence after its active handler has been registered with the terminal input
router. Normal users do not set the environment variable and receive no extra output.

Prompt-sending raw PTY runners generate a fresh nonce for each child, pass it through
the child environment, and wait for the exact OSC sequence before sending bracketed
paste. They continue to require the post-paste `PASTE:` rendering as evidence that the
composer accepted the complete input. Bracketed-paste mode and localized placeholder
text are diagnostic observations only and never establish readiness.

The handshake is an input-transport boundary. Durable `MARKER_TEMPLATE` and generic
`PART_A`/`PART_B` final-response protocols remain independent and unchanged.

## Safety and lifecycle

- The nonce is exactly 32 lowercase hexadecimal characters. Invalid values emit
  nothing, preventing environment-controlled escape-sequence injection.
- The marker is wrapped in an OSC sequence so it is captured by PTY harnesses but not
  rendered as user-visible text.
- Registration callbacks run only for active handlers and may fire again after focus
  is restored; runners latch the exact nonce-specific marker.
- A missing marker fails at the bounded composer stage. No timeout is increased and no
  input is sent speculatively.

## Verification

Deterministic tests cover marker validation/emission, registration ordering, complete
prompt-runner inventory, removal of the bracketed-mode fallback, and preservation of
the post-paste acknowledgement. Real API verification covers the token-budget and
large-prompt raw PTY cells that previously exposed the race.
