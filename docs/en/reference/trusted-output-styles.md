# Trusted Custom Output Styles

Blade can load custom communication styles from user, project, and active plugin resources. Custom styles only control response tone, structure, and explanatory framework; they use the same Session-owned selection, permission guards, inheritance, and persistence model as built-in communication styles.

## File Format

Each style is a Markdown file. The `name` and `description` in frontmatter are optional:

```markdown
---
name: Security Review
description: Prioritize concrete security findings
---
Lead with findings ordered by severity. Include file and line references.
```

Filenames and relative directories must use lowercase letters, numbers, `.`, `_`, or `-`. Maximum four levels of recursion.
Relative paths are converted to stable namespaced IDs:

```text
user:compact
project:review:strict
plugin:review-kit:security
```

Ordinary APIs, TUI, Web, and ACP only accept such IDs, not arbitrary file paths, JSON, or raw prompts.

## Sources and Overrides

Blade discovers resources from the following directories:

```text
~/.claude/output-styles/
~/.blade/output-styles/
<project>/.claude/output-styles/
<project>/.blade/output-styles/
<active-plugin>/output-styles/
```

When the same user or project ID exists in both, the `.blade` version overrides the `.claude` compatibility directory. Users, projects, and plugins use different namespaces; they do not override each other and cannot replace `auto`, `pragmatic`, `friendly`, or `explanatory`.

Project styles are only loaded when Folder Trust is `trusted`. Plugin styles are only loaded when the Plugin Registry determines the plugin is `active` and the plugin has passed existing source policy and managed provenance validation. Plugin enable/disable refreshes the catalog for future Sessions; already-running Sessions retain the immutable snapshot from creation time.

## Security Budgets

The loader enforces the following fail-closed boundaries:

- Maximum 32 custom styles;
- Single file maximum 24 KiB;
- Single prompt maximum 16 KiB;
- Catalog prompt total maximum 128 KiB;
- name maximum 80 characters, description maximum 256 characters;
- Rejects symlink roots, symlink entries, and canonical path escapes;
- Rejects empty prompts, hidden Unicode control characters, and unsafe path segments.

Individual Markdown files with format errors, oversize, or control characters do not enter the catalog. Symlink or catalog-level budget violations block loading of that catalog.

## Session Snapshots and Provenance

Each definition computes a SHA-256 of the prompt content. Session JSONL persists the namespaced selection and custom prompt digest, not raw prompts or host paths. On Runtime reconstruction:

1. Rebuild catalog from current trusted sources;
2. Resolve definition by selection;
3. Compare durable digest;
4. Fail closed before model requests when ID is missing or digest drifts.

Custom selections created before upgrade that lack digests are atomically backfilled on first successful resolution. If a style file is intentionally modified, users can explicitly switch to a built-in style to clear the old digest, then reselect the new custom style.

After Session creation, file changes do not modify the catalog snapshot in the current process. Forks, retries, Tasks, Teams, and subagents inherit selection; durable forks simultaneously inherit digests.

## Cross-Surface Projection

Web model catalogs and ACP config options only expose:

```json
{
  "id": "project:review:strict",
  "name": "Strict Review",
  "description": "Lead with actionable findings",
  "source": "project",
  "contentSha256": "..."
}
```

Prompts, absolute directories, or filenames are not exposed. Web Composer uses dynamic catalogs; TUI `/style` lists available IDs; ACP `communication_style` selects use the same digest. Markdown session exports record selections and digests for audit purposes.

## Prompt Permission Boundary

Custom content is placed within the `<communication_style>` section, located after Blade base prompts and before trusted project instructions. A pre-section guard explicitly prohibits styles from changing task scope, safety rules, permissions, tool behavior, instruction source priority, or completion gates.
