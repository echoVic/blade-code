import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type {
  ConfirmationDetails,
  JSONSchema7,
  ToolInvocation,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * 脚本执行参数接口
 */
interface ScriptParams {
  script_path: string;
  args?: string[];
  interpreter?: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

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
 * 脚本工具调用实现
 */
class ScriptToolInvocation extends BaseToolInvocation<ScriptParams> {
  constructor(params: ScriptParams) {
    super('script', params);
  }

  getDescription(): string {
    const { script_path, args, interpreter } = this.params;
    const argsStr = args && args.length > 0 ? ` ${args.join(' ')}` : '';
    const interpreterStr = interpreter ? `使用 ${interpreter} ` : '';
    return `${interpreterStr}执行脚本: ${script_path}${argsStr}`;
  }

  getAffectedPaths(): string[] {
    const paths = [this.params.script_path];
    if (this.params.cwd) {
      paths.push(this.params.cwd);
    }
    return paths;
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { script_path, interpreter } = this.params;

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
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        script_path,
        args = [],
        interpreter,
        cwd = process.cwd(),
        timeout = 60000,
        env = {},
      } = this.params;

      // 验证脚本文件存在
      try {
        await fs.access(script_path);
      } catch (error) {
        return this.createErrorResult(`脚本文件不存在: ${script_path}`);
      }

      // 确定解释器
      const finalInterpreter = interpreter || this.detectInterpreter(script_path);
      if (!finalInterpreter) {
        return this.createErrorResult(`无法确定脚本解释器: ${script_path}`);
      }

      updateOutput?.(`使用 ${finalInterpreter} 执行脚本: ${script_path}`);

      this.checkAbortSignal(signal);

      // 执行脚本
      const startTime = Date.now();
      const result = await this.executeScript({
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

      const displayMessage = this.formatDisplayMessage(result, metadata);

      // 如果脚本执行失败，返回错误结果
      if (result.exit_code !== 0) {
        return this.createErrorResult(
          `脚本执行失败 (退出码: ${result.exit_code})${result.stderr ? `\n错误输出: ${result.stderr}` : ''}`,
          metadata
        );
      }

      return this.createSuccessResult(result, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private detectInterpreter(scriptPath: string): string | null {
    const ext = extname(scriptPath).toLowerCase();
    return INTERPRETER_MAP[ext] || null;
  }

  private async executeScript(options: {
    interpreter: string;
    scriptPath: string;
    args: string[];
    cwd: string;
    timeout: number;
    env: Record<string, string>;
    signal: AbortSignal;
    updateOutput?: (output: string) => void;
  }): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number;
    execution_time: number;
  }> {
    return new Promise((resolve, reject) => {
      const { interpreter, scriptPath, args, cwd, timeout, env, signal, updateOutput } = options;

      const childProcess = spawn(interpreter, [scriptPath, ...args], {
        cwd,
        env,
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
      childProcess.stdout.on('data', data => {
        const output = data.toString();
        stdout += output;
        updateOutput?.(output);
      });

      childProcess.stderr.on('data', data => {
        const output = data.toString();
        stderr += output;
        updateOutput?.(output);
      });

      childProcess.on('close', code => {
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

      childProcess.on('error', error => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          signal.removeEventListener('abort', abortHandler);
          reject(error);
        }
      });
    });
  }

  private formatDisplayMessage(result: any, metadata: any): string {
    const { script_path, interpreter, exit_code, execution_time } = metadata;

    let message = `脚本执行完成: ${script_path}`;
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
}

/**
 * 脚本执行工具
 * 执行各种脚本文件，自动检测解释器
 */
export class ScriptTool extends DeclarativeTool<ScriptParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        script_path: {
          type: 'string',
          description: '脚本文件路径',
        },
        args: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: '脚本参数列表（可选）',
        },
        interpreter: {
          type: 'string',
          description: '指定解释器（可选，默认根据文件扩展名自动检测）',
        },
        cwd: {
          type: 'string',
          description: '执行目录（可选，默认当前目录）',
        },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          default: 60000,
          description: '超时时间（毫秒，默认60秒）',
        },
        env: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '环境变量（可选）',
        },
      },
      required: ['script_path'],
      additionalProperties: false,
    };

    super(
      'script',
      '脚本执行',
      '执行各种脚本文件，支持多种编程语言和解释器',
      ToolKind.Execute,
      schema,
      true, // 脚本执行需要确认
      '1.0.0',
      '命令工具',
      ['script', 'execute', 'interpreter', 'automation']
    );
  }

  build(params: ScriptParams): ToolInvocation<ScriptParams> {
    // 验证参数
    const scriptPath = this.validateString(params.script_path, 'script_path', {
      required: true,
      minLength: 1,
    });

    let args: string[] | undefined;
    if (params.args !== undefined) {
      args = this.validateArray(params.args, 'args', {
        itemValidator: (item: any, index: number) => {
          return this.validateString(item, `args[${index}]`, {
            required: true,
          });
        },
      });
    }

    let interpreter: string | undefined;
    if (params.interpreter !== undefined) {
      interpreter = this.validateString(params.interpreter, 'interpreter', {
        required: false,
        minLength: 1,
      });
    }

    let cwd: string | undefined;
    if (params.cwd !== undefined) {
      cwd = this.validateString(params.cwd, 'cwd', {
        required: false,
        minLength: 1,
      });
    }

    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      timeout = this.validateNumber(params.timeout, 'timeout', {
        min: 1000,
        max: 600000,
        integer: true,
      });
    }

    let env: Record<string, string> | undefined;
    if (params.env !== undefined) {
      if (typeof params.env !== 'object' || params.env === null) {
        this.createValidationError('env', '环境变量必须是对象类型', params.env);
      }

      env = {};
      for (const [key, value] of Object.entries(params.env)) {
        env[key] = this.validateString(value, `env.${key}`, { required: true });
      }
    }

    const validatedParams: ScriptParams = {
      script_path: scriptPath,
      ...(args !== undefined && { args }),
      ...(interpreter !== undefined && { interpreter }),
      ...(cwd !== undefined && { cwd }),
      ...(timeout !== undefined && { timeout }),
      ...(env !== undefined && { env }),
    };

    return new ScriptToolInvocation(validatedParams);
  }
}
