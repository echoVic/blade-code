# Trusted Contextual Project Rules

Blade 将代码库指令建模为 Session-owned、路径感知的可信资源。基础规则在 Session
启动时进入 system prompt；只有在模型读取、搜索或准备写入匹配路径时，条件规则和
更深目录的规则才会增量加载。

## 支持的文件

在 Git repository root 到目标路径之间，Blade 支持：

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

同一目录同时存在 `AGENTS.override.md` 和 `AGENTS.md` 时，只使用 override。
`CLAUDE.local.md` 是不应提交的个人项目规则。`.blade/rules` 是 Blade-native
规则目录，优先级高于同层 `.claude/rules`。

目录越接近目标文件，优先级越高。相同目录内大致按以下顺序后置：

```text
CLAUDE.md
.claude/CLAUDE.md
AGENTS.md / AGENTS.override.md
BLADE.md
.claude/rules
.blade/rules
CLAUDE.local.md
```

## 条件路径

rules Markdown 可以使用 YAML frontmatter 的 `paths`：

```markdown
---
paths:
  - src/**/*.ts
  - packages/api/**/*.tsx
---
Use TypeBox for runtime schemas. Run the API contract tests after edits.
```

pattern 相对包含 `.claude` 或 `.blade` 的目录匹配。字符串、逗号或换行分隔的字符串、
以及 YAML string array 均受支持。绝对 pattern、`..`、隐藏控制字符和超过预算的
pattern 会被拒绝。

无 `paths` 的 rules 文件是 unconditional rule。它在对应目录进入 Session 静态作用域，
或在模型首次触达更深/相邻目录时加载。

## 动态加载

Session Runtime 维护已加载 rule ID 的非驱逐集合：

1. `Read`、`Grep`、`Glob` 等只读工具正常执行；
2. 工具完成后，Blade 根据结构化路径解析尚未加载的 nested/conditional rules；
3. 新规则作为额外 system instruction 进入下一次 provider request；
4. 同一 rule 在后续回合、模型切换和 context compaction 中不重复注入。

如果 `Write`、`Edit`、`NotebookEdit` 或 `ApplyPatch` 首次命中尚未加载的规则，Blade
在任何文件副作用之前返回 validation error，加载规则，并让模型在下一轮重新提交写入。
这避免第一次写操作在不知道局部规则的情况下执行。

## Trust 与安全

project 和 local rules 仅在 Folder Trust 为 `trusted` 时加载。规则 catalog：

- 优先使用 canonical Git root，linked worktree 也遵循同一仓库层级；
- 不跟随 symlink，不允许 canonical path escape；
- 拒绝隐藏 Unicode 控制字符和空规则；
- 最多 128 个候选文件；
- 从 repository root 最多发现 24 层目录；
- 单文件最多 32 KiB；
- catalog 正文最多 256 KiB；
- static prompt 最多 48 KiB；
- 单次 contextual 注入最多 32 KiB；
- 每个文件最多 16 个 path pattern，单 pattern 最多 256 字符。

较具体的完整规则优先保留。Blade 不会截断后再伪装成原 digest。

## Snapshot 与恢复

WorkspaceAgentResources 在 Session 创建时冻结整个 rule catalog。运行中的文件变化不会
改变该 Session 的规则。

static rules 的组合 SHA-256 持久化为 `projectInstructionsDigest`。动态规则正文不会
写入 JSONL；transcript 只记录：

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

resume 时 Runtime 从 Session catalog 重建正文并校验每个引用。ID、相对路径、来源或
digest 漂移时，在 provider request 前 fail closed。新建 Session 可接受有意修改后的
规则。

## 跨端事件

CLI/TUI、headless JSONL、Web SSE 和 ACP 共用 `project_rules_loaded` 语义。事件只包含：

- rule ID；
- repository-relative path；
- `project` / `local` 来源；
- conditional 标记；
- SHA-256；
- repository-relative trigger paths；
- 是否因规则加载阻断了首次写入。

事件和 Web/ACP 活动卡不包含规则正文或宿主绝对路径。规则正文只存在于 Session
Runtime 和实际 provider system context。
