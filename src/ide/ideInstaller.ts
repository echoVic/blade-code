/**
 * IDE 安装器模块
 *
 * 检测和安装 IDE 扩展
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface InstalledIde {
  id: string;
  name: string;
  version: string;
  path?: string;
}

export class IdeInstaller {
  /**
   * 获取已安装的 IDE 列表
   */
  static async getInstalledIdes(): Promise<InstalledIde[]> {
    const ides: InstalledIde[] = [];

    // 检测 VS Code
    const vsCode = await this.checkVsCode();
    if (vsCode) ides.push(vsCode);

    // 检测 VS Code Insiders
    const vsCodeInsiders = await this.checkVsCodeInsiders();
    if (vsCodeInsiders) ides.push(vsCodeInsiders);

    // 检测 Cursor
    const cursor = await this.checkCursor();
    if (cursor) ides.push(cursor);

    return ides;
  }

  /**
   * 检查指定 IDE 是否已安装
   */
  static async isIdeInstalled(ideId: string): Promise<boolean> {
    switch (ideId) {
      case 'vscode':
        return (await this.checkVsCode()) !== null;
      case 'vscode-insiders':
        return (await this.checkVsCodeInsiders()) !== null;
      case 'cursor':
        return (await this.checkCursor()) !== null;
      default:
        return false;
    }
  }

  /**
   * 安装 Blade Code 扩展到 VS Code
   */
  static async installExtension(
    ideId: string
  ): Promise<{ success: boolean; message: string }> {
    let command: string;

    switch (ideId) {
      case 'vscode':
        command = 'code --install-extension blade-code.blade-code';
        break;
      case 'vscode-insiders':
        command = 'code-insiders --install-extension blade-code.blade-code';
        break;
      case 'cursor':
        command = 'cursor --install-extension blade-code.blade-code';
        break;
      default:
        return { success: false, message: '不支持的 IDE: ' + ideId };
    }

    try {
      await execAsync(command);
      return { success: true, message: '扩展安装成功' };
    } catch (error) {
      return {
        success: false,
        message: '安装失败: ' + (error instanceof Error ? error.message : '未知错误'),
      };
    }
  }

  /**
   * 检测 VS Code
   */
  private static async checkVsCode(): Promise<InstalledIde | null> {
    try {
      const { stdout } = await execAsync('code --version');
      const version = stdout.trim().split('\n')[0] || 'unknown';
      return {
        id: 'vscode',
        name: 'VS Code',
        version,
      };
    } catch {
      return null;
    }
  }

  /**
   * 检测 VS Code Insiders
   */
  private static async checkVsCodeInsiders(): Promise<InstalledIde | null> {
    try {
      const { stdout } = await execAsync('code-insiders --version');
      const version = stdout.trim().split('\n')[0] || 'unknown';
      return {
        id: 'vscode-insiders',
        name: 'VS Code Insiders',
        version,
      };
    } catch {
      return null;
    }
  }

  /**
   * 检测 Cursor
   */
  private static async checkCursor(): Promise<InstalledIde | null> {
    try {
      const { stdout } = await execAsync('cursor --version');
      const version = stdout.trim().split('\n')[0] || 'unknown';
      return {
        id: 'cursor',
        name: 'Cursor',
        version,
      };
    } catch {
      return null;
    }
  }
}
