# Portable Session Markdown Export

Blade can export durable conversations from active or archived Sessions as portable Markdown. The exporter reads a stable snapshot of the JSONL event stream and applies all `session_rewound` markers; it does not splice history from current Provider context, Web memory, or SQLite read models.

## Content Model

Default export includes:

- user and assistant text;
- image MIME tags, without data URLs or raw binary;
- tool calls, tool results, subagent, and file-change activity;
- durable compaction summary;
- Session, project name, model, creation/update times, and active/archived status.

System recovery markers and other internal system text do not enter the export. Model reasoning is omitted by default and only included with explicit `--reasoning` or `includeReasoning=true`. Reasoning still undergoes the same Unicode and credential cleaning as ordinary text.

Each file header contains:

```text
Content SHA-256: <hex>
Content bytes: <n>
Redactions: <n>
```

SHA-256 covers the complete UTF-8 body after the Markdown horizontal rule `---`, not including variable metadata headers. Exports have no current timestamp, so the same durable history, visibility options, and cleaning rules produce identical body digests.

## Security Projection

All text first undergoes NFKC, ANSI/control/hidden Unicode cleaning, and credential pattern redaction. Tool activity additionally recursively processes:

- sensitive keys such as `apiKey`, `authorization`, `password`, `secret`, `token`;
- Bearer tokens, `sk-*` keys, AWS access keys, and private-key blocks;
- data URLs and other inline binaries;
- workspace root replaced with `.`, other Unix/Windows absolute host paths replaced with `[host-path]`;
- URLs with user-info, query, or fragment retain only credential-free origin/path.

Projection limit for a single activity is 64 KiB; excess is explicitly marked `[activity truncated]`. Complete Markdown limit is 16 MiB; exceeding this fails the entire export without generating a silently truncated file masquerading as complete history.

## CLI and TUI

```text
/export
/export reports/conversation.md
/export --reasoning
/export reports/conversation.md --reasoning
```

When no path is specified, writes to current workspace:

```text
blade-session-<session-id-prefix>.md
```

Relative paths are based on the current workspace, `~/` and absolute paths resolved per user explicit input. Parent directories are created on demand, files use `0600` permissions and exclusive create; existing targets are not overwritten, and failed partial files are cleaned up.

## Web

Both active Session row menus and footer Archive Popover provide **Export Markdown**. The frontend reads the server's safe filename, SHA-256, message/activity/redaction counts then creates a one-time Blob download; downloads are rejected when provenance headers are missing.

HTTP interface:

```http
GET /sessions/:sessionId/export?projectPath=/absolute/path
GET /sessions/:sessionId/export?projectPath=/absolute/path&includeReasoning=true
```

Response is `text/markdown; charset=utf-8`, and sets:

```text
Cache-Control: no-store
Content-Disposition: attachment; filename="blade-session-....md"
X-Blade-Content-Sha256: ...
X-Blade-Export-Messages: ...
X-Blade-Export-Activities: ...
X-Blade-Export-Redactions: ...
```

`sessionId + projectPath` uses the same exact workspace resolver as other Session routes. Reading archived Sessions does not create a Runtime or unarchive them.

## ACP

ACP has no standard conversation-export or atomic remote create-exclusive wire method. Therefore `/export` returns the same Markdown as standard `agent_message_chunk` without writing to host paths; path-bearing calls fail closed. ACP inline limit is 1 MiB; exceeding this should use the Web endpoint.

```text
/export
/export --reasoning
```

## Production Qualification

Deterministic tests cover rewind materialization, orphan tool results, part updates, images, summaries, reasoning visibility, credential/path/binary cleaning, activity budgets, body SHA-256, active/archived exact workspace, 0600 no-clobber, HTTP provenance, Web keyboard actions, and ACP inline limits.

Real GPT must call `Read` to read files that simultaneously contain public markers, fake API keys, and host paths. Exports preserve call/results and markers, hide keys/paths, and return identical digests through both TUI file write and ACP inline entry points.

Production DeepSeek Web GUI must execute one download each from active row and archived Popover; fresh tab must also export archived Session again. Direct response audits must verify body hash, `no-store`, safe filenames, active/archived status, marker preservation, credential/host path disappearance, and zero application console errors.
