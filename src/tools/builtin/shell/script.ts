import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext } from '../../types/index.js';
import type { ConfirmationDetails, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zod-schemas.js';

/**
 * 脚本解释器映射
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
 * 脚本执行结果
 */
interface ScriptResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  execution_time: number;
}

/**
 * ScriptTool - 脚本执行工具
 * 使用新的 Zod 验证设计
 */
export const scriptTool = createTool({
  name: 'script',
  displayName: '脚本执行',
  kind: ToolKind.Execute,

  // Zod Schema 定义
  schema: z.object({
    script_path: ToolSchemas.filePath({
      description: '脚本文件路径',
    }),
    args: z
      .array(z.string().min(1))
      .optional()
      .describe('脚本参数列表(可选)'),
    interpreter: z
      .string()
      .optional()
      .describe('指定解释器(可选,默认根据文件扩展名自动检测)'),
    cwd: z
      .string()
      .optional()
      .describe('执行目录(可选,默认当前目录)'),
    timeout: ToolSchemas.timeout(1000, 600000, 60000),
    env: ToolSchemas.environment(),
  }),

  // 工具描述
  description: {
    short: '执行各种脚本文件，支持多种编程语言和解释器',
    long: `自动检测脚本文件类型并使用合适的解释器执行。支持 JavaScript、Python、Ruby、PHP、Perl、Shell 等多种脚本语言。`,
    usageNotes: [
      'script_path 参数是必需的',
      '支持的脚本类型: .js, .ts, .py, .rb, .php, .pl, .sh, .bash, .zsh, .fish, .ps1, .bat, .cmd',
      '可通过 interpreter 参数指定自定义解释器',
      '自动检测脚本中的危险操作并提示用户确认',
      'timeout 默认 60 秒，最长 10 分钟',
      '脚本执行前会检查文件是否存在',
    ],
    examples: [
      {
        description: '执行 Node.js 脚本',
        params: {
          script_path: './scripts/build.js',
        },
      },
      {
        description: '执行 Python 脚本并传参',
        params: {
          script_path: './scripts/process.py',
          args: ['--input', 'data.json'],
        },
      },
      {
        description: '指定解释器执行',
        params: {
          script_path: './script.sh',
          interpreter: 'zsh',
        },
      },
      {
        description: '在特定目录执行脚本',
        params: {
          script_path: './test.sh',
          cwd: '/path/to/project',
        },
      },
    ],
    important: [
      '脚本包含危险操作时需要用户确认',
      '脚本文件必须存在且可访问',
      '根据扩展名自动选择解释器',
      '支持外部网络访问和文件系统操作的脚本',
    ],
  },

  // 需要用户确认(危险脚本或自定义解释器)
  requiresConfirmation: async (params): Promise<ConfirmationDetails | null> => {
    const { script_path, interpreter } = params;

    try {
      // 读取脚本内容进行安全检查
      const content = await fs.readFile(script_path, 'utf8');
      const risks: string[] = [];

      // 检查潜在危险操作
      const dangerousPatterns = [
        /rm\s+-rf/gi,
        /sudo/gi,
        /passwd/gi,
        /chmod\s+777/gi,
        /eval\s*\(/gi,
        /exec\s*\(/gi,
        /system\s*\(/gi,
        /shell_exec/gi,
        /\$\(.*\)/gi, // 命令替换
      ];

      let hasDangerousContent = false;
      for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
          hasDangerousContent = true;
          break;
        }
      }

      if (hasDangerousContent) {
        risks.push('脚本包含可能危险的系统操作');
      }

      // 检查外部网络访问
      if (/curl|wget|fetch|http/gi.test(content)) {
        risks.push('脚本可能访问外部网络资源');
      }

      // 检查文件系统操作
      if (/write|create|delete|remove|mkdir|rmdir/gi.test(content)) {
        risks.push('脚本可能修改文件系统');
      }

      if (risks.length > 0 || interpreter) {
        return {
          type: 'execute',
          title: '确认执行脚本',
          message: `将要${interpreter ? `使用 ${interpreter} ` : ''}执行脚本 ${script_path}`,
          risks: risks.length > 0 ? risks : ['脚本执行可能对系统造成影响'],
          affectedFiles: [script_path],
        };
      }
    } catch (error) {
      return {
        type: 'execute',
        title: '脚本访问错误',
        message: `无法读取脚本文件 ${script_path}: ${(error as Error).message}`,
        risks: ['文件可能不存在或无权访问'],
        affectedFiles: [script_path],
      };
    }

    return null;
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
    const { signal, updateOutput } = context;

    try {
      // 验证脚本文件存在
      try {
        await fs.access(script_path);
      } catch (error) {
        return {
          success: false,
          llmContent: `脚本文件不存在: ${script_path}`,
          displayContent: `❌ 脚本文件不存在: ${script_path}`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: '脚本文件不存在',
          },
        };
      }

      // 确定解释器
      const finalInterpreter = interpreter || detectInterpreter(script_path);
      if (!finalInterpreter) {
        return {
          success: false,
          llmContent: `无法确定脚本解释器: ${script_path}`,
          displayContent: `❌ 无法确定脚本解释器: ${script_path}`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: '无法确定脚本解释器',
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
          llmContent: `脚本执行失败 (退出码: ${result.exit_code})${result.stderr ? `\n错误输出: ${result.stderr}` : ''}`,
          displayContent: formatDisplayMessage(result, metadata),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `脚本执行失败 (退出码: ${result.exit_code})`,
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
          llmContent: '脚本执行被中止',
          displayContent: '⚠️ 脚本执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `脚本执行失败: ${error.message}`,
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
