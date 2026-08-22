# 🧠 Auto Memory

Auto Memory lets the Agent automatically record project knowledge during work and persist it across sessions. When a new session starts, historical memory is loaded automatically, so the Agent no longer "forgets."

## How It Works

1. **Load on startup** — When a session begins, the first 200 lines of MEMORY.md are automatically injected into the system prompt
2. **Record during work** — When the Agent discovers valuable knowledge, it saves it via the MemoryWrite tool
3. **Retrieve on demand** — When the Agent needs detailed information on a specific topic, it reads it via the MemoryRead tool

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
- **Path traversal protection** — Topic names may not contain `..` or `/`, preventing writes to arbitrary paths
- **Index line limit** — MEMORY.md has a 200-line load cap to avoid bloating the system prompt

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
