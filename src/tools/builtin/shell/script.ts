import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Script interpreter map
 */
const INTERPRETER_MAP: Record<string, string> = {
  '.js': 'node',
  '.ts': 'ts-node',
  '.py': 'python3',
  '.rb': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',
  '.ps1': 'powershell',
  '.bat': 'cmd',
  '.cmd': 'cmd',
};

/**
 * Script execution result
 */
interface ScriptResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  execution_time: number;
}

/**
 * ScriptTool - Script executor
 * Uses the newer Zod validation design
 */
export const scriptTool = createTool({
  name: 'Script',
  displayName: 'Script Runner',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    script_path: ToolSchemas.filePath({
      description: 'Path to the script file',
    }),
    args: z.array(z.string().min(1)).optional().describe('Script arguments (optional)'),
    interpreter: z
      .string()
      .optional()
      .describe('Interpreter to use (optional; auto-detected from extension)'),
    cwd: z.string().optional().describe('Working directory (optional, defaults to cwd)'),
    timeout: ToolSchemas.timeout(1000, 600000, 60000),
    env: ToolSchemas.environment(),
  }),

  // 工具描述
  description: {
    short: 'Execute scripts with multiple languages and interpreters',
    long: `Auto-detects script type and runs it with the appropriate interpreter. Supports JavaScript, Python, Ruby, PHP, Perl, Shell, and more.`,
    usageNotes: [
      'script_path is required',
      'Supported extensions: .js, .ts, .py, .rb, .php, .pl, .sh, .bash, .zsh, .fish, .ps1, .bat, .cmd',
      'Override interpreter via the interpreter parameter',
      'Dangerous operations may require user confirmation',
      'timeout defaults to 60s, max 10 minutes',
      'File existence is checked before execution',
    ],
    examples: [
      {
        description: 'Run a Node.js script',
        params: {
          script_path: './scripts/build.js',
        },
      },
      {
        description: 'Run a Python script with arguments',
        params: {
          script_path: './scripts/process.py',
          args: ['--input', 'data.json'],
        },
      },
      {
        description: 'Use a specific interpreter',
        params: {
          script_path: './script.sh',
          interpreter: 'zsh',
        },
      },
      {
        description: 'Run a script in a specific directory',
        params: {
          script_path: './test.sh',
          cwd: '/path/to/project',
        },
      },
    ],
    important: [
      'Dangerous scripts require user confirmation',
      'Script file must exist and be accessible',
      'Interpreter is auto-selected based on extension',
      'Scripts may access network and filesystem as permitted',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      script_path,
      args = [],
      interpreter,
      cwd = process.cwd(),
      timeout = 60000,
      env = {},
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      // 验证脚本文件存在
      try {
        await fs.access(script_path);
      } catch (_error) {
          return {
            success: false,
            llmContent: `Script file not found: ${script_path}`,
            displayContent: `❌ 脚本文件不存在: ${script_path}`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'Script file not found',
            },
          };
      }

      // 确定解释器
      const finalInterpreter = interpreter || detectInterpreter(script_path);
      if (!finalInterpreter) {
        return {
          success: false,
          llmContent: `Cannot determine script interpreter: ${script_path}`,
            displayContent: `❌ 无法确定脚本解释器: ${script_path}`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'Cannot determine script interpreter',
            },
          };
      }

      updateOutput?.(`使用 ${finalInterpreter} 执行脚本: ${script_path}`);

      signal.throwIfAborted();

      // 执行脚本
      const startTime = Date.now();
      const result = await executeScript({
        interpreter: finalInterpreter,
        scriptPath: script_path,
        args,
        cwd,
        timeout,
        env: { ...process.env, ...env },
        signal,
        updateOutput,
      });

      const executionTime = Date.now() - startTime;
      result.execution_time = executionTime;

      const metadata = {
        script_path,
        interpreter: finalInterpreter,
        args,
        cwd,
        exit_code: result.exit_code,
        execution_time: executionTime,
        has_stderr: result.stderr.length > 0,
        stdout_length: result.stdout.length,
        stderr_length: result.stderr.length,
      };

      // 如果脚本执行失败，返回错误结果
      if (result.exit_code !== 0) {
        return {
          success: false,
          llmContent: `Script execution failed (exit code: ${result.exit_code})${result.stderr ? `\nStderr: ${result.stderr}` : ''}`,
          displayContent: formatDisplayMessage(result, metadata),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Script execution failed (exit code: ${result.exit_code})`,
            details: result,
          },
          metadata,
        };
      }

      return {
        success: true,
        llmContent: result,
        displayContent: formatDisplayMessage(result, metadata),
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Script execution aborted',
          displayContent: '⚠️ 脚本执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Operation aborted',
          },
        };
      }

      return {
        success: false,
        llmContent: `Script execution failed: ${error.message}`,
        displayContent: `❌ 脚本执行失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '命令工具',
  tags: ['script', 'execute', 'interpreter', 'automation'],

  /**
   * 提取签名内容：返回脚本路径
   */
  extractSignatureContent: (params) => params.script_path,

  /**
   * 抽象权限规则：返回解释器通配符
   */
  abstractPermissionRule: (params) => `${params.interpreter || '*'}:*`,
});

/**
 * 检测解释器
 */
function detectInterpreter(scriptPath: string): string | null {
  const ext = extname(scriptPath).toLowerCase();
  return INTERPRETER_MAP[ext] || null;
}

/**
 * 执行脚本
 */
async function executeScript(options: {
  interpreter: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  timeout: number;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const { interpreter, scriptPath, args, cwd, timeout, env, signal, updateOutput } =
      options;

    // 过滤掉 undefined 值
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        cleanEnv[key] = value;
      }
    }

    const childProcess = spawn(interpreter, [scriptPath, ...args], {
      cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let isResolved = false;

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      if (!isResolved) {
        childProcess.kill('SIGTERM');
        reject(new Error(`脚本执行超时 (${timeout}ms)`));
      }
    }, timeout);

    // 处理中止信号
    const abortHandler = () => {
      if (!isResolved) {
        childProcess.kill('SIGTERM');
        reject(new Error('脚本执行被用户中止'));
      }
    };

    signal.addEventListener('abort', abortHandler);

    // 收集输出
    childProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      updateOutput?.(output);
    });

    childProcess.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      updateOutput?.(output);
    });

    childProcess.on('close', (code) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', abortHandler);

        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: code || 0,
          execution_time: 0, // 将在外部设置
        });
      }
    });

    childProcess.on('error', (error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', abortHandler);
        reject(error);
      }
    });
  });
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  result: ScriptResult,
  metadata: {
    script_path: string;
    interpreter: string;
    exit_code: number;
    execution_time: number;
  }
): string {
  const { script_path, interpreter, exit_code, execution_time } = metadata;

  let message =
    exit_code === 0
      ? `✅ 脚本执行完成: ${script_path}`
      : `❌ 脚本执行失败: ${script_path}`;
  message += `\n解释器: ${interpreter}`;
  message += `\n退出码: ${exit_code}`;
  message += `\n执行时间: ${execution_time}ms`;

  if (result.stdout) {
    message += `\n标准输出 (${result.stdout.length} 字符):\n${result.stdout}`;
  }

  if (result.stderr && result.stderr.length > 0) {
    message += `\n错误输出 (${result.stderr.length} 字符):\n${result.stderr}`;
  }

  return message;
}
