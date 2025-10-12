import { execSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export class IdeInstaller {
  private static readonly IDES: Record<string, IdeInstallationInfo> = {
    vscode: {
      name: 'Visual Studio Code',
      downloadUrl: {
        win32:
          'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user',
        darwin:
          'https://code.visualstudio.com/sha/download?build=stable&os=darwin-universal',
        linux: 'https://code.visualstudio.com/sha/download?build=stable&os=linux-x64',
      },
      installerType: 'auto',
      executable: 'code',
      postInstallCommands: [
        'code --install-extension ms-vscode.vscode-typescript-next',
      ],
    },
    webstorm: {
      name: 'WebStorm',
      downloadUrl: {
        win32: 'https://download.jetbrains.com/webstorm/WebStorm-*.exe',
        darwin: 'https://download.jetbrains.com/webstorm/WebStorm-*.dmg',
        linux: 'https://download.jetbrains.com/webstorm/WebStorm-*.tar.gz',
      },
      installerType: 'manual',
      executable: 'webstorm',
      postInstallCommands: [],
    },
    cursor: {
      name: 'Cursor',
      downloadUrl: {
        win32: 'https://www.cursor.so/download/win',
        darwin: 'https://www.cursor.so/download/mac',
        linux: 'https://www.cursor.so/download/linux',
      },
      installerType: 'auto',
      executable: 'cursor',
      postInstallCommands: [],
    },
  };

  public static async installIde(
    ideName: string,
    options: InstallOptions = {}
  ): Promise<InstallResult> {
    const ideInfo = this.IDES[ideName.toLowerCase()];

    if (!ideInfo) {
      throw new Error(`不支持的IDE: ${ideName}`);
    }

    console.log(`开始安装 ${ideInfo.name}...`);

    try {
      switch (ideInfo.installerType) {
        case 'auto':
          return await this.autoInstall(ideInfo, options);
        case 'manual':
          return await this.manualInstall(ideInfo, options);
        default:
          throw new Error(`不支持的安装类型: ${ideInfo.installerType}`);
      }
    } catch (error) {
      console.error(`安装 ${ideInfo.name} 失败:`, error);
      throw error;
    }
  }

  private static async autoInstall(
    ideInfo: IdeInstallationInfo,
    options: InstallOptions
  ): Promise<InstallResult> {
    const platform = os.platform();
    const downloadUrl = ideInfo.downloadUrl[platform];

    if (!downloadUrl) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), 'blade-ide-install');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // 下载安装包
      console.log('正在下载安装包...');
      const installerPath = await this.downloadInstaller(
        downloadUrl,
        tempDir,
        ideInfo.name
      );

      // 安装
      console.log('正在安装...');
      await this.runInstaller(installerPath, options);

      // 安装后配置
      console.log('正在进行安装后配置...');
      await this.postInstall(ideInfo);

      // 清理临时文件
      await fs.rm(tempDir, { recursive: true, force: true });

      const executablePath = await this.findExecutable(ideInfo.executable);
      return {
        success: true,
        ide: ideInfo.name,
        message: `${ideInfo.name} 安装成功`,
        executablePath: executablePath || undefined,
      };
    } catch (error) {
      // 清理临时文件
      await fs.rm(tempDir, { recursive: true, force: true });

      throw error;
    }
  }

  private static async manualInstall(
    ideInfo: IdeInstallationInfo,
    options: InstallOptions
  ): Promise<InstallResult> {
    const platform = os.platform();
    const downloadUrl = ideInfo.downloadUrl[platform];

    if (!downloadUrl) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    console.log(`请手动下载并安装 ${ideInfo.name}:`);
    console.log(`下载地址: ${downloadUrl}`);
    console.log('安装完成后按回车键继续...');

    // 等待用户确认
    if (!options.silent) {
      await this.waitForUserInput();
    }

    // 验证安装
    const executablePath = await this.findExecutable(ideInfo.executable);
    if (!executablePath) {
      throw new Error(`${ideInfo.name} 安装验证失败，请确保已正确安装`);
    }

    // 安装后配置
    await this.postInstall(ideInfo);

    return {
      success: true,
      ide: ideInfo.name,
      message: `${ideInfo.name} 安装验证成功`,
      executablePath,
    };
  }

  private static async downloadInstaller(
    url: string,
    tempDir: string,
    ideName: string
  ): Promise<string> {
    const fileName = this.getFileNameFromUrl(url, ideName);
    const filePath = path.join(tempDir, fileName);

    // 使用curl下载（跨平台）
    try {
      execSync(`curl -L "${url}" -o "${filePath}"`, { stdio: 'inherit' });
      return filePath;
    } catch (error) {
      // 尝试使用wget
      try {
        execSync(`wget "${url}" -O "${filePath}"`, { stdio: 'inherit' });
        return filePath;
      } catch (wgetError) {
        throw new Error(`下载失败: ${error} ${wgetError}`);
      }
    }
  }

  private static getFileNameFromUrl(url: string, ideName: string): string {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const fileName = pathname.split('/').pop();

    if (fileName && fileName !== '') {
      return fileName;
    }

    // 基于平台和IDE名称生成文件名
    const platform = os.platform();
    switch (platform) {
      case 'win32':
        return `${ideName}.exe`;
      case 'darwin':
        return `${ideName}.dmg`;
      default:
        return `${ideName}.tar.gz`;
    }
  }

  private static async runInstaller(
    installerPath: string,
    options: InstallOptions
  ): Promise<void> {
    const platform = os.platform();

    switch (platform) {
      case 'win32':
        await this.runWindowsInstaller(installerPath, options);
        break;
      case 'darwin':
        await this.runMacInstaller(installerPath, options);
        break;
      case 'linux':
        await this.runLinuxInstaller(installerPath, options);
        break;
      default:
        throw new Error(`不支持的平台: ${platform}`);
    }
  }

  private static async runWindowsInstaller(
    installerPath: string,
    options: InstallOptions
  ): Promise<void> {
    // Windows安装命令
    const installCmd = `${installerPath} /S`; // 静默安装
    execSync(installCmd, { stdio: 'inherit' });
  }

  private static async runMacInstaller(
    installerPath: string,
    options: InstallOptions
  ): Promise<void> {
    if (installerPath.endsWith('.dmg')) {
      // 挂载DMG
      execSync(`hdiutil attach "${installerPath}"`, { stdio: 'inherit' });

      // 复制应用到Applications
      const appName = path.basename(installerPath, '.dmg');
      execSync(`cp -R "/Volumes/${appName}/${appName}.app" /Applications/`, {
        stdio: 'inherit',
      });

      // 卸载DMG
      execSync(`hdiutil detach "/Volumes/${appName}"`, { stdio: 'inherit' });
    } else {
      throw new Error('不支持的Mac安装包格式');
    }
  }

  private static async runLinuxInstaller(
    installerPath: string,
    options: InstallOptions
  ): Promise<void> {
    if (installerPath.endsWith('.tar.gz')) {
      // 解压到/usr/local
      execSync(`sudo tar -xzf "${installerPath}" -C /usr/local/`, { stdio: 'inherit' });
    } else {
      // 尝试直接执行
      execSync(`chmod +x "${installerPath}" && "${installerPath}"`, {
        stdio: 'inherit',
      });
    }
  }

  private static async postInstall(ideInfo: IdeInstallationInfo): Promise<void> {
    // 运行安装后命令
    for (const command of ideInfo.postInstallCommands) {
      try {
        console.log(`执行: ${command}`);
        execSync(command, { stdio: 'inherit' });
      } catch (error) {
        console.warn(`安装后命令执行失败: ${command}`, error);
      }
    }
  }

  private static async findExecutable(executableName: string): Promise<string | null> {
    const platform = os.platform();

    // 常见安装路径
    const paths = this.getCommonPaths(executableName, platform);

    for (const checkPath of paths) {
      try {
        await fs.access(checkPath);
        return checkPath;
      } catch {
        continue;
      }
    }

    // 尝试在PATH中查找
    try {
      const whichResult = execSync(`which ${executableName}`, {
        encoding: 'utf-8',
      }).trim();
      if (whichResult) {
        return whichResult;
      }
    } catch {
      // which命令失败，继续
    }

    return null;
  }

  private static getCommonPaths(executableName: string, platform: string): string[] {
    switch (platform) {
      case 'win32':
        return [
          `C:\\Program Files\\${executableName}\\${executableName}.exe`,
          `C:\\Program Files (x86)\\${executableName}\\${executableName}.exe`,
          `${process.env.LOCALAPPDATA}\\Programs\\${executableName}\\${executableName}.exe`,
        ];
      case 'darwin':
        return [
          `/Applications/${executableName}.app/Contents/MacOS/${executableName}`,
          `/usr/local/bin/${executableName}`,
          `${process.env.HOME}/Applications/${executableName}.app/Contents/MacOS/${executableName}`,
        ];
      default: // Linux
        return [
          `/usr/bin/${executableName}`,
          `/usr/local/bin/${executableName}`,
          `${process.env.HOME}/.local/bin/${executableName}`,
        ];
    }
  }

  private static async waitForUserInput(): Promise<void> {
    return new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.on('data', () => {
        process.stdin.pause();
        resolve();
      });
    });
  }

  public static async isIdeInstalled(ideName: string): Promise<boolean> {
    const ideInfo = this.IDES[ideName.toLowerCase()];
    if (!ideInfo) {
      return false;
    }

    try {
      const executablePath = await this.findExecutable(ideInfo.executable);
      return !!executablePath;
    } catch {
      return false;
    }
  }

  public static async getInstalledIdes(): Promise<InstalledIde[]> {
    const installedIdes: InstalledIde[] = [];

    for (const [key, ideInfo] of Object.entries(this.IDES)) {
      try {
        const isInstalled = await this.isIdeInstalled(key);
        if (isInstalled) {
          const executablePath = await this.findExecutable(ideInfo.executable);
          installedIdes.push({
            name: ideInfo.name,
            key,
            executablePath: executablePath || '',
            version: await this.getIdeVersion(ideInfo.executable),
          });
        }
      } catch {
        // 忽略单个IDE检查失败
        continue;
      }
    }

    return installedIdes;
  }

  private static async getIdeVersion(executableName: string): Promise<string> {
    try {
      const versionOutput = execSync(`${executableName} --version`, {
        encoding: 'utf-8',
      });
      return versionOutput.trim().split('\n')[0];
    } catch {
      return 'unknown';
    }
  }

  public static async launchIde(ideName: string, filePath?: string): Promise<void> {
    const ideInfo = this.IDES[ideName.toLowerCase()];
    if (!ideInfo) {
      throw new Error(`不支持的IDE: ${ideName}`);
    }

    const executablePath = await this.findExecutable(ideInfo.executable);
    if (!executablePath) {
      throw new Error(`${ideInfo.name} 未安装`);
    }

    // 启动IDE
    const command = filePath ? `${executablePath} "${filePath}"` : executablePath;

    try {
      spawn(command, { shell: true, detached: true, stdio: 'ignore' });
      console.log(`${ideInfo.name} 启动成功`);
    } catch (error) {
      throw new Error(`启动 ${ideInfo.name} 失败: ${error}`);
    }
  }

  public static async uninstallIde(ideName: string): Promise<UninstallResult> {
    const ideInfo = this.IDES[ideName.toLowerCase()];
    if (!ideInfo) {
      throw new Error(`不支持的IDE: ${ideName}`);
    }

    console.log(`开始卸载 ${ideInfo.name}...`);

    try {
      const platform = os.platform();

      switch (platform) {
        case 'win32':
          await this.uninstallWindows(ideInfo);
          break;
        case 'darwin':
          await this.uninstallMac(ideInfo);
          break;
        case 'linux':
          await this.uninstallLinux(ideInfo);
          break;
        default:
          throw new Error(`不支持的平台: ${platform}`);
      }

      return {
        success: true,
        ide: ideInfo.name,
        message: `${ideInfo.name} 卸载成功`,
      };
    } catch (error) {
      throw new Error(`卸载 ${ideInfo.name} 失败: ${error}`);
    }
  }

  private static async uninstallWindows(ideInfo: IdeInstallationInfo): Promise<void> {
    // Windows卸载通常通过控制面板或卸载程序
    console.log(`请通过控制面板手动卸载 ${ideInfo.name}`);
  }

  private static async uninstallMac(ideInfo: IdeInstallationInfo): Promise<void> {
    // 删除应用程序
    const appPath = `/Applications/${ideInfo.name}.app`;
    try {
      await fs.rm(appPath, { recursive: true, force: true });
    } catch {
      console.log(`请手动删除 ${appPath}`);
    }
  }

  private static async uninstallLinux(ideInfo: IdeInstallationInfo): Promise<void> {
    // Linux卸载取决于安装方式
    console.log(`请根据安装方式手动卸载 ${ideInfo.name}`);
  }
}

// 类型定义
export interface IdeInstallationInfo {
  name: string;
  downloadUrl: Record<string, string>;
  installerType: 'auto' | 'manual';
  executable: string;
  postInstallCommands: string[];
}

export interface InstallOptions {
  silent?: boolean;
  installPath?: string;
  force?: boolean;
}

export interface InstallResult {
  success: boolean;
  ide: string;
  message: string;
  executablePath?: string;
}

export interface InstalledIde {
  name: string;
  key: string;
  executablePath: string;
  version: string;
}

export interface UninstallResult {
  success: boolean;
  ide: string;
  message: string;
}
