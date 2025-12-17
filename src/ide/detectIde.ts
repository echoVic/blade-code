/**
 * IDE 检测模块
 *
 * 检测当前运行环境中的 IDE 信息
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface IdeInfo {
  name: string;
  version: string;
  path?: string;
  extensions: string[];
}

export class IdeDetector {
  /**
   * 检测当前 IDE 环境
   */
  static async detectIde(): Promise<IdeInfo | null> {
    // 检查环境变量判断是否在 VS Code 终端中
    const termProgram = process.env.TERM_PROGRAM;
    const vscodeTerminal = process.env.VSCODE_INJECTION;
    const vscodeIpc = process.env.VSCODE_IPC_HOOK;

    if (termProgram === 'vscode' || vscodeTerminal || vscodeIpc) {
      return await this.detectVsCode();
    }

    // 尝试检测其他 IDE
    const vsCode = await this.detectVsCode();
    if (vsCode) return vsCode;

    return null;
  }

  /**
   * 检测 VS Code
   */
  private static async detectVsCode(): Promise<IdeInfo | null> {
    try {
      const { stdout } = await execAsync('code --version');
      const lines = stdout.trim().split('\n');
      const version = lines[0] || 'unknown';

      // 获取已安装的扩展
      let extensions: string[] = [];
      try {
        const { stdout: extOut } = await execAsync('code --list-extensions');
        extensions = extOut.trim().split('\n').filter(Boolean);
      } catch {
        // 忽略扩展列表获取失败
      }

      return {
        name: 'VS Code',
        version,
        extensions,
      };
    } catch {
      return null;
    }
  }

  /**
   * 检测是否运行在 IDE 终端中
   */
  static isRunningInIdeTerminal(): boolean {
    const termProgram = process.env.TERM_PROGRAM;
    const vscodeTerminal = process.env.VSCODE_INJECTION;
    const vscodeIpc = process.env.VSCODE_IPC_HOOK;

    return termProgram === 'vscode' || !!vscodeTerminal || !!vscodeIpc;
  }
}
