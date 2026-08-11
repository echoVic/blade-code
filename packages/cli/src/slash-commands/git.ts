/**
 * /git slash command
 * Git 仓库查询和 AI 辅助功能
 */

import { Agent } from '../agent/Agent.js';
import { drainLoop } from '../agent/loop/index.js';
import { getState } from '../store/vanilla.js';
import {
  getGitStatus,
  getLlmGitStatus,
  getRecentCommitMessages,
  getStagedDiff,
  getStagedFileList,
  gitCommit,
  hasUncommittedChanges,
  isGitRepository,
  stageAll,
} from '../utils/git.js';
import reviewCommand from './review.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';

const gitCommand: SlashCommand = {
  name: 'git',
  description: 'Git 仓库查询和 AI 辅助',
  usage: '/git [status|log|diff|review|commit|pre-commit]',
  aliases: ['g'],
  examples: [
    '/git',
    '/git status',
    '/git log 10',
    '/git review',
    '/git commit',
    '/git pre-commit',
  ],

  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { cwd } = context;
    const subcommand = args[0]?.toLowerCase();

    // 检查是否在 Git 仓库中
    if (!(await isGitRepository(cwd))) {
      return {
        success: false,
        error: '当前目录不在 Git 仓库中',
      };
    }

    try {
      switch (subcommand) {
        case 'status':
        case 's':
          return handleStatus(context);
        case 'log':
        case 'l':
          return handleLog(context, args[1]);
        case 'diff':
        case 'd':
          return handleDiff(context);
        case 'review':
        case 'r':
          return handleReview(context);
        case 'commit':
        case 'c':
          return handleCommit(context);
        case 'pre-commit':
        case 'pc':
          return handlePreCommit(context);
        default:
          // 默认显示状态概览
          return handleStatus(context);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        error: `Git 命令失败: ${errorMessage}`,
      };
    }
  },
};

/**
 * 显示 Git 状态
 */
async function handleStatus(context: SlashCommandContext): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const status = await getGitStatus({ cwd: context.cwd });
  if (!status) {
    return { success: false, error: '无法获取 Git 状态' };
  }

  const statusText = getLlmGitStatus(status);
  if (statusText) {
    ui.sendMessage(`\`\`\`\n${statusText}\n\`\`\``);
  } else {
    ui.sendMessage('无法获取 Git 状态信息');
  }

  return { success: true };
}

/**
 * 显示提交历史
 */
async function handleLog(
  context: SlashCommandContext,
  countArg?: string
): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const count = Math.min(Math.max(parseInt(countArg || '5', 10) || 5, 1), 50);
  const log = await getRecentCommitMessages(context.cwd, count);

  if (!log) {
    ui.sendMessage('暂无提交记录');
  } else {
    ui.sendMessage(`**最近 ${count} 条提交：**\n\`\`\`\n${log}\n\`\`\``);
  }

  return { success: true };
}

/**
 * 显示暂存区 diff
 */
async function handleDiff(context: SlashCommandContext): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const { cwd } = context;
  const fileList = await getStagedFileList(cwd);

  if (!fileList) {
    ui.sendMessage('暂存区为空，没有待提交的改动');
    return { success: true };
  }

  const diff = await getStagedDiff(cwd);
  const message = `**暂存文件：**\n\`\`\`\n${fileList}\n\`\`\`\n\n**Diff：**\n\`\`\`diff\n${diff || '(无差异)'}\n\`\`\``;
  ui.sendMessage(message);

  return { success: true };
}

/**
 * AI Code Review
 */
async function handleReview(context: SlashCommandContext): Promise<SlashCommandResult> {
  return reviewCommand.handler(['uncommitted'], context);
}

/**
 * AI 生成 Commit Message（不提交）
 */
