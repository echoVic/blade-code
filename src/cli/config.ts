/**
 * Yargs 配置文件
 * 定义所有全局选项和命令结构
 */

import type { Options } from 'yargs';
import type { GlobalOptions } from './types.js';
import { getDescription, getVersion } from '../utils/package-info.js';

export const globalOptions: Record<keyof GlobalOptions, Options> = {
  debug: {
    alias: 'd',
    type: 'string',
    describe: 'Enable debug mode with optional category filtering',
    group: 'Debug Options:',
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
  dangerouslySkipPermissions: {
    type: 'boolean',
    describe: 'Bypass all permission checks',
    group: 'Security Options:',
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
  appendSystemPrompt: {
    type: 'string',
    describe: 'Append a system prompt to the default system prompt',
    group: 'AI Options:',
  },
  permissionMode: {
    type: 'string',
    choices: ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
    describe: 'Permission mode',
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