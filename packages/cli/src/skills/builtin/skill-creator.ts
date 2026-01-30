/**
 * 内置 skill-creator Skill
 *
 * 帮助用户交互式创建新的 Blade Skills。
 * 对齐 Claude Code 的 skill-creator 实现。
 */

import type { SkillContent, SkillMetadata } from '../types.js';

/**
 * skill-creator 的元数据
 */
export const skillCreatorMetadata: SkillMetadata = {
  name: 'skill-creator',
  description:
    'Create new Skills interactively. Use when the user wants to create a new Skill, define a custom workflow, or add a specialized capability to Blade.',
  allowedTools: ['Read', 'Write', 'Glob', 'Bash', 'AskUserQuestion'],
  version: '1.0.0',
  argumentHint: undefined,
  userInvocable: true, // 允许用户通过 /skill-creator 调用
  disableModelInvocation: false, // AI 可以自动调用
  model: undefined,
  whenToUse:
    'User wants to create a new skill, define a custom workflow, or add a specialized capability.',
  path: 'builtin://skill-creator',
  basePath: '',
  source: 'builtin',
};

/**
 * skill-creator 的完整指令内容
 */
const skillCreatorInstructions = `# Skill Creator

帮助用户创建新的 Blade Skills。

## Instructions

当用户想要创建新 Skill 时，按以下步骤进行：

### 1. 了解需求

询问用户：
- Skill 的目的是什么？解决什么问题？
- 什么场景下应该使用这个 Skill？
- 需要访问哪些工具？（Read, Write, Bash, Grep, Glob, Task, WebFetch 等）
- 是否需要支持用户通过 \`/skill-name\` 命令调用？

### 2. 设计 Skill

根据用户需求，设计以下内容：

**必填字段：**
- \`name\`: kebab-case 格式，≤64 字符（如 \`code-review\`, \`commit-helper\`）
- \`description\`: 简洁描述，≤1024 字符，包含"什么"和"何时使用"

**可选字段：**
- \`allowed-tools\`: 限制可用工具列表（提高安全性）
- \`argument-hint\`: 参数提示（如 \`<file_path>\`）
- \`user-invocable\`: 是否支持 \`/skill-name\` 调用（默认 false）
- \`disable-model-invocation\`: 是否禁止 AI 自动调用（默认 false）
- \`version\`: 版本号

**系统提示词设计要点：**
- 清晰的任务描述
- 具体的执行步骤
- 边界条件和错误处理
- 输出格式规范

### 3. 确认保存位置

询问用户希望将 Skill 保存到：
- **项目级** (\`.blade/skills/\`): 与团队共享，通过 git 同步（**默认推荐**）
- **用户级** (\`~/.blade/skills/\`): 个人使用，跨项目可用

如果用户没有明确指定，默认使用 **项目级** (\`.blade/skills/\`)。

### 4. 生成文件

**重要：直接使用 Write 工具创建文件，不要使用外部脚本。**

使用 Write 工具创建 SKILL.md 文件：

\`\`\`
.blade/skills/{name}/SKILL.md        # 项目级（默认）
~/.blade/skills/{name}/SKILL.md      # 用户级
\`\`\`

文件格式：
\`\`\`yaml
---
name: {name}
description: {description}
allowed-tools:
  - {tool1}
  - {tool2}
user-invocable: true  # 如果需要 /skill-name 命令
---

# {Skill Title}

## Instructions

{详细指令}

## Examples

{使用示例}
\`\`\`

### 5. 刷新并验证

创建完成后，**必须提示用户执行 \`/skills\` 命令刷新 Skills 列表**，否则新创建的 Skill 不会立即生效。

验证步骤：
- 检查目录和文件是否创建成功
- **重要**：告诉用户执行 \`/skills\` 刷新列表
- 提示用户可以通过以下方式使用新 Skill：
  - AI 自动调用（如果未禁用）
  - \`/skill-name\` 命令（如果启用了 user-invocable）

## Best Practices

1. **名称规范**
   - 使用 kebab-case：\`code-review\`, \`commit-helper\`, \`test-generator\`
   - 名称应该简洁且描述性强

2. **描述要具体**
   - 包含触发词，帮助 AI 识别何时使用
   - 例如："Generate commit messages following conventional commits format. Use when the user wants to commit changes or asks for a commit message."

3. **限制工具访问**
   - 仅授予必要的工具权限，提高安全性
   - 例如：只读 Skill 只需 Read, Grep, Glob

4. **提供清晰的指令**
   - 使用 Markdown 格式组织内容
   - 包含具体步骤和示例
   - 处理边界情况

5. **考虑调用方式**
   - 频繁使用的 Skill 可设置 \`user-invocable: true\`
   - 仅限用户手动触发的 Skill 可设置 \`disable-model-invocation: true\`

## Example Skills

### 代码审查 Skill

\`\`\`yaml
---
name: code-review
description: Review code for best practices, bugs, and improvements. Use when reviewing PRs, checking code quality, or before committing.
allowed-tools:
  - Read
  - Grep
  - Glob
argument-hint: <file_path>
user-invocable: true
---

# Code Review

审查代码质量、最佳实践和潜在问题。

## Instructions

1. 读取指定的文件或目录
2. 检查以下方面：
   - 代码风格一致性
   - 潜在的 bug 或错误
   - 性能问题
   - 安全漏洞
   - 可读性和可维护性
3. 提供具体的改进建议

## Output Format

- 问题严重程度：🔴 严重 | 🟡 警告 | 🔵 建议
- 具体位置和代码片段
- 改进建议和示例代码
\`\`\`

### 提交消息生成 Skill

\`\`\`yaml
---
name: commit-message
description: Generate conventional commit messages. Use when committing changes or when user asks for a commit message.
allowed-tools:
  - Bash
  - Read
user-invocable: true
---

# Commit Message Generator

生成符合 Conventional Commits 规范的提交消息。

## Instructions

1. 运行 \`git diff --staged\` 查看暂存的更改
2. 分析更改类型（feat/fix/docs/style/refactor/test/chore）
3. 生成简洁的提交消息
4. 询问用户是否满意或需要调整

## Output Format

\`\`\`
<type>(<scope>): <subject>

<body>

<footer>
\`\`\`
\`\`\`
`;

/**
 * 获取 skill-creator 的完整内容
 */
export function getSkillCreatorContent(): SkillContent {
  return {
    metadata: skillCreatorMetadata,
    instructions: skillCreatorInstructions,
  };
}
