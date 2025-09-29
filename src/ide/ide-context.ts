import type { BladeConfig } from '../config/types.js';

export class IdeContext {
  private config: BladeConfig;
  private contextData: Map<string, any> = new Map();
  private ideInfo: IdeInfo | null = null;
  private projectInfo: ProjectInfo | null = null;
  private fileWatcher: FileWatcher | null = null;

  constructor(config: BladeConfig) {
    this.config = config;
  }

  public async initialize(): Promise<void> {
    // 初始化IDE信息
    await this.initializeIdeInfo();

    // 初始化项目信息
    await this.initializeProjectInfo();

    // 初始化文件监听
    await this.initializeFileWatcher();

    console.log('IDE上下文初始化完成');
  }

  private async initializeIdeInfo(): Promise<void> {
    // 获取IDE信息
    this.ideInfo = {
      name: this.getIdeName(),
      version: this.getIdeVersion(),
      platform: process.platform,
      architecture: process.arch,
      extensions: this.getInstalledExtensions(),
      theme: this.getCurrentTheme(),
      language: this.getCurrentLanguage(),
      workspaceFolders: this.getWorkspaceFolders(),
    };
  }

  private async initializeProjectInfo(): Promise<void> {
    // 获取项目信息
    this.projectInfo = {
      rootPath: process.cwd(),
      name: this.getProjectName(),
      type: this.getProjectType(),
      packageManager: this.getPackageManager(),
      dependencies: this.getProjectDependencies(),
      devDependencies: this.getDevDependencies(),
      scripts: this.getScripts(),
      languages: this.getLanguagesInProject(),
      frameworks: this.getFrameworksInProject(),
      tools: this.getToolsInProject(),
    };
  }

  private async initializeFileWatcher(): Promise<void> {
    // 初始化文件监听器
    this.fileWatcher = new FileWatcher();

    // 监听重要文件变化
    this.fileWatcher.watchFile('package.json', () => {
      this.refreshProjectInfo();
    });

    this.fileWatcher.watchFile('.gitignore', () => {
      this.refreshGitIgnore();
    });

    // 监听配置文件变化
    const configFiles = [
      'blade.config.js',
      'blade.config.json',
      '.bladerc',
      '.bladerc.json',
    ];

    for (const configFile of configFiles) {
      this.fileWatcher.watchFile(configFile, () => {
        this.refreshConfig();
      });
    }
  }

  public getIdeInfo(): IdeInfo | null {
    return this.ideInfo;
  }

  public getProjectInfo(): ProjectInfo | null {
    return this.projectInfo;
  }

  public getContextData(): any {
    return {
      ideInfo: this.ideInfo,
      projectInfo: this.projectInfo,
      timestamp: Date.now(),
      contextData: Object.fromEntries(this.contextData),
    };
  }

  public setContextData(key: string, value: any): void {
    this.contextData.set(key, value);
  }

  public getContextValue(key: string): any {
    return this.contextData.get(key);
  }

  public removeContextData(key: string): void {
    this.contextData.delete(key);
  }

  public getAllContextKeys(): string[] {
    return Array.from(this.contextData.keys());
  }

  private getIdeName(): string {
    // 这里应该检测实际的IDE
    const ideEnv = process.env.BLADE_IDE_NAME;
    if (ideEnv) return ideEnv;

    // 基于环境变量推测IDE
    if (process.env.VSCODE_IPC_HOOK) return 'Visual Studio Code';
    if (process.env.JETBRAINS_IDE) return 'JetBrains IDE';
    if (process.env.ATOM_HOME) return 'Atom';
    if (process.env.SUBLIME_PLATFORM) return 'Sublime Text';

    return 'Unknown IDE';
  }

  private getIdeVersion(): string {
    return process.env.BLADE_IDE_VERSION || 'unknown';
  }

  private getInstalledExtensions(): IdeExtension[] {
    // 这里应该获取实际安装的扩展
    // 暂时返回空数组
    return [];
  }

  private getCurrentTheme(): string {
    return process.env.BLADE_IDE_THEME || 'default';
  }

  private getCurrentLanguage(): string {
    return process.env.BLADE_IDE_LANGUAGE || 'en';
  }

  private getWorkspaceFolders(): string[] {
    const workspaceFolders = process.env.BLADE_WORKSPACE_FOLDERS;
    if (workspaceFolders) {
      return workspaceFolders.split(',');
    }
    return [process.cwd()];
  }

  private getProjectName(): string {
    try {
      const packageJson = require(`${process.cwd()}/package.json`);
      return packageJson.name || 'unnamed-project';
    } catch {
      return 'unnamed-project';
    }
  }

  private getProjectType(): string {
    try {
      const packageJson = require(`${process.cwd()}/package.json`);

      // 基于依赖推测项目类型
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (deps.react) return 'react';
      if (deps.vue) return 'vue';
      if (deps.angular) return 'angular';
      if (deps.next) return 'nextjs';
      if (deps.nuxt) return 'nuxt';
      if (deps.electron) return 'electron';
      if (deps.express) return 'express';
      if (deps.koa) return 'koa';

      return 'node';
    } catch {
      return 'node';
    }
  }

  private getPackageManager(): string {
    // 检测包管理器
    if (process.env.BLADE_PACKAGE_MANAGER) {
      return process.env.BLADE_PACKAGE_MANAGER;
    }

    // 基于存在文件推测
    try {
      require('fs').accessSync(`${process.cwd()}/pnpm-lock.yaml`);
      return 'pnpm';
    } catch {
      try {
        require('fs').accessSync(`${process.cwd()}/yarn.lock`);
        return 'yarn';
      } catch {
        return 'npm';
      }
    }
  }

