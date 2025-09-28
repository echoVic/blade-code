#!/usr/bin/env node

/**
 * 智能对话命令 - 使用统一的AgentFactory
 */

import chalk from 'chalk';
import { Command } from 'commander';
import { AgentFactory } from '../agent/AgentFactory.js';

interface Agent {
  chat(message: string): Promise<string>;
  chatWithSystem(systemPrompt: string, message: string): Promise<string>;
}

/**
 * 注册Agent-LLM相关命令
 */
export function agentLlmCommand(program: Command) {
  program
    .command('chat')
    .description('💬 智能对话')
    .argument('[message]', '对话内容')
    .option('-k, --api-key <key>', 'API密钥')
    .option('-u, --base-url <url>', 'API基础URL')
    .option('-m, --model <name>', '模型名称')
    .option('-s, --system <prompt>', '系统提示词')
    .option('-i, --interactive', '交互式对话')
    .option(
      '--theme <name>',
      '界面主题 (default|dark|dracula|nord|tokyo-night|github|monokai|ayu-dark|solarized-light|solarized-dark|gruvbox|one-dark|catppuccin|rose-pine|kanagawa)'
    )
    .action(async (message, options) => {
      await handleChat(message, options);
    });
}

/**
 * 处理聊天命令
 */
async function handleChat(
  message: string | undefined,
  options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    system?: string;
    interactive?: boolean;
    theme?: string;
  }
): Promise<void> {
  try {
    // 使用AgentFactory创建Agent
    const agentFactory = AgentFactory.getInstance();
    const agent = await agentFactory.createAgent({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model
    });

    // 设置主题
    if (options.theme) {
      try {
        const { themeManager } = await import('../ui/themes/index.js');
        themeManager.setTheme(options.theme);
      } catch (error) {
        console.warn(chalk.yellow(`⚠️ 主题设置失败: ${error}`));
      }
    }

    // 交互式模式
    if (options.interactive || !message) {
      await interactiveChat(agent, options.system);
      return;
    }

    // 单次对话
    if (options.system) {
      const response = await agent.chatWithSystem(options.system, message);
      console.log(response);
    } else {
      const response = await agent.chat(message);
      console.log(response);
    }
  } catch (error) {
    console.error(chalk.red(`❌ 调用失败: ${(error as Error).message}`));
    process.exit(1);
  }
}

/**
 * 交互式聊天
 */
async function interactiveChat(agent: Agent, systemPrompt?: string): Promise<void> {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.cyan('🚀 启动交互式对话 (输入 "exit" 或 "quit" 退出)'));
  if (systemPrompt) {
    console.log(chalk.gray(`系统提示词: ${systemPrompt}`));
  }
  console.log('');

  const chatLoop = async () => {
    rl.question(chalk.green('👤 你: '), async (input: string) => {
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(chalk.yellow('👋 再见!'));
        rl.close();
        return;
      }

      if (input.trim()) {
        try {
          process.stdout.write(chalk.blue('🤖 AI: '));
          const response = systemPrompt
            ? await agent.chatWithSystem(systemPrompt, input)
            : await agent.chat(input);
          console.log(response);
        } catch (error) {
          console.error(chalk.red(`\n❌ 调用失败: ${(error as Error).message}`));
        }
      }
      console.log('');
      chatLoop();
    });
  };

  chatLoop();
}
