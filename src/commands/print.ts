import { Command } from 'commander';
import { createAgent } from '../agent/agent-creator.js';

interface PrintOptions {
  print?: boolean;
  outputFormat?: string;
  includePartialMessages?: boolean;
  inputFormat?: string;
  model?: string;
  appendSystemPrompt?: string;
}

export function printCommand(program: Command) {
  program
    .argument('[message]', 'Message to process')
    .option('-p, --print', 'Print response and exit (useful for pipes)')
    .option(
      '--output-format <format>',
      'Output format: "text", "json", "stream-json"',
      'text'
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive'
    )
    .option('--input-format <format>', 'Input format: "text", "stream-json"', 'text')
    .option('--model <model>', 'Model for the current session')
    .option(
      '--append-system-prompt <prompt>',
      'Append a system prompt to the default system prompt'
    )
    .action(async (message: string | undefined, options: PrintOptions) => {
      // 只有当设置了 --print 选项时才执行
      if (!options.print) {
        return;
      }

      try {
        const agent = await createAgent({
          model: options.model,
          systemPrompt: options.appendSystemPrompt,
        });

        let input = '';

        // 如果有 message 参数，使用它
        if (message) {
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
        if (options.appendSystemPrompt) {
          response = await agent.chatWithSystem(options.appendSystemPrompt, input);
        } else {
          response = await agent.chat(input, {
            messages: [],
            userId: 'cli-user',
            sessionId: `print-${Date.now()}`,
            workspaceRoot: process.cwd(),
          });
        }

        // 根据输出格式打印结果
        if (options.outputFormat === 'json') {
          console.log(
            JSON.stringify(
              {
                response,
                input,
                model: options.model,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            )
          );
        } else if (options.outputFormat === 'stream-json') {
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
    });
}

/**
 * 检查命令行参数是否包含 --print 选项
 * 如果包含，则以 print 模式运行
 */
export async function handlePrintMode(): Promise<boolean> {
  const argv = process.argv.slice(2);
  const printIndex = argv.findIndex((arg) => arg === '--print' || arg === '-p');

  if (printIndex === -1) {
    return false;
  }

  // 创建一个临时的 program 来处理 print 模式
  const program = new Command();
  program.name('blade').allowUnknownOption(true).exitOverride(); // 不要自动退出

  printCommand(program);

  try {
    // 重新排列参数：将 --print 移到最后
    const beforePrint = argv.slice(0, printIndex);
    const afterPrint = argv.slice(printIndex + 1);
    const message = [...beforePrint, ...afterPrint]
      .filter((arg) => !arg.startsWith('-'))
      .join(' ');

    // 构造新的 argv，保持选项和值的配对
    const optionArgs: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith('-') && arg !== '--print' && arg !== '-p') {
        optionArgs.push(arg);
        // 如果下一个参数不是选项，则是当前选项的值
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          optionArgs.push(argv[i + 1]);
          i++; // 跳过值参数
        }
      }
    }

    const newArgv = [
      'node',
      'blade',
      ...(message ? [message] : []),
      '--print',
      ...optionArgs,
    ];

    await program.parseAsync(newArgv);
    return true;
  } catch (error) {
    console.error(
      `Print mode error: ${error instanceof Error ? error.message : '未知错误'}`
    );
    process.exit(1);
  }
}
