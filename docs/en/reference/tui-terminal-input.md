# TUI Terminal Input

Blade TUI models terminal input as a stateful protocol rather than assuming each stdin callback contains only a single character. This ensures that normal typing, IME commits, terminal pastes, and automated batched input all share the same content semantics.

## Bracketed Paste

When the TUI mounts, DEC bracketed paste is enabled:

```text
CSI ? 2004 h
```

Full or cross-chunk paste boundaries are supported:

```text
ESC [ 200 ~
<payload>
ESC [ 201 ~
```

Ink removes the leading `ESC`, so the parser also accepts `[200~` / `[201~`. Exit, unmount, SIGINT, and SIGTERM all send `CSI ? 2004 l` to prevent the shell from remaining in paste mode.

Blade does not rely on terminal focus reporting and sends `CSI ? 1004 l` on startup and exit. Isolated `[I` / `[O` focus reports are filtered out, but literal occurrences inside user text are not deleted.

## Batched Input

A single stdin callback may contain:

- A single keystroke;
- Complete pasted content;
- Multiple characters from one IME commit;
- Entire paragraphs of text written by Computer Use or test bridges.

`CustomTextInput` inserts multi-character chunks as a single complete insertion. Even when consecutive characters occur within the same React batch, the internal value/cursor refs are updated synchronously before notifying external state, so a later character will not overwrite an earlier one based on stale render state.

CRLF and isolated CR are normalized to LF. Large text and multi-line text continue to use paste mapping, displaying a bounded summary in the UI while restoring the original text on submission; image paths still go through the image paste flow.

## Security Boundaries

- bracketed paste markers only control framing and do not enter user messages;
- Unclosed pastes remain in the parser buffer and do not prematurely submit half-text; after exceeding the shared 32,000-character message budget, content is discarded up to the end marker to prevent unbounded memory growth from misbehaving terminals;
- terminal mode is only enabled on TTY stdout;
- terminal mode cleanup does not depend on React exiting normally; GracefulShutdown resets it again;
- `/`, `@`, `!`, shortcuts, history, and permission mode are processed according to their original semantics after framing;
- Web Composer and ACP do not use terminal CSI sequences but share the final Session input contract.

## Qualification Requirements

Deterministic gates must cover:

1. Normal multi-character stdin chunks;
2. Rapid per-character callbacks within the same React batch;
3. Complete and split bracketed pastes;
4. CRLF normalization;
5. Focus CSI filtering and literal preservation;
6. TTY mode enable and restore;
7. raw Ink stdin submission;
8. `! <command>` routing and full process tree cancellation.

Real API gates must use production `dist/blade.js`, a real PTY, and a transparent proxy, directly observing the full pasted prompt entering the provider request body and completing a model response. Non-raw stdin or only rendering startup screenshots does not qualify as TUI input qualification.

Computer Use counts as passing only when the automation bridge can stably bind to an independent terminal window, maintain raw TTY focus, and completely submit commands; when multi-instance windows cannot be stably addressed by bundle/window ID, this should be recorded as a tool limitation.
