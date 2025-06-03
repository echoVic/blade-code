import chalk from 'chalk';
import { exec } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import inquirer from 'inquirer';
import path from 'path';
import { promisify } from 'util';
import type { ToolDefinition } from '../types.js';

const execAsync = promisify(exec);

/**
 * 命令确认交互工具 - 安全的命令确认功能
 */
const commandConfirmationTool: ToolDefinition = {
  name: 'command_confirmation',
  description: '显示命令供用户确认执行，提供安全的命令确认交互',
  parameters: {
    command: {
      type: 'string',
      description: '要执行的命令',
    },
    description: {
      type: 'string',
      description: '命令的描述说明',
    },
    workingDirectory: {
      type: 'string',
      description: '工作目录',
      default: process.cwd(),
    },
    riskLevel: {
      type: 'string',
      description: '风险级别：safe, moderate, high',
      default: 'moderate',
    },
  },
  required: ['command'],
  async execute(params) {
    const {
      command,
      description,
      workingDirectory = process.cwd(),
      riskLevel = 'moderate',
    } = params;

    try {
      // 预检查命令
      const preCheckResult = await preCheckCommand(command, workingDirectory);

      if (!preCheckResult.valid) {
        console.log(chalk.yellow(`⚠️  预检查发现问题: ${preCheckResult.message}`));

        if (preCheckResult.suggestions && preCheckResult.suggestions.length > 0) {
          console.log(chalk.blue('\n💡 建议的替代方案:'));

          const choices = preCheckResult.suggestions.map((suggestion, index) => ({
            name: `${chalk.cyan(suggestion.command)} ${chalk.gray(`- ${suggestion.description}`)}`,
            value: index,
            short: suggestion.command,
          }));

          choices.push({ name: chalk.gray('取消执行'), value: -1, short: '取消' });

          const { selectedIndex } = await inquirer.prompt([
            {
              type: 'list',
              name: 'selectedIndex',
              message: '请选择要执行的命令:',
              choices,
              pageSize: 10,
            },
          ]);

          if (selectedIndex === -1) {
            return {
              success: false,
              error: '用户取消执行',
              cancelled: true,
            };
          }

          const selectedSuggestion = preCheckResult.suggestions[selectedIndex];
          return await executeCommand(
            selectedSuggestion.command,
            selectedSuggestion.description || description,
            workingDirectory,
            riskLevel
          );
        }

        return {
          success: false,
          error: preCheckResult.message,
        };
      }

      return await executeCommand(command, description, workingDirectory, riskLevel);
    } catch (error: any) {
      return {
        success: false,
        error: `命令确认失败: ${error.message}`,
      };
    }
  },
};

/**
 * 预检查命令
 */
async function preCheckCommand(
  command: string,
  workingDirectory: string
): Promise<{
  valid: boolean;
  message?: string;
  suggestions?: Array<{ command: string; description: string }>;
}> {
  // 检查删除命令
  if (command.match(/^rm\s+(-[rf]*\s+)?(.+)$/)) {
    const match = command.match(/^rm\s+(-[rf]*\s+)?(.+)$/);
    if (match) {
      const flags = match[1] || '';
      const target = match[2].trim();

      // 检查目标是否存在
      const targetPath = path.resolve(workingDirectory, target);

      if (!existsSync(targetPath)) {
        // 尝试查找类似的文件/目录
        const suggestions = await findSimilarPaths(target, workingDirectory);

        if (suggestions.length > 0) {
          return {
            valid: false,
            message: `目标 "${target}" 不存在`,
            suggestions: suggestions.map(suggestion => ({
              command: `rm ${flags}${suggestion}`,
              description: `删除 ${suggestion}`,
            })),
          };
        }

        return {
          valid: false,
          message: `目标 "${target}" 不存在，无法删除`,
        };
      }

      // 检查是否是目录
      const stat = statSync(targetPath);
      if (stat.isDirectory() && !flags.includes('r')) {
        return {
          valid: false,
          message: `"${target}" 是目录，需要使用 -r 参数`,
          suggestions: [
            {
              command: `rm -r ${target}`,
              description: `递归删除目录 ${target}`,
            },
            {
              command: `rm -rf ${target}`,
              description: `强制递归删除目录 ${target}`,
            },
          ],
        };
      }
    }
  }

  return { valid: true };
}

/**
 * 查找类似的路径
 */
