# 🧠 Auto Memory

Auto Memory lets the Agent automatically record project knowledge during work and persist it across sessions. When a new session starts, historical memory is loaded automatically, so the Agent no longer "forgets."

## How It Works

1. **Load on startup** — When a session begins, the first 200 lines of MEMORY.md are automatically injected into the system prompt
2. **Record during work** — When the Agent discovers valuable knowledge, it saves it via the MemoryWrite tool
3. **Consolidate on compaction** — Full compaction extracts explicitly marked reusable knowledge from messages removed from context
4. **Retrieve on demand** — When the Agent needs detailed information on a specific topic, it reads it via the MemoryRead tool

## Full-compaction memory consolidation

Predictive threshold compaction, context-limit recovery, turn-limit continuation,
and manual `/compact` use the same sequence:

1. Build a bounded replacement and project-memory plan.
2. Atomically commit the replacement checkpoint first.
3. Persist project memory on a best-effort basis only after that checkpoint succeeds.
4. Replace the live model context and continue the task.

A checkpoint failure prevents both memory persistence and in-memory replacement. A
memory-write failure does not invalidate an already committed compaction. The planner
reuses history already inspected by compaction and **does not make an additional
Provider request**. Snip-only and micro compaction do not produce project memory.

Automatic consolidation reads only visible text removed by full compaction:

- explicit user `remember:` or `note:` entries go to `preferences.md`;
- `convention:` entries go to `conventions.md`;
- `lesson:` entries go to `lessons.md`;
- explicit assistant `fixed:` or `resolved:` entries go to `debugging.md`.

Tool output, tool arguments, reasoning, metadata, and image URLs are never inspected. A
plan holds at most 20 entries, each at most 500 Unicode code points, and at most 8,000
code points in total. Persistence performs normalized exact deduplication and combines
an in-process lock, a filesystem lock, and atomic replacement to prevent concurrent
lost updates. Topic and index files use `0600` permissions. Managed topic links update
only the bounded generated block in `MEMORY.md`; user-maintained content is preserved.

## Storage Structure

Memory files are stored under a project-specific directory:

```
~/.blade/projects/{escaped-path}/memory/
├── MEMORY.md          # Entry index (first 200 lines loaded on startup)
├── patterns.md        # Project patterns (build commands, code style)
├── debugging.md       # Debugging insights
├── architecture.md    # Architecture notes
└── ...                # Topic files created by the Agent on demand
```

Each project has its own independent memory space; they do not interfere with one another.

## What the Agent Remembers

- The project's build, test, and lint commands
- Code patterns and conventions
- Solutions discovered during debugging
- Architecture decisions and key file relationships
- User preferences and workflow habits

## Safety Mechanisms

- **Sensitive data filtering** — Automatically rejects content containing password, token, secret, api_key, or private_key
- **Closed credential classification** — Bearer tokens, `sk-*` keys, AWS access key IDs,
  and PEM private-key headers are also rejected; errors and client projections never
  return matched content or regex details
- **Path traversal protection** — Topic names may not contain `..` or `/`, preventing writes to arbitrary paths
- **Index line limit** — MEMORY.md has a 200-line load cap to avoid bloating the system prompt
- **Workspace isolation** — Memory is written only for the active local workspace; a
  remote ACP workspace returns `disabled` and never writes to a host project directory
- **Content-free projections** — TUI, Web, ACP, and Headless receive only the outcome,
  entry count, and topic names, never memory text, paths, storage errors, or credentials

## The /memory Command

Use `/memory` within a session to manage memory files:

| Command | Description |
|------|------|
| `/memory` | List all memory files (same as `/memory list`) |
| `/memory list` | List all memory files and their sizes |
| `/memory show` | Show the MEMORY.md index content |
| `/memory show <topic>` | Show the content of a specific topic file |
| `/memory edit` | Edit MEMORY.md with `$EDITOR` |
| `/memory edit <topic>` | Edit a specific topic file with `$EDITOR` |
| `/memory clear` | Clear all memory files |

## Tools

### MemoryRead

Reads a memory file; the Agent calls it automatically when needed.

```
topic: "debugging"     → read debugging.md
topic: "MEMORY"        → read the MEMORY.md index
topic: "_list"         → list all memory files
```

### MemoryWrite

Saves memory content, supporting append and overwrite modes.

```
topic: "patterns"
content: "## Build\nbun run build"
mode: "append"         → append to patterns.md
mode: "overwrite"      → overwrite patterns.md
```

## Configuration

### Environment Variables

```bash
# Disable Auto Memory
BLADE_AUTO_MEMORY=0

# Enable (default)
BLADE_AUTO_MEMORY=1
```

## Best Practices

- **MEMORY.md is an index** — Keep it concise; put detailed content in topic files
- **Let the Agent learn on its own** — There's no need to write memory manually; the Agent discovers and records it automatically during work
- **Review regularly** — Use `/memory show` to see what the Agent has recorded, and `/memory edit` to correct inaccurate content
- **After project setup** — When you first use it on a new project, the Agent gradually accumulates knowledge, working best after a few sessions

## Related Resources

- [Slash Commands](/en/guides/slash-commands.md) — All built-in commands
- [Tool List](/en/reference/tool-list.md) — MemoryRead / MemoryWrite parameter details
- [Config System](/en/configuration/config-system.md) — Global and project-level configuration
