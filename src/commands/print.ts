import type { Argv } from 'yargs';
import { Agent } from '../agent/Agent.js';

interface PrintOptions {
  print?: boolean;
  outputFormat?: string;
  includePartialMessages?: boolean;
  inputFormat?: string;
  model?: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  maxTurns?: number;
  _?: (string | number)[];
}

export function printCommand(yargs: Argv) {
  return yargs.command(
    '* [message]',
    'Print response and exit (useful for pipes)',
    (y) => {
      return y
        .positional('message', {
          describe: 'Message to process',
          type: 'string',
        })
        .option('p', {
          alias: 'print',
          describe: 'Print response and exit (useful for pipes)',
          type: 'boolean',
        })
        .option('output-format', {
          describe: 'Output format: "text", "json", "stream-json"',
          type: 'string',
          default: 'text',
        })
        .option('include-partial-messages', {
          describe: 'Include partial message chunks as they arrive',
          type: 'boolean',
        })
        .option('input-format', {
          describe: 'Input format: "text", "stream-json"',
          type: 'string',
          default: 'text',
        })
        .option('model', {
          describe: 'Model for the current session',
          type: 'string',
        })
        .option('append-system-prompt', {
          describe: 'Append a system prompt to the default system prompt',
          type: 'string',
        })
        .option('system-prompt', {
          describe: 'Replace the default system prompt',
          type: 'string',
        })
        .option('max-turns', {
          alias: ['maxTurns'],
          describe: 'Maximum conversation turns (-1: unlimited, N>0: limit to N turns)',
          type: 'number',
        });
    },
    async (argv: PrintOptions) => {
      // 只有当设置了 --print 选项时才执行
      if (!argv.print) {
        return;
      }

      try {
        const agent = await Agent.create({
          systemPrompt: argv.systemPrompt,
          appendSystemPrompt: argv.appendSystemPrompt,
          maxTurns: argv.maxTurns,
        });

        let input = '';

        // 如果有 message 参数，使用它
        const message = argv._?.[0];
        if (message && typeof message === 'string') {
          input = message;
        } else if (!process.stdin.isTTY) {
          // 从 stdin 读取输入（管道输入）
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          input = Buffer.concat(chunks).toString('utf-8').trim();
        } else {
          input = 'Hello';
        }

        // 根据是否有系统提示词选择不同的调用方式
        let response: string;
        if (argv.appendSystemPrompt) {
          response = await agent.chatWithSystem(argv.appendSystemPrompt, input);
        } else {
          response = await agent.chat(input, {
            messages: [],
            userId: 'cli-user',
            sessionId: `print-${Date.now()}`,
            workspaceRoot: process.cwd(),
          });
        }

        // 根据输出格式打印结果
        if (argv.outputFormat === 'json') {
          console.log(
            JSON.stringify(
              {
                response,
                input,
                model: argv.model,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            )
          );
        } else if (argv.outputFormat === 'stream-json') {
          // 流式 JSON 输出
          console.log(JSON.stringify({ type: 'response', content: response }));
        } else {
          // 默认文本输出
          console.log(response);
        }

        process.exit(0);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : '未知错误'}`);
        process.exit(1);
      }
    }
  );
}

/**
 * 检查命令行参数是否包含 --print 选项
 * 如果包含,则以 print 模式运行
 */
export async function handlePrintMode(): Promise<boolean> {
  const argv = process.argv.slice(2);
  const printIndex = argv.findIndex((arg) => arg === '--print' || arg === '-p');

  if (printIndex === -1) {
    return false;
  }

  try {
    const yargs = (await import('yargs')).default;
    const { hideBin } = await import('yargs/helpers');

    const cli = yargs(hideBin(process.argv)).scriptName('blade').strict(false);

    printCommand(cli);

    await cli.parse();
    return true;
  } catch (error) {
    console.error(
      `Print mode error: ${error instanceof Error ? error.message : '未知错误'}`
    );
    process.exit(1);
  }
}
