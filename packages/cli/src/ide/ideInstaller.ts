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
