/**
 * Yargs 配置文件
 * 定义所有全局选项和命令结构
 */

import type { Options } from 'yargs';
import { getDescription, getVersion } from '../utils/packageInfo.js';

export const globalOptions = {
  debug: {
    alias: 'd',
    type: 'string',
    describe:
      'Enable debug mode with optional category filtering (e.g., "agent,ui" or "!chat,!loop")',
    group: 'Debug Options:',
    // 过滤逻辑已实现：
    // 正向过滤：--debug "agent,ui" 只显示 Agent 和 UI 类别
    // 负向过滤：--debug "!chat,!loop" 排除 Chat 和 Loop 类别
    // 支持的分类：agent, ui, tool, service, config, context, execution, loop, chat, general
  },
  print: {
    alias: 'p',
    type: 'boolean',
    describe: 'Print response and exit (useful for pipes)',
    group: 'Output Options:',
  },
  'output-format': {
    alias: ['outputFormat'],
    type: 'string',
    choices: ['text', 'json', 'stream-json'],
    default: 'text',
    describe: 'Output format (only works with --print)',
    group: 'Output Options:',
  },
  'include-partial-messages': {
    alias: ['includePartialMessages'],
    type: 'boolean',
    describe: 'Include partial message chunks as they arrive',
    group: 'Output Options:',
  },
  'input-format': {
    alias: ['inputFormat'],
    type: 'string',
    choices: ['text', 'stream-json'],
    default: 'text',
    describe: 'Input format',
    group: 'Input Options:',
  },
  'replay-user-messages': {
    alias: ['replayUserMessages'],
    type: 'boolean',
    describe: 'Re-emit user messages from stdin',
    group: 'Input Options:',
  },
  'allowed-tools': {
    alias: ['allowedTools'],
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to allow',
    group: 'Security Options:',
  },
  'disallowed-tools': {
    alias: ['disallowedTools'],
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to deny',
    group: 'Security Options:',
  },
  'mcp-config': {
    alias: ['mcpConfig'],
    type: 'array',
    string: true,
    describe: 'Load MCP servers from JSON files or strings',
    group: 'MCP Options:',
  },
  'system-prompt': {
    alias: ['systemPrompt'],
    type: 'string',
    describe: 'System prompt to use for the session (replaces default)',
    group: 'AI Options:',
  },
  'append-system-prompt': {
    alias: ['appendSystemPrompt'],
    type: 'string',
    describe: 'Append a system prompt to the default system prompt',
    group: 'AI Options:',
  },
  'max-turns': {
    alias: ['maxTurns'],
    type: 'number',
    describe:
      'Maximum conversation turns (-1: unlimited, 0: disable chat, N>0: limit to N turns)',
    group: 'AI Options:',
    default: undefined, // 不设置默认值，优先使用配置文件
  },
  'permission-mode': {
    alias: ['permissionMode'],
    type: 'string',
    choices: ['default', 'autoEdit', 'yolo', 'plan'],
    describe:
      'Permission mode (default: ask for non-read tools, autoEdit: auto-approve edits, yolo: auto-approve all, plan: reserved)',
    group: 'Security Options:',
  },
  yolo: {
    type: 'boolean',
    describe: 'Auto-approve all tools (shortcut for --permission-mode=yolo)',
    group: 'Security Options:',
  },
  continue: {
    alias: 'c',
    type: 'boolean',
    describe: 'Continue the most recent conversation',
    group: 'Session Options:',
  },
  resume: {
    alias: 'r',
    describe:
      'Resume a conversation - provide a session ID or interactively select a conversation to resume',
    group: 'Session Options:',
    // 移除 type 声明，让 yargs 自动推断
    coerce: (value: string | boolean | undefined) => {
      // 如果没有提供值（value === undefined 或 true），返回 'true' 表示交互式选择
      if (value === undefined || value === true || value === '') {
        return 'true';
      }
      // 如果提供了值，返回 sessionId
      return String(value);
    },
  },
  'fork-session': {
    alias: ['forkSession'],
    type: 'boolean',
    describe: 'Create a new session ID when resuming',
    group: 'Session Options:',
  },

  // TODO: 未实现 - 需要在 UI/Agent 中读取并使用
  settings: {
    type: 'string',
    describe: 'Path to a settings JSON file or JSON string',
    group: 'Configuration:',
  },
  'add-dir': {
    alias: ['addDir'],
    type: 'array',
    string: true,
    describe: 'Additional directories to allow tool access to',
    group: 'Security Options:',
  },
  // TODO: 未实现 - 需要在 UI 启动时自动连接 IDE
  ide: {
    type: 'boolean',
    describe: 'Automatically connect to IDE on startup',
    group: 'Integration:',
  },
  acp: {
    type: 'boolean',
    describe: 'Run in ACP (Agent Client Protocol) mode for IDE integration',
    group: 'Integration:',
  },
  'strict-mcp-config': {
    alias: ['strictMcpConfig'],
    type: 'boolean',
    describe: 'Only use MCP servers from --mcp-config',
    group: 'MCP Options:',
  },
  'session-id': {
    alias: ['sessionId'],
    type: 'string',
    describe: 'Use a specific session ID for the conversation',
    group: 'Session Options:',
  },
  // TODO: 未实现 - 需要解析 JSON 并配置自定义 Agent
  agents: {
    type: 'string',
    describe: 'JSON object defining custom agents',
    group: 'AI Options:',
  },
  'setting-sources': {
    alias: ['settingSources'],
    type: 'string',
    describe: 'Comma-separated list of setting sources to load',
    group: 'Configuration:',
  },
  'plugin-dir': {
    alias: ['pluginDir'],
    type: 'array',
    string: true,
    describe: 'Load plugins from specified directories',
    group: 'Plugin Options:',
  },
} satisfies Record<string, Options>;

export const cliConfig = {
  scriptName: 'blade',
  usage: '$0 [command] [options]',
  description: getDescription(),
  version: getVersion(),
  locale: 'en', // 使用英文，因为 Yargs 的中文支持有限
  showHelpOnFail: true,
  demandCommand: false, // 允许无命令运行（进入UI模式）
  recommendCommands: true, // 启用 "Did you mean?" 功能
  strict: false, // 允许未知选项（为了兼容性）
};
