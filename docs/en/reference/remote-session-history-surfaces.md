# Remote Session History Surfaces

Starting with `0.10.129`, Blade's Web GUI and terminal TUI can discover and
inspect Session history persisted for ACP remote workspaces. A remote Session
opens in a separate history-only surface. Viewing it does not treat a remote
path as a host path or create new Agent, terminal, or filesystem authority.

## Status labels

A remote Session row shows:

- `Remote`: the Session belongs to an ACP remote workspace;
- `Online` or `Offline`: whether the original ACP owner is currently connected
  with the same exact workspace identity;
- `History only`: this surface can only read persisted Session history;
- the canonical remote working directory, which is display-only and is never
  converted into a host path or used as authority.

Safely persisted history remains readable and forkable after the owner goes
offline. An online label does not grant Web or TUI remote execution authority.

## Web GUI

1. Open the Web UI with `blade web`.
2. Select a Session from the **Remote sessions** group in the sidebar. Remote
   rows carry Remote, connection-state, and History only labels.
3. The history view shows the canonical remote working directory and the
   allowlisted user and assistant messages.
4. Select **Load older messages**, or scroll to the top of the loaded content,
   to fetch one older bounded page.
5. Search covers only pages already loaded in the browser. Individual messages
   can be copied.
6. If the Session is forkable, create an independent remote history branch.
   The child remains history-only.
7. Close the surface to return to the unchanged local interactive Session. A
   browser refresh restores the remote view from its opaque URL locator, not
   from the display path.

In history-only mode the composer is unavailable, and Files, Terminal, Browser,
code review, rewind, task dispatch, and subagent actions do not start. Continue
the remote conversation from the ACP client that owns it.

## Terminal TUI

Run `/resume` to open the Session selector. A remote entry looks like this:

```text
[remote · offline · history] Fix Windows path handling
C:\Repo · 42 messages · 9/2
```

Local entries keep the existing resume path. Selecting a remote entry opens the
full-height history viewer while preserving the current local interactive
Session behind it. `/fork` uses the same selector but lists only forkable
Sessions.

### Long-task attention

Starting with `0.10.133`, the TUI keeps local durable attention state for known
background tasks. If a known running Session reaches `completed`, `failed`, or
`interrupted` while the TUI is absent, the next `/resume` shows `[NEW]` on that
exact Session:

```text
[NEW] [DONE] Build release artifacts
```

The status bar also shows `New tasks N · /resume`. The marker is cleared only
after the exact Session opens successfully. Merely opening or cancelling the
selector, opening a same-ID Session from another project, or forking the source
does not acknowledge it. `/fork` does not render `[NEW]` and does not mark the
source Session as read.

To avoid reporting every historical task after an upgrade, a terminal Session
seen for the first time becomes a silent baseline. `cancelled` does not create
attention. If the catalog or local ledger is temporarily unavailable, the status
bar shows `Task sync unavailable`; existing markers are retained and are not
falsely acknowledged.

This ledger belongs only to the TUI and does not read or write the Web GUI's
acknowledgement state. It stores only bounded terminal signatures, acknowledgement
state, and irreversible locator digests. It stores no prompts, model output,
failure text, raw remote paths, or raw workspace references.

History viewer keys:

| Key | Action |
| --- | --- |
| `Up` / `k`, `Down` / `j` | Move the current line |
| `PageUp` / `PageDown` | Scroll by a page; reaching the top loads one older page when available |
| `g` / `Home` | Go to the top of loaded content and request an older page when available |
| `G` / `End` | Go to the bottom of loaded content |
| `/` | Edit a search term; `Enter` accepts it and `Esc` cancels editing |
| `n` / `N` | Move forward or backward through matches in loaded pages |
| `y` | Copy the current message line |
| `f` | Fork the Session; the result remains remote and history-only |
| `Esc` / `q` | Close the viewer and return to the unchanged local Session |

## Bounded reads and privacy

- A page contains at most `50` visible messages by default; the API maximum is
  `100`.
- Web and TUI retain at most the newest `500` loaded messages and never load the
  entire transcript eagerly.
- One content field is capped at `256 KiB` of valid UTF-8. A projected page is
  capped at `512 KiB` of JSON. Truncation is shown explicitly.
- Public messages contain only a stable opaque ID, a `user` or `assistant` role,
  content, timestamp, and an optional truncation marker. Reasoning, tool calls
  and results, raw attachments, and internal metadata are excluded.
- The URL carries only the Session ID, `workspaceKind=acp-remote`, and an opaque
  `workspaceRef`. It contains no remote path, descriptor, or Blade host-state
  root.
- Cursors and workspace references are bounded, revalidated identifiers. They
  are not execution credentials.

If a cursor expires or the underlying snapshot changes, the UI reopens the
current Session to recover a consistent view instead of combining pages from
different snapshots.

## Not supported in this release

`0.10.129` does not start or continue a remote Agent turn from Web or TUI. It
does not provide a remote directory tree, remote file preview or editing, an ACP
command console, an interactive remote PTY, remote Browser control, or remote
code review. None of these operations falls back to the Blade host.

Local Sessions and ACP-local Sessions without a remote workspace owner retain
their existing interactive, file, terminal, and routing behavior.
