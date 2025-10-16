/**
 * Yargs 配置文件
 * 定义所有全局选项和命令结构
 */

import type { Options } from 'yargs';
import { getDescription, getVersion } from '../utils/packageInfo.js';
import type { GlobalOptions } from './types.js';

export const globalOptions: Record<keyof GlobalOptions, Options> = {
  debug: {
    alias: 'd',
    type: 'string',
    describe:
      'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!statsig,!file")',
    group: 'Debug Options:',
    // TODO: 实现过滤逻辑
    // 正向过滤：--debug "api,hooks" 只显示 api 和 hooks 类别
    // 负向过滤：--debug "!statsig,!file" 排除 statsig 和 file 类别
  },
  verbose: {
    type: 'boolean',
    describe: 'Override verbose mode setting from config',
    group: 'Debug Options:',
  },
  print: {
    alias: 'p',
    type: 'boolean',
    describe: 'Print response and exit (useful for pipes)',
    group: 'Output Options:',
  },
  outputFormat: {
    type: 'string',
    choices: ['text', 'json', 'stream-json'],
    default: 'text',
    describe: 'Output format (only works with --print)',
    group: 'Output Options:',
  },
  includePartialMessages: {
    type: 'boolean',
    describe: 'Include partial message chunks as they arrive',
    group: 'Output Options:',
  },
  inputFormat: {
    type: 'string',
    choices: ['text', 'stream-json'],
    default: 'text',
    describe: 'Input format',
    group: 'Input Options:',
  },
  replayUserMessages: {
    type: 'boolean',
    describe: 'Re-emit user messages from stdin',
    group: 'Input Options:',
  },
  allowedTools: {
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to allow',
    group: 'Security Options:',
  },
  disallowedTools: {
    type: 'array',
    string: true,
    describe: 'Comma or space-separated list of tool names to deny',
    group: 'Security Options:',
  },
  mcpConfig: {
    type: 'array',
    string: true,
    describe: 'Load MCP servers from JSON files or strings',
    group: 'MCP Options:',
  },
  systemPrompt: {
    type: 'string',
    describe: 'System prompt to use for the session (replaces default)',
    group: 'AI Options:',
  },
  appendSystemPrompt: {
    type: 'string',
    describe: 'Append a system prompt to the default system prompt',
    group: 'AI Options:',
  },
  'permission-mode': {
    type: 'string',
    choices: ['default', 'autoEdit', 'yolo', 'plan'],
    describe: 'Permission mode (default: ask for non-read tools, autoEdit: auto-approve edits, yolo: auto-approve all, plan: reserved)',
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
    type: 'string',
    describe: 'Resume a conversation',
    group: 'Session Options:',
  },
  forkSession: {
    type: 'boolean',
    describe: 'Create a new session ID when resuming',
    group: 'Session Options:',
  },
  model: {
    type: 'string',
    describe: 'Model for the current session',
    group: 'AI Options:',
  },
  fallbackModel: {
    type: 'string',
    describe: 'Enable automatic fallback to specified model',
    group: 'AI Options:',
  },
  settings: {
    type: 'string',
    describe: 'Path to a settings JSON file or JSON string',
    group: 'Configuration:',
  },
  addDir: {
    type: 'array',
    string: true,
    describe: 'Additional directories to allow tool access to',
    group: 'Security Options:',
  },
  ide: {
    type: 'boolean',
    describe: 'Automatically connect to IDE on startup',
    group: 'Integration:',
  },
  strictMcpConfig: {
    type: 'boolean',
    describe: 'Only use MCP servers from --mcp-config',
    group: 'MCP Options:',
  },
  sessionId: {
    type: 'string',
    describe: 'Use a specific session ID for the conversation',
    group: 'Session Options:',
  },
  agents: {
    type: 'string',
    describe: 'JSON object defining custom agents',
    group: 'AI Options:',
  },
  settingSources: {
    type: 'string',
    describe: 'Comma-separated list of setting sources to load',
    group: 'Configuration:',
  },
};

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