async function handlePreCommit(
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const { cwd, signal } = context;

  // 检查是否有改动
  if (!(await hasUncommittedChanges(cwd))) {
    ui.sendMessage('没有未提交的改动');
    return { success: true };
  }

  // 暂存所有改动
  ui.sendMessage('暂存所有改动...');
  await stageAll(cwd);

  // 获取 diff
  const fileList = await getStagedFileList(cwd);
  const diff = await getStagedDiff(cwd);

  if (!fileList) {
    ui.sendMessage('没有需要提交的改动');
    return { success: true };
  }

  ui.sendMessage('正在生成 commit message...');

  // 获取最近的提交信息作为风格参考
  const recentCommits = await getRecentCommitMessages(cwd, 5);

  // 调用 Agent 生成 commit message
  const agent = await Agent.create();

  // 检查 Agent 创建期间是否已被中止
  if (signal?.aborted) {
    return { success: false, message: '操作已取消' };
  }

  const sessionId = getState().session.sessionId;

  const commitPrompt = generateCommitPrompt(fileList, diff, recentCommits);

  const commitLoopResult = await drainLoop(
    agent.chatStream(commitPrompt, {
      messages: [],
      userId: 'cli-user',
      sessionId: sessionId || 'git-pre-commit',
      workspaceRoot: cwd,
      signal,
    })
  );
  const commitMessage = commitLoopResult.finalMessage || '';

  // 清理 commit message（移除可能的代码块标记）
  const cleanMessage = commitMessage
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  ui.sendMessage(
    `**生成的 Commit Message：**\n\`\`\`\n${cleanMessage}\n\`\`\`\n\n使用以下命令提交：\n\`\`\`bash\ngit commit -m "${cleanMessage.split('\n')[0]}"\n\`\`\``
  );

  return { success: true };
}

/**
 * AI 生成 Commit Message 并提交
 */
async function handleCommit(context: SlashCommandContext): Promise<SlashCommandResult> {
  const ui = getUI(context);
  const { cwd, signal } = context;

  // 检查是否有改动
  if (!(await hasUncommittedChanges(cwd))) {
    ui.sendMessage('没有未提交的改动');
    return { success: true };
  }

  // 暂存所有改动
  ui.sendMessage('暂存所有改动...');
  await stageAll(cwd);

  // 获取 diff
  const fileList = await getStagedFileList(cwd);
  const diff = await getStagedDiff(cwd);

  if (!fileList) {
    ui.sendMessage('没有需要提交的改动');
    return { success: true };
  }

  ui.sendMessage('正在生成 commit message...');

  // 获取最近的提交信息作为风格参考
  const recentCommits = await getRecentCommitMessages(cwd, 5);

  // 调用 Agent 生成 commit message
  const agent = await Agent.create();

  // 检查 Agent 创建期间是否已被中止
  if (signal?.aborted) {
    return { success: false, message: '操作已取消' };
  }

  const sessionId = getState().session.sessionId;

  const commitPrompt = generateCommitPrompt(fileList, diff, recentCommits);

  const commitLoopResult = await drainLoop(
    agent.chatStream(commitPrompt, {
      messages: [],
      userId: 'cli-user',
      sessionId: sessionId || 'git-commit',
      workspaceRoot: cwd,
      signal,
    })
  );
  const commitMessage = commitLoopResult.finalMessage || '';

  // 清理 commit message（移除可能的代码块标记）
  const cleanMessage = commitMessage
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  ui.sendMessage(`**生成的 Commit Message：**\n\`\`\`\n${cleanMessage}\n\`\`\``);

  // 执行提交
  try {
    await gitCommit(cwd, cleanMessage);
    ui.sendMessage('[OK] 提交成功！');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    ui.sendMessage(`[FAIL] 提交失败: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  return { success: true };
}

/**
 * 生成 commit message 的 prompt
 * 强调参考历史提交风格
 */
function generateCommitPrompt(
  fileList: string,
  diff: string | null,
  recentCommits: string | null
): string {
  const hasHistory = recentCommits && recentCommits.trim().length > 0;

  return `请根据以下 Git 改动生成一条 commit message。

**暂存文件：**
${fileList}

**Diff 内容：**
\`\`\`diff
${diff || '(无差异)'}
\`\`\`

${
  hasHistory
    ? `**历史提交风格参考（请严格模仿此风格）：**
\`\`\`
${recentCommits}
\`\`\`

重要：请仔细分析上述历史提交的风格特征（语言、前缀、格式、长度等），生成的 commit message 必须与历史风格保持一致。`
    : `**无历史提交参考，请使用 Conventional Commits 格式。**`
}

要求：
1. ${hasHistory ? '严格模仿历史提交的语言和格式风格' : '使用英文，遵循 Conventional Commits 格式（feat:, fix:, docs:, refactor:, chore: 等）'}
2. 第一行简明扼要，不超过 72 字符
3. 如有必要，可添加空行后的详细说明
4. 只输出 commit message 内容，不要其他解释或代码块标记`;
}

export default gitCommand;
