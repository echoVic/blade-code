# Trusted Contextual Project Rules

Blade models repository instructions as Session-owned, path-aware trusted resources. Base rules enter the system prompt when a Session starts; conditional rules and rules from deeper directories are loaded incrementally only when the model reads, searches, or prepares to write to a matching path.

## Supported Files

Between the Git repository root and the target path, Blade supports:

```text
CLAUDE.md
.claude/CLAUDE.md
AGENTS.md
AGENTS.override.md
BLADE.md
CLAUDE.local.md
.claude/rules/**/*.md
.blade/rules/**/*.md
```

When both `AGENTS.override.md` and `AGENTS.md` exist in the same directory, only the override is used. `CLAUDE.local.md` is a personal project rule that should not be committed. `.blade/rules` is the Blade-native rules directory, taking precedence over `.claude/rules` at the same level.

Directories closer to the target file have higher priority. Within the same directory, precedence is roughly in the following order (later is higher):

```text
CLAUDE.md
.claude/CLAUDE.md
AGENTS.md / AGENTS.override.md
BLADE.md
.claude/rules
.blade/rules
CLAUDE.local.md
```

## Conditional Paths

Rules Markdown can use `paths` in YAML frontmatter:

```markdown
---
paths:
  - src/**/*.ts
  - packages/api/**/*.tsx
---
Use TypeBox for runtime schemas. Run the API contract tests after edits.
```

Patterns match relative to the directory containing `.claude` or `.blade`. Strings, comma- or newline-separated strings, and YAML string arrays are all supported. Absolute patterns, `..`, hidden control characters, and patterns exceeding budget limits are rejected.

A rules file without `paths` is an unconditional rule. It enters the Session's static scope for that directory, or is loaded when the model first reaches a deeper or adjacent directory.

## Dynamic Loading

The Session Runtime maintains a non-evicting set of loaded rule IDs:

1. Read-only tools such as `Read`, `Grep`, and `Glob` execute normally;
2. After the tool completes, Blade resolves unloaded nested/conditional rules based on the structured path;
3. New rules enter the next provider request as additional system instructions;
4. The same rule is not re-injected across subsequent turns, model switches, or context compaction.

If `Write`, `Edit`, `NotebookEdit`, or `ApplyPatch` hits a not-yet-loaded rule for the first time, Blade returns a validation error before any file side effects occur, loads the rule, and lets the model resubmit the write in the next round. This prevents the first write from executing without awareness of local rules.

## Trust and Security

Project and local rules are loaded only when Folder Trust is `trusted`. The rules catalog:

- Prefers the canonical Git root; linked worktrees follow the same repository hierarchy;
- Does not follow symlinks; canonical path escape is not allowed;
- Rejects hidden Unicode control characters and empty rules;
- Allows a maximum of 128 candidate files;
- Discovers a maximum of 24 directory levels from the repository root;
- Limits individual files to 32 KiB;
- Limits the catalog body to 256 KiB;
- Limits static prompts to 48 KiB;
- Limits a single contextual injection to 32 KiB;
- Limits each file to 16 path patterns, and each pattern to 256 characters.

More specific complete rules are retained preferentially. Blade never truncates and then disguises the content as the original digest.

## Snapshot and Recovery

WorkspaceAgentResources freezes the entire rules catalog when a Session is created. Runtime file changes do not alter that Session's rules.

The combined SHA-256 of static rules is persisted as `projectInstructionsDigest`. Dynamic rule bodies are not written to JSONL; the transcript only records:

```json
{
  "contextualProjectRules": true,
  "ruleReferences": [
    {
      "id": "project:...",
      "relativePath": ".claude/rules/typescript.md",
      "source": "project",
      "contentSha256": "..."
    }
  ],
  "triggerPaths": ["src/index.ts"]
}
```

On resume, the Runtime reconstructs bodies from the Session catalog and verifies each reference. If IDs, relative paths, sources, or digests drift, it fails closed before the provider request. A new Session accepts intentionally modified rules.

## Cross-Platform Events

CLI/TUI, headless JSONL, Web SSE, and ACP all share the `project_rules_loaded` semantics. Events contain only:

- rule ID;
- repository-relative path;
- `project` / `local` source;
- conditional flag;
- SHA-256;
- repository-relative trigger paths;
- whether the first write was blocked due to rule loading.

Events and Web/ACP activity cards do not contain rule bodies or host absolute paths. Rule bodies exist only in the Session Runtime and the actual provider system context.
