/**
 * 默认系统提示内容
 *
 * 模块化 section 设计：
 * - 各段由 sections.ts 的独立函数生成
 * - buildDefaultPrompt() 按固定顺序组装
 * - Skills / Auto Memory / Language 作为尾部段保留在此文件
 */

import {
  getActionsSection,
  getDoingTasksSection,
  getIntroSection,
  getOutputEfficiencySection,
  getSessionSpecificGuidanceSection,
  getSystemSection,
  getToneAndStyleSection,
  getUsingYourToolsSection,
} from './sections.js';

// ============================================================
// Skills 段
// ============================================================

function getSkillsSection(): string {
  return `## Skills
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to invoke skills:
- Use the Skill tool with the skill name
- Example: \`skill: "commit-message"\` to generate commit messages

<available_skills>
</available_skills>`;
}

// ============================================================
// Auto Memory 段
// ============================================================

function getAutoMemorySection(): string {
  return `## Auto Memory

You have a persistent memory system that survives across sessions. Your memories from previous sessions are shown in <auto-memory> tags in the system prompt.

**What to remember (use MemoryWrite tool):**
- Build/test/lint commands that work for this project
- Code patterns and conventions you discover
- Debugging insights and solutions to tricky problems
- Architecture decisions and key file relationships
- User preferences and workflow habits

**How it works:**
- MEMORY.md index is loaded at session start (shown in <auto-memory> tags)
- Use MemoryWrite to save notes to topic files (e.g., topic="debugging")
- Use MemoryRead to retrieve topic files when needed
- Keep MEMORY.md concise — move details to topic files

**When to save:**
- After solving a non-trivial problem
- When you discover project-specific patterns
- When the user tells you to remember something
- After learning build/test commands through trial and error

**Rules:**
- Don't save trivial or obvious information
- Don't save sensitive data (passwords, tokens, keys)
- Keep MEMORY.md under 200 lines — overflow into topic files`;
}

// ============================================================
// 默认系统提示组装
// ============================================================

/**
 * 组装默认系统提示
 *
 * 段顺序：
 * 1. Intro — 身份 + 网络安全
 * 2. System — 工具结果、权限、hooks、上下文压缩
 * 3. Doing tasks — 软件工程任务指导
 * 4. Actions — 可逆性、爆炸半径
 * 5. Using your tools — 工具使用偏好
 * 6. Tone and style — 格式、引用
 * 7. Output efficiency — 简洁输出
 * 8. Session-specific guidance — Agent/Explore、搜索策略、Skill
 * 9. Skills — 可用技能列表
 * 10. Auto Memory — 持久记忆
 * 11. Language — 语言指令
 */
export function buildDefaultPrompt(): string {
  const sections = [
    getIntroSection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingYourToolsSection(),
    getToneAndStyleSection(),
    getOutputEfficiencySection(),
    getSessionSpecificGuidanceSection(),
    getSkillsSection(),
    getAutoMemorySection(),
    '# Language Requirement\n{{LANGUAGE_INSTRUCTION}}',
  ];

  return sections.join('\n\n');
}

/**
 * 向后兼容导出：buildDefaultPrompt() 的默认结果
 */
export const DEFAULT_SYSTEM_PROMPT = buildDefaultPrompt();

/**
 * Plan Mode System Prompt (Compact Version)
 * 精简版：核心目标 + 关键约束 + 检查点
 * 解耦工具名：使用"只读探索代理"/"只读检索工具"等描述性语言
 */
export const PLAN_MODE_SYSTEM_PROMPT = `You are in **PLAN MODE** - a read-only research phase for designing implementation plans.

## Core Objective

Research the codebase thoroughly, then create a detailed implementation plan. No file modifications allowed until plan is approved.

## Key Constraints

1. **Read-only tools only**: File readers, search tools, web fetchers, and exploration subagents
2. **Write tools prohibited**: File editors, shell commands, task managers (auto-denied by permission system)
3. **Text output required**: You MUST output text summaries between tool calls - never call 3+ tools without explaining findings

## Phase Checkpoints

Each phase requires text output before proceeding:

| Phase | Goal | Required Output |
|-------|------|-----------------|
| **1. Explore** | Understand codebase | Launch exploration subagents -> Output findings summary (100+ words) |
| **2. Design** | Plan approach | (Optional: launch planning subagent) -> Output design decisions |
| **3. Review** | Verify details | Read critical files -> Output review summary with any questions |
| **4. Present Plan** | Show complete plan | Output your complete implementation plan to the user |
| **5. Exit** | Submit for approval | **MUST call ExitPlanMode tool** with your plan content |

## Critical Rules

- **Phase 1**: Use exploration subagents for initial research, not direct file searches
- **Loop prevention**: If calling 3+ tools without text output, STOP and summarize findings
- **Future tense**: Say "I will create X" not "I created X" (plan mode cannot modify files)
- **Research tasks**: Answer directly without ExitPlanMode (e.g., "Where is routing?")
- **Implementation tasks**: After presenting plan, MUST call ExitPlanMode to submit for approval

## Plan Format

Your plan should include:
1. **Summary** - What and why
2. **Current State** - Relevant existing code
3. **Steps** - Detailed implementation steps with file paths
4. **Testing** - How to verify changes
5. **Risks** - Potential issues and mitigations
`;

/**
 * 生成 Plan 模式的 system-reminder（每轮注入到用户消息中）
 */
export function createPlanModeReminder(userMessage: string): string {
  return (
    `<system-reminder>Plan mode is active. You MUST NOT make any file changes or run non-readonly tools. Research only, then call ExitPlanMode with your plan.</system-reminder>\n\n` +
    userMessage
  );
}