async function findSimilarPaths(target: string, workingDirectory: string): Promise<string[]> {
  const matches: string[] = [];

  try {
    // 递归搜索匹配的文件/目录
    const searchInDirectory = (dir: string, currentDepth: number, maxDepth: number): void => {
      if (currentDepth > maxDepth) return;

      try {
        const items = readdirSync(dir);

        for (const item of items) {
          // 跳过隐藏文件和node_modules
          if (item.startsWith('.') || item === 'node_modules') continue;

          const fullPath = path.join(dir, item);
          const relativePath = path.relative(workingDirectory, fullPath);

          try {
            const stat = statSync(fullPath);

            // 检查名称是否匹配
            if (
              item.toLowerCase().includes(target.toLowerCase()) ||
              target.toLowerCase().includes(item.toLowerCase())
            ) {
              matches.push(relativePath);
            }

            // 如果是目录，继续递归搜索
            if (stat.isDirectory() && currentDepth < maxDepth) {
              searchInDirectory(fullPath, currentDepth + 1, maxDepth);
            }
          } catch (e) {
            // 忽略权限错误等
          }
        }
      } catch (e) {
        // 忽略读取目录错误
      }
    };

    searchInDirectory(workingDirectory, 0, 2); // 最大搜索深度为2

    return matches.slice(0, 5); // 最多返回5个建议
  } catch (error) {
    return [];
  }
}

/**
 * 执行命令
 */
async function executeCommand(
  command: string,
  description: string | undefined,
  workingDirectory: string,
  riskLevel: string
) {
  // 显示命令信息
  console.log(chalk.blue('\n📋 建议执行以下命令:'));
  console.log(chalk.cyan(`  ${command}`));

  if (description) {
    console.log(chalk.gray(`  说明: ${description}`));
  }

  console.log(chalk.gray(`  工作目录: ${workingDirectory}`));
  console.log(chalk.gray(`  风险级别: ${getRiskLevelDisplay(riskLevel)}`));

  // 用户确认
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: '是否执行此命令？',
      default: false,
    },
  ]);

  if (!confirm) {
    return {
      success: false,
      error: '用户取消执行',
      cancelled: true,
    };
  }

  // 执行命令
  console.log(chalk.blue('\n⚡ 正在执行命令...'));
  const startTime = Date.now();

  try {
    const result = await execAsync(command, {
      cwd: workingDirectory,
      timeout: 30000,
    });

    const duration = Date.now() - startTime;

    console.log(chalk.green(`✅ 命令执行成功 (${duration}ms)`));

    if (result.stdout) {
      console.log('\n📤 输出:');
      console.log(result.stdout);
    }

    return {
      success: true,
      data: {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        duration,
        workingDirectory,
      },
    };
  } catch (error: any) {
    console.log(chalk.red(`❌ 命令执行失败: ${error.message}`));

    if (error.stdout) {
      console.log('\n📤 标准输出:');
      console.log(error.stdout);
    }

    if (error.stderr) {
      console.log('\n🚨 错误输出:');
      console.log(error.stderr);
    }

    return {
      success: false,
      error: error.message,
      data: {
        command,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.code,
        workingDirectory,
      },
    };
  }
}

/**
 * 批量命令确认工具
 */
const batchCommandConfirmationTool: ToolDefinition = {
  name: 'batch_command_confirmation',
  description: '显示多个命令供用户选择和执行',
  parameters: {
    commands: {
      type: 'array',
      description: '命令列表',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          riskLevel: { type: 'string' },
        },
      },
    },
    workingDirectory: {
      type: 'string',
      description: '工作目录',
      default: process.cwd(),
    },
  },
  required: ['commands'],
  async execute(params) {
    const { commands, workingDirectory = process.cwd() } = params;

    if (!Array.isArray(commands) || commands.length === 0) {
      return {
        success: false,
        error: '命令列表不能为空',
      };
    }

    try {
      console.log(chalk.blue('\n📋 建议的命令选项:'));

      // 显示命令选项
      const choices = commands.map((cmd, index) => ({
        name: `${chalk.cyan(cmd.command)} ${chalk.gray(`- ${cmd.description || '无描述'}`)}`,
        value: index,
        short: cmd.command,
      }));

      choices.push({ name: chalk.gray('取消执行'), value: -1, short: '取消' });

      const { selectedIndex } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedIndex',
          message: '请选择要执行的命令:',
          choices,
          pageSize: 10,
        },
      ]);

      if (selectedIndex === -1) {
        return {
          success: false,
          error: '用户取消执行',
          cancelled: true,
        };
      }

      const selectedCommand = commands[selectedIndex];

      // 执行选中的命令
      return await commandConfirmationTool.execute({
        ...selectedCommand,
        workingDirectory,
      });
    } catch (error: any) {
      return {
        success: false,
        error: `批量命令确认失败: ${error.message}`,
      };
    }
  },
};

/**
 * 获取风险级别显示
 */
function getRiskLevelDisplay(level: string): string {
  switch (level.toLowerCase()) {
    case 'safe':
      return chalk.green('安全');
    case 'moderate':
      return chalk.yellow('中等');
    case 'high':
      return chalk.red('高风险');
    default:
      return chalk.gray('未知');
  }
}

export const commandConfirmationTools = [commandConfirmationTool, batchCommandConfirmationTool];

export { batchCommandConfirmationTool, commandConfirmationTool };
