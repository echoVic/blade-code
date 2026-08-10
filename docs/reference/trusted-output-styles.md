# Trusted Custom Output Styles

Blade 可以从 user、project 和 active plugin 资源中加载自定义沟通风格。自定义 style
只控制回答的语气、结构和解释框架；它和内置 communication style 使用同一个
Session-owned 选择、权限 guard、继承与持久化模型。

## 文件格式

每个 style 是一个 Markdown 文件。frontmatter 的 `name` 和 `description` 可选：

```markdown
---
name: Security Review
description: Prioritize concrete security findings
---
Lead with findings ordered by severity. Include file and line references.
```

文件名和相对目录必须使用小写字母、数字、`.`、`_` 或 `-`。最多递归四层。
相对路径会转为稳定的 namespaced ID：

```text
user:compact
project:review:strict
plugin:review-kit:security
```

普通 API、TUI、Web 和 ACP 只接受这类 ID，不接受任意文件路径、JSON 或 raw prompt。

## 来源与覆盖

Blade 按以下目录发现资源：

```text
~/.claude/output-styles/
~/.blade/output-styles/
<project>/.claude/output-styles/
<project>/.blade/output-styles/
<active-plugin>/output-styles/
```

同一个 user 或 project ID 同时存在时，`.blade` 版本覆盖 `.claude` 兼容目录。
user、project 和 plugin 使用不同命名空间，不会互相覆盖，也不能替换 `auto`、
`pragmatic`、`friendly` 或 `explanatory`。

project style 只有在 Folder Trust 为 `trusted` 时才加载。plugin style 只有在
Plugin Registry 将插件判定为 `active`，并且插件已通过现有 source policy 与 managed
provenance 校验后才加载。插件启停会刷新未来 Session 的 catalog；已经运行的 Session
保留创建时的不可变快照。

## 安全预算

加载器执行以下 fail-closed 边界：

- 最多 32 个自定义 style；
- 单文件最多 24 KiB；
- 单 prompt 最多 16 KiB；
- catalog prompt 总量最多 128 KiB；
- name 最多 80 字符，description 最多 256 字符；
- 拒绝 symlink root、symlink entry、canonical path escape；
- 拒绝空 prompt、隐藏 Unicode 控制字符和不安全路径 segment。

单个格式错误、超限或含控制字符的 Markdown 不进入 catalog。symlink 或 catalog
级预算违规会阻断该 catalog 加载。

## Session 快照与溯源

每个 definition 计算 prompt 内容的 SHA-256。Session JSONL 持久化 namespaced
selection 和 custom prompt digest，不复制 raw prompt 或宿主路径。Runtime 重建时：

1. 从当前可信来源重建 catalog；
2. 按 selection 解析 definition；
3. 比较 durable digest；
4. ID 缺失或 digest 漂移时，在模型请求前 fail closed。

升级前创建、尚无 digest 的 custom selection 会在首次成功解析时原子 backfill。
如果 style 文件被有意修改，用户可以显式切换到内置 style 清除旧 digest，再重新选择
新的 custom style。

Session 创建后，文件变化不会修改当前进程中的 catalog 快照。fork、retry、Task、
Team 和 subagent 继承 selection；durable fork 同时继承 digest。

## 跨端投影

Web 模型 catalog 和 ACP config option 只暴露：

```json
{
  "id": "project:review:strict",
  "name": "Strict Review",
  "description": "Lead with actionable findings",
  "source": "project",
  "contentSha256": "..."
}
```

不会暴露 prompt、绝对目录或文件名。Web Composer 使用动态 catalog；TUI `/style`
列出可用 ID；ACP 的 `communication_style` select 使用相同摘要。Markdown 会话导出
记录 selection 和 digest，便于审计。

## Prompt 权限边界

自定义内容放在 `<communication_style>` section 内，并位于 Blade 基础提示之后、
可信项目指令之前。section 前置 guard 明确禁止 style 改变任务范围、安全规则、权限、
工具行为、指令来源优先级或完成门禁。
