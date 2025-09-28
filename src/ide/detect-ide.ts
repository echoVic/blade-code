import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export class IdeDetector {
  public static async detectIde(): Promise<IdeInfo | null> {
    try {
      // 检测VS Code
      if (await this.isVsCodeInstalled()) {
        return await this.getVsCodeInfo();
      }

      // 检测JetBrains IDEs
      if (await this.isJetBrainsInstalled()) {
        return await this.getJetBrainsInfo();
      }

      // 检测Atom
      if (await this.isAtomInstalled()) {
        return await this.getAtomInfo();
      }

      // 检测Sublime Text
      if (await this.isSublimeTextInstalled()) {
        return await this.getSublimeTextInfo();
      }

      // 检测Vim/Neovim
      if (await this.isVimInstalled()) {
        return await this.getVimInfo();
      }

      return null;
    } catch (error) {
      console.error('IDE检测失败:', error);
      return null;
    }
  }

  private static async isVsCodeInstalled(): Promise<boolean> {
    try {
      // 检查环境变量
      if (process.env.VSCODE_IPC_HOOK) {
        return true;
      }

      // 检查命令行工具
      try {
        execSync('code --version', { stdio: 'ignore' });
        return true;
      } catch {
        // 检查常见安装路径
        const paths = [
          '/usr/bin/code',
          '/usr/local/bin/code',
          'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
          'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd',
        ];

        for (const checkPath of paths) {
          try {
            await fs.access(checkPath);
            return true;
          } catch {
            continue;
          }
        }

        return false;
      }
    } catch {
      return false;
    }
  }

  private static async getVsCodeInfo(): Promise<IdeInfo> {
    try {
      const versionOutput = execSync('code --version', { encoding: 'utf-8' });
      const versions = versionOutput.trim().split('\n');

      return {
        name: 'Visual Studio Code',
        version: versions[0] || 'unknown',
        type: 'vscode',
        executable: 'code',
        extensions: await this.getVsCodeExtensions(),
      };
    } catch (error) {
      return {
        name: 'Visual Studio Code',
        version: 'unknown',
        type: 'vscode',
        executable: 'code',
        extensions: [],
      };
    }
  }

  private static async getVsCodeExtensions(): Promise<IdeExtension[]> {
    try {
      const extensionsOutput = execSync('code --list-extensions --show-versions', {
        encoding: 'utf-8',
      });
      const extensions: IdeExtension[] = [];

      const lines = extensionsOutput.trim().split('\n');
      for (const line of lines) {
        const [id, version] = line.split('@');
        if (id && version) {
          extensions.push({
            id,
            name: id.split('.')[1] || id,
            version,
            publisher: id.split('.')[0] || 'unknown',
            enabled: true,
          });
        }
      }

      return extensions;
    } catch {
      return [];
    }
  }

  private static async isJetBrainsInstalled(): Promise<boolean> {
    try {
      // 检查环境变量
      if (process.env.JETBRAINS_IDE) {
        return true;
      }

      // 检查命令行工具
      const jetbrainsTools = [
        'idea',
        'webstorm',
        'phpstorm',
        'pycharm',
        'rubymine',
        'clion',
        'rider',
        'goland',
      ];

      for (const tool of jetbrainsTools) {
        try {
          execSync(`${tool} --version`, { stdio: 'ignore' });
          return true;
        } catch {
          continue;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private static async getJetBrainsInfo(): Promise<IdeInfo> {
    // 检测具体的JetBrains IDE
    const jetbrainsTools = [
      { cmd: 'idea', name: 'IntelliJ IDEA' },
      { cmd: 'webstorm', name: 'WebStorm' },
      { cmd: 'phpstorm', name: 'PhpStorm' },
      { cmd: 'pycharm', name: 'PyCharm' },
      { cmd: 'rubymine', name: 'RubyMine' },
      { cmd: 'clion', name: 'CLion' },
      { cmd: 'rider', name: 'Rider' },
      { cmd: 'goland', name: 'GoLand' },
    ];

    for (const tool of jetbrainsTools) {
      try {
        const versionOutput = execSync(`${tool.cmd} --version`, { encoding: 'utf-8' });
        return {
          name: tool.name,
          version: versionOutput.trim(),
          type: 'jetbrains',
          executable: tool.cmd,
          extensions: [],
        };
      } catch {
        continue;
      }
    }

    return {
      name: 'JetBrains IDE',
      version: 'unknown',
      type: 'jetbrains',
      executable: 'jetbrains',
      extensions: [],
    };
  }

  private static async isAtomInstalled(): Promise<boolean> {
    try {
      execSync('atom --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private static async getAtomInfo(): Promise<IdeInfo> {
    try {
      const versionOutput = execSync('atom --version', { encoding: 'utf-8' });
      const lines = versionOutput.trim().split('\n');

      return {
        name: 'Atom',
        version: lines[0] ? lines[0].replace('Atom', '').trim() : 'unknown',
        type: 'atom',
        executable: 'atom',
        extensions: await this.getAtomPackages(),
      };
    } catch (error) {
      return {
        name: 'Atom',
        version: 'unknown',
        type: 'atom',
        executable: 'atom',
        extensions: [],
      };
    }
  }

  private static async getAtomPackages(): Promise<IdeExtension[]> {
    try {
      const packagesOutput = execSync('apm list --installed --bare', {
        encoding: 'utf-8',
      });
      const extensions: IdeExtension[] = [];

      const lines = packagesOutput.trim().split('\n');
      for (const line of lines) {
        const [name, version] = line.split('@');
        if (name && version) {
          extensions.push({
            id: name,
            name,
            version,
            publisher: 'atom',
            enabled: true,
          });
        }
      }

      return extensions;
    } catch {
      return [];
    }
  }

  private static async isSublimeTextInstalled(): Promise<boolean> {
    try {
      execSync('subl --version', { stdio: 'ignore' });
      return true;
    } catch {
      // 检查常见安装路径
      const paths = [
        '/usr/bin/subl',
        '/usr/local/bin/subl',
        'C:\\Program Files\\Sublime Text\\sublime_text.exe',
        'C:\\Program Files (x86)\\Sublime Text\\sublime_text.exe',
      ];

      for (const checkPath of paths) {
        try {
          await fs.access(checkPath);
          return true;
        } catch {
          continue;
        }
      }

      return false;
    }
  }

  private static async getSublimeTextInfo(): Promise<IdeInfo> {
    try {
      const versionOutput = execSync('subl --version', { encoding: 'utf-8' });

      return {
        name: 'Sublime Text',
        version: versionOutput.trim().replace('Sublime Text', '').trim(),
        type: 'sublime',
        executable: 'subl',
        extensions: await this.getSublimePackages(),
      };
    } catch (error) {
      return {
        name: 'Sublime Text',
        version: 'unknown',
        type: 'sublime',
        executable: 'subl',
        extensions: [],
      };
    }
  }

  private static async getSublimePackages(): Promise<IdeExtension[]> {
    try {
      // 获取Sublime Text包目录
      const packageDir = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.config/sublime-text/Packages'
      );

      const files = await fs.readdir(packageDir);
      const extensions: IdeExtension[] = [];

      for (const file of files) {
        if (file.endsWith('.sublime-package') || file.endsWith('.zip')) {
          const name = file.replace('.sublime-package', '').replace('.zip', '');
          extensions.push({
            id: name,
            name,
            version: 'unknown',
            publisher: 'sublime',
            enabled: true,
          });
        }
      }

      return extensions;
    } catch {
      return [];
    }
  }

  private static async isVimInstalled(): Promise<boolean> {
    try {
      execSync('vim --version', { stdio: 'ignore' });
      return true;
    } catch {
      try {
        execSync('nvim --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  private static async getVimInfo(): Promise<IdeInfo> {
    try {
      // 优先检测Neovim
      try {
        const nvimVersion = execSync('nvim --version', { encoding: 'utf-8' });
        const versionLine = nvimVersion.split('\n')[0];
        return {
          name: 'Neovim',
          version: versionLine.replace('NVIM', '').trim(),
          type: 'neovim',
          executable: 'nvim',
          extensions: await this.getVimPlugins(),
        };
      } catch {
        const vimVersion = execSync('vim --version', { encoding: 'utf-8' });
        const versionLine = vimVersion.split('\n')[0];
        return {
          name: 'Vim',
          version: versionLine.replace('VIM', '').trim(),
          type: 'vim',
          executable: 'vim',
          extensions: await this.getVimPlugins(),
        };
      }
    } catch (error) {
      return {
        name: 'Vim/Neovim',
        version: 'unknown',
        type: 'vim',
        executable: 'vim',
        extensions: [],
      };
    }
  }

  private static async getVimPlugins(): Promise<IdeExtension[]> {
    try {
      // 检测vim-plug插件管理器
      const plugDir = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.local/share/nvim/site/pack/packer'
      );

      try {
        const files = await fs.readdir(plugDir);
        const extensions: IdeExtension[] = [];

        for (const file of files) {
          extensions.push({
            id: file,
            name: file,
            version: 'unknown',
            publisher: 'vim',
            enabled: true,
          });
        }

        return extensions;
      } catch {
        return [];
      }
    } catch {
      return [];
    }
  }

  public static async getIdeConfig(ideType: string): Promise<IdeConfig | null> {
    switch (ideType) {
      case 'vscode':
        return await this.getVsCodeConfig();
      case 'jetbrains':
        return await this.getJetBrainsConfig();
      case 'atom':
        return await this.getAtomConfig();
      case 'sublime':
        return await this.getSublimeConfig();
      case 'vim':
      case 'neovim':
        return await this.getVimConfig();
      default:
        return null;
    }
  }

  private static async getVsCodeConfig(): Promise<IdeConfig> {
    try {
      const settingsPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.config/Code/User/settings.json'
      );

      const content = await fs.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);

      return {
        theme: settings['workbench.colorTheme'] || 'Default',
        fontSize: settings['editor.fontSize'] || 14,
        tabSize: settings['editor.tabSize'] || 2,
        autoSave: settings['files.autoSave'] || 'off',
        wordWrap: settings['editor.wordWrap'] || 'off',
      };
    } catch {
      return {
        theme: 'Default',
        fontSize: 14,
        tabSize: 2,
        autoSave: 'off',
        wordWrap: 'off',
      };
    }
  }

  private static async getJetBrainsConfig(): Promise<IdeConfig> {
    // JetBrains配置通常存储在XML文件中，这里简化处理
    return {
      theme: 'Default',
      fontSize: 12,
      tabSize: 4,
      autoSave: 'onFocusChange',
      wordWrap: 'off',
    };
  }

  private static async getAtomConfig(): Promise<IdeConfig> {
    try {
      const configPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.atom/config.cson'
      );

      const content = await fs.readFile(configPath, 'utf-8');

      return {
        theme: this.extractAtomTheme(content) || 'Atom Dark',
        fontSize: this.extractAtomFontSize(content) || 14,
        tabSize: this.extractAtomTabSize(content) || 2,
        autoSave: this.extractAtomAutoSave(content) || 'false',
        wordWrap: this.extractAtomWordWrap(content) || 'false',
      };
    } catch {
      return {
        theme: 'Atom Dark',
        fontSize: 14,
        tabSize: 2,
        autoSave: 'false',
        wordWrap: 'false',
      };
    }
  }

  private static extractAtomTheme(content: string): string | null {
    const match = content.match(/theme:\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  }

  private static extractAtomFontSize(content: string): number | null {
    const match = content.match(/fontSize:\s*(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  private static extractAtomTabSize(content: string): number | null {
    const match = content.match(/tabLength:\s*(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  private static extractAtomAutoSave(content: string): string | null {
    const match = content.match(/autosave:\s*(true|false)/);
    return match ? match[1] : null;
  }

  private static extractAtomWordWrap(content: string): string | null {
    const match = content.match(/softWrap:\s*(true|false)/);
    return match ? match[1] : null;
  }

  private static async getSublimeConfig(): Promise<IdeConfig> {
    // Sublime配置通常是JSON格式
    return {
      theme: 'Default',
      fontSize: 13,
      tabSize: 4,
      autoSave: 'false',
      wordWrap: 'false',
    };
  }

  private static async getVimConfig(): Promise<IdeConfig> {
    try {
      const vimrcPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.vimrc'
      );

      const content = await fs.readFile(vimrcPath, 'utf-8');

      return {
        theme: this.extractVimTheme(content) || 'default',
        fontSize: this.extractVimFontSize(content) || 12,
        tabSize: this.extractVimTabSize(content) || 8,
        autoSave: this.extractVimAutoSave(content) || 'false',
        wordWrap: this.extractVimWordWrap(content) || 'false',
      };
    } catch {
      return {
        theme: 'default',
        fontSize: 12,
        tabSize: 8,
        autoSave: 'false',
        wordWrap: 'false',
      };
    }
  }

  private static extractVimTheme(content: string): string | null {
    const match = content.match(/colorscheme\s+(\w+)/);
    return match ? match[1] : null;
  }

  private static extractVimFontSize(content: string): number | null {
    const match = content.match(/set\s+lines=(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  private static extractVimTabSize(content: string): number | null {
    const match = content.match(/set\s+tabstop=(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  private static extractVimAutoSave(content: string): string | null {
    return content.includes('set autowrite') ? 'true' : 'false';
  }

  private static extractVimWordWrap(content: string): string | null {
    return content.includes('set wrap') ? 'true' : 'false';
  }
}

// 类型定义
interface IdeInfo {
  name: string;
  version: string;
  type: string;
  executable: string;
  extensions: IdeExtension[];
}

interface IdeExtension {
  id: string;
  name: string;
  version: string;
  publisher: string;
  enabled: boolean;
}

interface IdeConfig {
  theme: string;
  fontSize: number;
  tabSize: number;
  autoSave: string;
  wordWrap: string;
}