  private getProjectDependencies(): Record<string, string> {
    try {
      const packageJson = require(`${process.cwd()}/package.json`);
      return packageJson.dependencies || {};
    } catch {
      return {};
    }
  }

  private getDevDependencies(): Record<string, string> {
    try {
      const packageJson = require(`${process.cwd()}/package.json`);
      return packageJson.devDependencies || {};
    } catch {
      return {};
    }
  }

  private getScripts(): Record<string, string> {
    try {
      const packageJson = require(`${process.cwd()}/package.json`);
      return packageJson.scripts || {};
    } catch {
      return {};
    }
  }

  private getLanguagesInProject(): string[] {
    const languages = new Set<string>();

    try {
      const fs = require('fs');
      const path = require('path');

      const walkDir = (dir: string) => {
        const files = fs.readdirSync(dir);

        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            // 忽略node_modules等目录
            if (!['node_modules', '.git', 'dist', 'build'].includes(file)) {
              walkDir(filePath);
            }
          } else {
            const ext = path.extname(file).toLowerCase();
            switch (ext) {
              case '.js':
              case '.jsx':
                languages.add('javascript');
                break;
              case '.ts':
              case '.tsx':
                languages.add('typescript');
                break;
              case '.py':
                languages.add('python');
                break;
              case '.java':
                languages.add('java');
                break;
              case '.cpp':
              case '.cc':
              case '.cxx':
                languages.add('cpp');
                break;
              case '.cs':
                languages.add('csharp');
                break;
              case '.go':
                languages.add('go');
                break;
              case '.rs':
                languages.add('rust');
                break;
              case '.php':
                languages.add('php');
                break;
              case '.rb':
                languages.add('ruby');
                break;
            }
          }
        }
      };

      walkDir(process.cwd());
    } catch (error) {
      console.error('检测项目语言失败:', error);
    }

    return Array.from(languages);
  }

  private getFrameworksInProject(): string[] {
    const frameworks: string[] = [];
    const deps = { ...this.getProjectDependencies(), ...this.getDevDependencies() };

    // React相关
    if (deps.react) frameworks.push('react');
    if (deps['react-dom']) frameworks.push('react-dom');
    if (deps.next) frameworks.push('nextjs');
    if (deps.gatsby) frameworks.push('gatsby');

    // Vue相关
    if (deps.vue) frameworks.push('vue');
    if (deps.nuxt) frameworks.push('nuxt');

    // Angular相关
    if (deps['@angular/core']) frameworks.push('angular');

    // 其他框架
    if (deps.express) frameworks.push('express');
    if (deps.koa) frameworks.push('koa');
    if (deps.fastify) frameworks.push('fastify');
    if (deps.electron) frameworks.push('electron');

    return frameworks;
  }

  private getToolsInProject(): string[] {
    const tools: string[] = [];
    const deps = { ...this.getProjectDependencies(), ...this.getDevDependencies() };

    // 构建工具
    if (deps.webpack) tools.push('webpack');
    if (deps.vite) tools.push('vite');
    if (deps.rollup) tools.push('rollup');
    if (deps.parcel) tools.push('parcel');

    // 测试工具
    if (deps.jest) tools.push('jest');
    if (deps.mocha) tools.push('mocha');
    if (deps.cypress) tools.push('cypress');
    if (deps.puppeteer) tools.push('puppeteer');

    // Linting工具
    if (deps.eslint) tools.push('eslint');
    if (deps.prettier) tools.push('prettier');
    if (deps.tslint) tools.push('tslint');

    // 类型检查
    if (deps.typescript) tools.push('typescript');

    return tools;
  }

  private async refreshProjectInfo(): Promise<void> {
    await this.initializeProjectInfo();
    console.log('项目信息已刷新');
  }

  private async refreshGitIgnore(): Promise<void> {
    // 刷新.gitignore相关数据
    console.log('Git忽略规则已刷新');
  }

  private async refreshConfig(): Promise<void> {
    // 刷新配置相关数据
    console.log('配置已刷新');
  }

  public async destroy(): Promise<void> {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    this.contextData.clear();
    this.ideInfo = null;
    this.projectInfo = null;
  }
}

// 文件监听器类
class FileWatcher {
  private watchers: Map<string, any> = new Map(); // 实际类型应该是fs.FSWatcher

  public watchFile(filePath: string, callback: () => void): void {
    try {
      const fs = require('fs');
      const path = require('path');
      const fullPath = path.join(process.cwd(), filePath);

      // 检查文件是否存在
      if (!fs.existsSync(fullPath)) {
        console.warn(`文件不存在，无法监听: ${filePath}`);
        return;
      }

      const watcher = fs.watch(fullPath, (eventType: string) => {
        if (eventType === 'change') {
          callback();
        }
      });

      this.watchers.set(filePath, watcher);
      console.log(`开始监听文件: ${filePath}`);
    } catch (error) {
      console.error(`监听文件失败: ${filePath}`, error);
    }
  }

  public unwatchFile(filePath: string): void {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
      console.log(`停止监听文件: ${filePath}`);
    }
  }

  public close(): void {
    for (const [filePath, watcher] of this.watchers.entries()) {
      watcher.close();
      console.log(`停止监听文件: ${filePath}`);
    }
    this.watchers.clear();
  }
}

// 类型定义
export interface IdeInfo {
  name: string;
  version: string;
  platform: string;
  architecture: string;
  extensions: IdeExtension[];
  theme: string;
  language: string;
  workspaceFolders: string[];
}

export interface IdeExtension {
  id: string;
  name: string;
  version: string;
  publisher: string;
  enabled: boolean;
}

export interface ProjectInfo {
  rootPath: string;
  name: string;
  type: string;
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  languages: string[];
  frameworks: string[];
  tools: string[];
}
