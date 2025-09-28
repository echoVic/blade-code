/**
 * E2E 测试配置和工具
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// E2E 测试配置
export interface E2ETestConfig {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  cliPath?: string;
}

// E2E 测试结果
export interface E2ETestResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
}

// E2E 测试会话
export class E2ETestSession {
  private tempDir: string;
  private config: E2ETestConfig;

  constructor(config: E2ETestConfig = {}) {
    this.config = {
      timeout: 30000,
      cwd: process.cwd(),
      cliPath: './bin/blade.js',
      ...config,
    };

    // 创建临时目录
    this.tempDir = join(tmpdir(), `blade-e2e-${Date.now()}`);
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * 运行 CLI 命令
   */
  async runCommand(
    command: string,
    args: string[] = [],
    input?: string
  ): Promise<E2ETestResult> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const cmd = `node ${this.config.cliPath} ${command} ${args.join(' ')}`;
      const child = spawn('node', [this.config.cliPath!, command, ...args], {
        cwd: this.config.cwd || this.tempDir,
        env: {
          ...process.env,
          ...this.config.env,
          NODE_ENV: 'test',
          BLADE_TEST: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        resolve({
          stdout,
          stderr,
          exitCode: code,
          duration,
        });
      });

      child.on('error', (error) => {
        const duration = Date.now() - startTime;
        reject({
          stdout,
          stderr,
          exitCode: -1,
          duration,
          error,
        });
      });

      // 如果提供了输入，发送给子进程
      if (input) {
        child.stdin.write(input);
        child.stdin.end();
      }

      // 设置超时
      if (this.config.timeout) {
        setTimeout(() => {
          child.kill();
          const duration = Date.now() - startTime;
          reject({
            stdout,
            stderr,
            exitCode: -1,
            duration,
            error: new Error('Command timeout'),
          });
        }, this.config.timeout);
      }
    });
  }

  /**
   * 创建测试文件
   */
  createTestFile(filename: string, content: string): string {
    const filePath = join(this.tempDir, filename);
    writeFileSync(filePath, content);
    return filePath;
  }

  /**
   * 获取临时目录路径
   */
  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * 清理临时目录
   */
  cleanup(): void {
    if (existsSync(this.tempDir)) {
      rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

// E2E 测试工具类
export class E2ETestUtils {
  /**
   * 等待条件满足
   */
  static async waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await Promise.resolve(condition());
      if (result) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return false;
  }

  /**
   * 检查命令是否存在
   */
  static commandExists(command: string): boolean {
    try {
      execSync(`which ${command}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取系统信息
   */
  static getSystemInfo(): any {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: process.cwd(),
    };
  }

  /**
   * 比较输出结果
   */
  static compareOutput(actual: string, expected: string | RegExp): boolean {
    if (expected instanceof RegExp) {
      return expected.test(actual);
    } else {
      return actual.includes(expected);
    }
  }

  /**
   * 验证 E2E 测试结果
   */
  static validateResult(
    result: E2ETestResult,
    expectations: {
      exitCode?: number;
      stdout?: string | RegExp;
      stderr?: string | RegExp;
      timeout?: number;
    }
  ): boolean {
    // 检查退出码
    if (
      expectations.exitCode !== undefined &&
      result.exitCode !== expectations.exitCode
    ) {
      return false;
    }

    // 检查标准输出
    if (
      expectations.stdout !== undefined &&
      !this.compareOutput(result.stdout, expectations.stdout)
    ) {
      return false;
    }

    // 检查标准错误
    if (
      expectations.stderr !== undefined &&
      !this.compareOutput(result.stderr, expectations.stderr)
    ) {
      return false;
    }

    // 检查超时
    if (expectations.timeout !== undefined && result.duration > expectations.timeout) {
      return false;
    }

    return true;
  }
}

// E2E 测试数据工厂
export class E2ETestDataFactory {
  /**
   * 创建测试项目
   */
  static createTestProject(name: string = 'test-project'): any {
    return {
      name,
      version: '1.0.0',
      description: 'Test project for E2E testing',
      private: true,
      scripts: {
        test: 'echo "test"',
      },
    };
  }

  /**
   * 创建测试配置
   */
  static createTestConfig(): any {
    return {
      auth: {
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
        baseUrl: 'https://api.test.com',
      },
      ui: {
        theme: 'default',
        hideTips: false,
      },
      debug: {
        debug: false,
        verbose: false,
      },
    };
  }

  /**
   * 创建测试文件内容
   */
  static createTestFileContent(type: string): string {
    switch (type) {
      case 'javascript':
        return `
console.log('Hello, World!');
const greeting = 'Hello, Test!';
console.log(greeting);
`;
      case 'typescript':
        return `
interface User {
  name: string;
  age: number;
}

const user: User = {
  name: 'Test User',
  age: 30
};

console.log(user.name);
`;
      case 'json':
        return JSON.stringify(
          {
            name: 'test-config',
            version: '1.0.0',
            settings: {
              theme: 'dark',
              language: 'en',
            },
          },
          null,
          2
        );
      default:
        return 'Test file content';
    }
  }
}

// 默认导出
export default {
  E2ETestSession,
  E2ETestUtils,
  E2ETestDataFactory,
};
