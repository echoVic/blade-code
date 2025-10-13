# Blade 配置系统完整设计方案

## 一、设计概览

### 核心原则

- **双文件系统** - config.json (基础配置) + settings.json (行为配置)
- **扁平化配置** - config.json 采用扁平结构,避免过度嵌套
- **统一对象** - 运行时合并为单一 BladeConfig 对象
- **无 CLI 命令** - 仅通过文件编辑和 REPL /config 命令
- **参考 Claude Code** - 配置结构和使用方式保持一致

### 配置层级优先级

**config.json (2层):**
环境变量 > 命令行参数 > 项目配置 > 用户配置 > 默认配置

**settings.json (3层):**
命令行参数 > 项目本地配置 > 项目共享配置 > 用户配置 > 默认配置
## 二、文件结构

### 目录布局

**项目根目录:**
```
项目根目录/
├── .blade/
│   ├── config.json              # 项目基础配置
│   ├── settings.json            # 项目行为配置 (提交到 git)
│   ├── settings.local.json      # 本地配置 (不提交,自动忽略)
│   ├── BLADE.md                 # 项目上下文说明
│   ├── commands/                # 自定义斜杠命令
│   └── agents/                  # 子代理定义
│
├── .gitignore                   # 自动添加 .blade/settings.local.json
```

**用户主目录:**
```
用户主目录/
└── ~/.blade/
    ├── config.json              # 用户基础配置
    ├── settings.json            # 用户行为配置
    ├── BLADE.md                 # 全局上下文说明
    ├── commands/                # 全局自定义命令
    └── agents/                  # 全局子代理
```

### Git 配置

```gitignore
# .gitignore (自动添加)
.blade/settings.local.json
```
## 三、类型定义

### 1. BladeConfig (统一配置接口)

```typescript
// src/config/types.ts

/**
 * Blade 统一配置接口
 * 合并了 config.json 和 settings.json 的所有配置项
 */
export interface BladeConfig {
  // =====================================
  // 基础配置 (来自 config.json)
  // =====================================
  
  // 认证
  apiKey: string;
  apiSecret?: string;
  baseURL: string;
  
  // 模型
  model: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
  topP: number;
  topK: number;
  
  // UI
  theme: string;
  language: string;
  fontSize: number;
  showStatusBar: boolean;
  
  // 核心
  debug: boolean;
  telemetry: boolean;
  autoUpdate: boolean;
  workingDirectory: string;
  
  // 日志
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';
  
  // MCP
  mcpEnabled: boolean;
  
  // =====================================
  // 行为配置 (来自 settings.json)
  // =====================================
  
  // 权限
  permissions: PermissionConfig;
  
  // Hooks
  hooks: HookConfig;
  
  // 环境变量
  env: Record<string, string>;
  
  // 其他
  disableAllHooks: boolean;
  cleanupPeriodDays: number;
  includeCoAuthoredBy: boolean;
  apiKeyHelper?: string;
}

/**
 * 权限配置
 */
export interface PermissionConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * Hooks 配置
 */
export interface HookConfig {
  PreToolUse?: Record<string, string>;
  PostToolUse?: Record<string, string>;
}
```

### 2. 默认配置

```typescript
// src/config/defaults.ts

export const DEFAULT_CONFIG: BladeConfig = {
  // 基础配置 (config.json)
  apiKey: '',
  baseURL: 'https://apis.iflow.cn/v1',
  model: 'qwen3-coder-plus',
  temperature: 0.0,
  maxTokens: 32000,
  stream: true,
  topP: 0.9,
  topK: 50,
  theme: 'GitHub',
  language: 'zh-CN',
  fontSize: 14,
  showStatusBar: true,
  debug: false,
  telemetry: true,
  autoUpdate: true,
  workingDirectory: process.cwd(),
  logLevel: 'info',
  logFormat: 'text',
  mcpEnabled: false,
  
  // 行为配置 (settings.json)
  permissions: {
    allow: [],
    ask: [],
    deny: [
      'Read(./.env)',
      'Read(./.env.*)',
    ],
  },
  hooks: {},
  env: {},
  disableAllHooks: false,
  cleanupPeriodDays: 30,
  includeCoAuthoredBy: true,
};
```

## 四、配置文件示例

### 1. config.json 示例

**~/.blade/config.json (用户级):**
```json
{
  "apiKey": "$BLADE_API_KEY",
  "baseURL": "https://apis.iflow.cn/v1",
  "model": "qwen3-coder-plus",
  "temperature": 0.0,
  "maxTokens": 32000,
  "stream": true,
  "topP": 0.9,
  "topK": 50,
  "theme": "GitHub",
  "language": "zh-CN",
  "fontSize": 14,
  "showStatusBar": true,
  "debug": false,
  "telemetry": true,
  "autoUpdate": true,
  "logLevel": "info",
  "logFormat": "text",
  "mcpEnabled": false
}
```

**.blade/config.json (项目级):**
```json
{
  "model": "qwen-max",
  "temperature": 0.2,
  "theme": "dark",
  "debug": true,
  "mcpEnabled": true,
  "workingDirectory": "."
}
```

### 2. settings.json 示例

**~/.blade/settings.json (用户级):**
```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff)",
      "Bash(npm run lint)",
      "Read(~/.zshrc)"
    ],
    "ask": [
      "Bash(git push:*)",
      "WebFetch(*)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Bash(rm -rf:*)",
      "Bash(curl:*)"
    ]
  },
  "cleanupPeriodDays": 30,
  "includeCoAuthoredBy": true
}
```

**.blade/settings.json (项目共享,提交到 git):**
```json
{
  "permissions": {
    "allow": [
      "Bash(npm run:*)",
      "Bash(npx:*)",
      "Bash(pnpm:*)"
    ],
    "deny": [
      "Read(./.env.production)",
      "Write(./dist/**)",
      "Write(./build/**)"
    ]
  },
  "hooks": {
    "PostToolUse": {
      "Write": "npx prettier --write {file_path}",
      "Edit": "npx prettier --write {file_path}"
    }
  },
  "env": {
    "NODE_ENV": "development",
    "NPM_CONFIG_LOGLEVEL": "warn"
  }
}
```

**.blade/settings.local.json (本地,不提交):**
```json
{
  "permissions": {
    "allow": [
      "Bash(rm:*)"
    ]
  },
  "env": {
    "BLADE_DEBUG": "1"
  },
  "disableAllHooks": false
}
```

## 五、核心实现

### 1. ConfigManager

```typescript
// src/config/ConfigManager.ts

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_CONFIG } from './defaults.js';
import { BladeConfig, PermissionConfig, HookConfig } from './types.js';

export class ConfigManager {
  private config: BladeConfig | null = null;
  private configLoaded = false;
  
  /**
   * 初始化配置系统
   */
  async initialize(): Promise<BladeConfig> {
    if (this.configLoaded && this.config) {
      return this.config;
    }
    
    try {
      // 1. 加载基础配置 (config.json)
      const baseConfig = await this.loadConfigFiles();
      
      // 2. 加载行为配置 (settings.json)
      const settingsConfig = await this.loadSettingsFiles();
      
      // 3. 合并为统一配置
      this.config = {
        ...DEFAULT_CONFIG,
        ...baseConfig,
        ...settingsConfig,
      };
      
      // 4. 解析环境变量插值
      this.resolveEnvInterpolation(this.config);
      
      // 5. 确保 Git 忽略 settings.local.json
      await this.ensureGitIgnore();
      
      this.configLoaded = true;
      
      if (this.config.debug) {
        console.log('[ConfigManager] Configuration loaded successfully');
      }
      
      return this.config;
    } catch (error) {
      console.error('[ConfigManager] Failed to initialize:', error);
      this.config = DEFAULT_CONFIG;
      this.configLoaded = true;
      return this.config;
    }
  }
  
  /**
   * 加载 config.json 文件 (2层优先级)
   */
  private async loadConfigFiles(): Promise<Partial<BladeConfig>> {
    const userConfigPath = path.join(os.homedir(), '.blade', 'config.json');
    const projectConfigPath = path.join(process.cwd(), '.blade', 'config.json');
    
    let config: Partial<BladeConfig> = {};
    
    // 1. 用户配置
    const userConfig = await this.loadJsonFile(userConfigPath);
    if (userConfig) {
      config = { ...config, ...userConfig };
    }
    
    // 2. 项目配置
    const projectConfig = await this.loadJsonFile(projectConfigPath);
    if (projectConfig) {
      config = { ...config, ...projectConfig };
    }
    
    // 3. 应用环境变量
    config = this.applyEnvToConfig(config);
    
    return config;
  }
  
  /**
   * 加载 settings.json 文件 (3层优先级)
   */
  private async loadSettingsFiles(): Promise<Partial<BladeConfig>> {
    const userSettingsPath = path.join(os.homedir(), '.blade', 'settings.json');
    const projectSettingsPath = path.join(process.cwd(), '.blade', 'settings.json');
    const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');
    
    let settings: Partial<BladeConfig> = {};
    
    // 1. 用户配置
    const userSettings = await this.loadJsonFile(userSettingsPath);
    if (userSettings) {
      settings = this.mergeSettings(settings, userSettings);
    }
    
    // 2. 项目共享配置
    const projectSettings = await this.loadJsonFile(projectSettingsPath);
    if (projectSettings) {
      settings = this.mergeSettings(settings, projectSettings);
    }
    
    // 3. 项目本地配置
    const localSettings = await this.loadJsonFile(localSettingsPath);
    if (localSettings) {
      settings = this.mergeSettings(settings, localSettings);
    }
    
    return settings;
  }
  
  /**
   * 应用环境变量到 config
   */
  private applyEnvToConfig(config: Partial<BladeConfig>): Partial<BladeConfig> {
    const result = { ...config };
    
    // 认证
    if (process.env.BLADE_API_KEY) result.apiKey = process.env.BLADE_API_KEY;
    if (process.env.BLADE_API_SECRET) result.apiSecret = process.env.BLADE_API_SECRET;
    if (process.env.BLADE_BASE_URL) result.baseURL = process.env.BLADE_BASE_URL;
    
    // 模型
    if (process.env.BLADE_MODEL) result.model = process.env.BLADE_MODEL;
    if (process.env.BLADE_TEMPERATURE) result.temperature = parseFloat(process.env.BLADE_TEMPERATURE);
    if (process.env.BLADE_MAX_TOKENS) result.maxTokens = parseInt(process.env.BLADE_MAX_TOKENS);
    
    // UI
    if (process.env.BLADE_THEME) result.theme = process.env.BLADE_THEME;
    if (process.env.BLADE_LANGUAGE) result.language = process.env.BLADE_LANGUAGE;
    
    // 核心
    if (process.env.BLADE_DEBUG) {
      result.debug = process.env.BLADE_DEBUG === '1' || process.env.BLADE_DEBUG === 'true';
    }
    if (process.env.BLADE_TELEMETRY) {
      result.telemetry = process.env.BLADE_TELEMETRY === '1' || process.env.BLADE_TELEMETRY === 'true';
    }
    
    return result;
  }
  
  /**
   * 合并 settings 配置 (数组追加,对象覆盖)
   */
  private mergeSettings(
    base: Partial<BladeConfig>,
    override: Partial<BladeConfig>
  ): Partial<BladeConfig> {
    const result = JSON.parse(JSON.stringify(base));
    
    // 合并 permissions (数组追加去重)
    if (override.permissions) {
      result.permissions = result.permissions || { allow: [], ask: [], deny: [] };
      
      if (override.permissions.allow) {
        const combined = [...(result.permissions.allow || []), ...override.permissions.allow];
        result.permissions.allow = Array.from(new Set(combined));
      }
      if (override.permissions.ask) {
        const combined = [...(result.permissions.ask || []), ...override.permissions.ask];
        result.permissions.ask = Array.from(new Set(combined));
      }
      if (override.permissions.deny) {
        const combined = [...(result.permissions.deny || []), ...override.permissions.deny];
        result.permissions.deny = Array.from(new Set(combined));
      }
    }
    
    // 合并 hooks (对象覆盖)
    if (override.hooks) {
      result.hooks = { ...result.hooks, ...override.hooks };
    }
    
    // 合并 env (对象覆盖)
    if (override.env) {
      result.env = { ...result.env, ...override.env };
    }
    
    // 其他字段直接覆盖
    if (override.disableAllHooks !== undefined) {
      result.disableAllHooks = override.disableAllHooks;
    }
    if (override.cleanupPeriodDays !== undefined) {
      result.cleanupPeriodDays = override.cleanupPeriodDays;
    }
    if (override.includeCoAuthoredBy !== undefined) {
      result.includeCoAuthoredBy = override.includeCoAuthoredBy;
    }
    if (override.apiKeyHelper !== undefined) {
      result.apiKeyHelper = override.apiKeyHelper;
    }
    
    return result;
  }
  
  /**
   * 解析配置中的环境变量插值
   * 支持 $VAR 和 ${VAR} 以及 ${VAR:-default}
   */
  private resolveEnvInterpolation(config: BladeConfig): void {
    const envPattern = /\$\{?([A-Z_][A-Z0-9_]*)(:-([^}]+))?\}?/g;
    
    const resolve = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(envPattern, (match, varName, _, defaultValue) => {
          return process.env[varName] || defaultValue || match;
        });
      }
      return value;
    };
    
    // 只解析字符串字段
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        (config as any)[key] = resolve(value);
      }
    }
  }
  
  /**
   * 确保 .gitignore 包含 settings.local.json
   */
  private async ensureGitIgnore(): Promise<void> {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const pattern = '.blade/settings.local.json';
    
    try {
      let content = '';
      
      if (await this.fileExists(gitignorePath)) {
        content = await fs.readFile(gitignorePath, 'utf-8');
      }
      
      if (!content.includes(pattern)) {
        const newContent = content.trim() + '\n\n# Blade local settings\n' + pattern + '\n';
        await fs.writeFile(gitignorePath, newContent, 'utf-8');
        
        if (this.config?.debug) {
          console.log('[ConfigManager] Added .blade/settings.local.json to .gitignore');
        }
      }
    } catch (error) {
      // 忽略错误,不影响主流程
    }
  }
  
  /**
   * 加载 JSON 文件
   */
  private async loadJsonFile(filePath: string): Promise<any> {
    try {
      if (await this.fileExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn(`[ConfigManager] Failed to load ${filePath}:`, error);
    }
    return null;
  }
  
  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * 获取配置
   */
  getConfig(): BladeConfig {
    if (!this.config) {
      throw new Error('Config not initialized. Call initialize() first.');
    }
    return this.config;
  }
  
  /**
   * 更新配置
   */
  async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
    if (!this.config) {
      throw new Error('Config not initialized');
    }
    
    this.config = {
      ...this.config,
      ...updates,
    };
    
    // 可选:保存到文件
    // await this.saveConfig();
  }
}
```

### 2. PermissionChecker (权限检查器)

```typescript
// src/config/PermissionChecker.ts

import { PermissionConfig } from './types.js';

export class PermissionChecker {
  constructor(private permissions: PermissionConfig) {}
  
  /**
   * 检查工具调用权限
   * @returns 'allow' | 'ask' | 'deny'
   */
  checkPermission(tool: string, args: Record<string, any>): 'allow' | 'ask' | 'deny' {
    const rule = this.formatRule(tool, args);
    
    // 1. 检查 deny 规则 (最高优先级)
    if (this.matchesAny(rule, this.permissions.deny)) {
      return 'deny';
    }
    
    // 2. 检查 allow 规则
    if (this.matchesAny(rule, this.permissions.allow)) {
      return 'allow';
    }
    
    // 3. 检查 ask 规则
    if (this.matchesAny(rule, this.permissions.ask)) {
      return 'ask';
    }
    
    // 4. 默认 ask
    return 'ask';
  }
  
  /**
   * 格式化工具调用为规则字符串
   * 例如: Bash(npm run test) 或 Read(./.env)
   */
  private formatRule(tool: string, args: Record<string, any>): string {
    const mainArg = args.command || args.file_path || args.pattern || '';
    return `${tool}(${mainArg})`;
  }
  
  /**
   * 检查是否匹配任意规则
   */
  private matchesAny(rule: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchPattern(rule, pattern));
  }
  
  /**
   * 匹配单个规则
   */
  private matchPattern(rule: string, pattern: string): boolean {
    // 1. 精确匹配
    if (rule === pattern) {
      return true;
    }
    
    // 2. Bash 前缀匹配: Bash(git push:*) 匹配 Bash(git push origin main)
    if (pattern.includes(':*')) {
      const prefix = pattern.replace(':*', '');
      return rule.startsWith(prefix);
    }
    
    // 3. 工具通配符: WebFetch(*) 匹配所有 WebFetch 调用
    if (pattern.endsWith('(*)')) {
      const toolName = pattern.slice(0, -3);
      return rule.startsWith(toolName + '(');
    }
    
    // 4. Glob 模式匹配 (文件路径)
    if (pattern.includes('*') || pattern.includes('**')) {
      return this.globMatch(rule, pattern);
    }
    
    return false;
  }
  
  /**
   * Glob 模式匹配
   */
  private globMatch(str: string, pattern: string): boolean {
    // 简单的 glob 匹配实现
    // 支持 * 和 **
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(str);
  }
}
```

### 3. HookExecutor (Hooks 执行器)

```typescript
// src/config/HookExecutor.ts

import { exec } from 'child_process';
import { promisify } from 'util';
import { HookConfig } from './types.js';

const execAsync = promisify(exec);

export class HookExecutor {
  constructor(
    private hooks: HookConfig,
    private disableAllHooks: boolean = false
  ) {}
  
  /**
   * 执行 Hook
   */
  async executeHook(
    hookType: 'PreToolUse' | 'PostToolUse',
    tool: string,
    context: Record<string, any>
  ): Promise<void> {
    // 如果禁用所有 hooks,直接返回
    if (this.disableAllHooks) {
      return;
    }
    
    const hooks = this.hooks[hookType];
    if (!hooks) {
      return;
    }
    
    const command = hooks[tool];
    if (!command) {
      return;
    }
    
    // 替换变量
    const resolvedCommand = this.resolveVariables(command, context);
    
    try {
      await execAsync(resolvedCommand, {
        cwd: process.cwd(),
        timeout: 30000, // 30秒超时
      });
    } catch (error) {
      console.warn(`[Hook] Failed to execute ${hookType} hook for ${tool}:`, error);
      // Hook 失败不应中断主流程
    }
  }
  
  /**
   * 解析命令中的变量
   * 支持: {file_path}, {command}, {pattern} 等
   */
  private resolveVariables(command: string, context: Record<string, any>): string {
    return command.replace(/\{(\w+)\}/g, (match, key) => {
      return context[key] || match;
    });
  }
}
```

## 六、使用方式

### 1. 初始化配置

```typescript
// src/index.ts

import { ConfigManager } from './config/ConfigManager.js';

async function main() {
  // 初始化配置管理器
  const configManager = new ConfigManager();
  await configManager.initialize();
  
  // 获取统一配置
  const config = configManager.getConfig();
  
  console.log('API Key:', config.apiKey);
  console.log('Model:', config.model);
  console.log('Theme:', config.theme);
  console.log('Permissions:', config.permissions);
}
```

### 2. 在 Agent 中使用

```typescript
// src/agent/Agent.ts

import { BladeConfig } from '../config/types.js';
import { PermissionChecker } from '../config/PermissionChecker.js';
import { HookExecutor } from '../config/HookExecutor.js';

export class Agent {
  private permissionChecker: PermissionChecker;
  private hookExecutor: HookExecutor;
  
  constructor(private config: BladeConfig) {
    this.permissionChecker = new PermissionChecker(config.permissions);
    this.hookExecutor = new HookExecutor(config.hooks, config.disableAllHooks);
  }
  
  async executeTool(tool: string, args: Record<string, any>): Promise<any> {
    // 1. 检查权限
    const permission = this.permissionChecker.checkPermission(tool, args);
    
    if (permission === 'deny') {
      throw new Error(`Permission denied for ${tool}`);
    }
    
    if (permission === 'ask') {
      // 询问用户
      const allowed = await this.askUser(`Allow ${tool}?`);
      if (!allowed) {
        throw new Error(`User denied ${tool}`);
      }
    }
    
    // 2. 执行 PreToolUse Hook
    await this.hookExecutor.executeHook('PreToolUse', tool, args);
    
    // 3. 执行工具
    const result = await this.toolRegistry.execute(tool, args);
    
    // 4. 执行 PostToolUse Hook
    await this.hookExecutor.executeHook('PostToolUse', tool, {
      ...args,
      result,
    });
    
    return result;
  }
}
```

### 3. 环境变量使用

```bash
# 设置环境变量
export BLADE_API_KEY="sk-xxx"
export BLADE_BASE_URL="https://api.example.com"
export BLADE_MODEL="qwen-max"
export BLADE_THEME="dark"
export BLADE_DEBUG="1"

# 在配置文件中引用
# config.json
{
  "apiKey": "$BLADE_API_KEY",
  "baseURL": "${BLADE_BASE_URL:-https://apis.iflow.cn/v1}",
  "modelName": "$BLADE_MODEL"
}
```

## 七、环境变量映射表

| 环境变量 | 配置字段 | 说明 |
|---------|---------|------|
| BLADE_API_KEY | apiKey | API 密钥 |
| BLADE_API_SECRET | apiSecret | API 密钥 |
| BLADE_BASE_URL | baseURL | API 基础 URL |
| BLADE_MODEL | modelName | 模型名称 |
| BLADE_TEMPERATURE | temperature | 温度参数 |
| BLADE_MAX_TOKENS | maxTokens | 最大 token 数 |
| BLADE_THEME | theme | UI 主题 |
| BLADE_LANGUAGE | language | 界面语言 |
| BLADE_DEBUG | debug | 调试模式 |
| BLADE_TELEMETRY | telemetry | 遥测开关 |
## 八、实施计划

### Sprint 1: 配置基础架构 (Week 1)

**目标:** 实现双配置文件系统和统一配置对象

**任务:**
- [ ] 定义 BladeConfig 类型 (src/config/types.ts)
- [ ] 实现默认配置 (src/config/defaults.ts)
- [ ] 实现 ConfigManager 配置加载逻辑 (src/config/ConfigManager.ts)
- [ ] 实现环境变量插值功能
- [ ] 实现 Git 自动忽略配置
- [ ] 编写配置加载测试

**交付物:**
- ✅ 支持 config.json (2层) + settings.json (3层)
- ✅ 统一的 BladeConfig 对象
- ✅ 环境变量支持 $VAR 和 ${VAR:-default} 语法
- ✅ 自动忽略 .blade/settings.local.json
### Sprint 2: 权限系统 (Week 2)

**目标:** 实现完整的权限检查机制

**任务:**
- [ ] 实现 PermissionChecker (src/config/PermissionChecker.ts)
- [ ] 实现权限规则匹配算法 (精确/前缀/通配符/glob)
- [ ] 集成到工具执行流程
- [ ] 编写权限测试用例
- [ ] 添加权限配置文档

**交付物:**
- ✅ allow/ask/deny 三级权限控制
- ✅ 支持多种匹配模式
- ✅ 工具执行前自动权限检查

### Sprint 3: Hooks 系统 (Week 3)

**目标:** 实现工具执行前后的自动化

**任务:**
- [ ] 实现 HookExecutor (src/config/HookExecutor.ts)
- [ ] 实现变量替换功能 ({file_path}, {command} 等)
- [ ] 集成到工具执行流程
- [ ] 编写 Hooks 测试用例
- [ ] 添加常用 Hooks 示例

**交付物:**
- ✅ PreToolUse / PostToolUse Hooks
- ✅ 命令变量替换
- ✅ Hook 示例库 (格式化、日志等)

### Sprint 4: 环境变量和上下文 (Week 4)

**目标:** 完善环境管理和项目上下文

**任务:**
- [ ] 实现 env 配置注入到会话
- [ ] 实现 BLADE.md 上下文文件加载
- [ ] 支持分层上下文 (全局/项目)
- [ ] 实现 /memory 命令显示上下文
- [ ] 编写上下文测试

**交付物:**
- ✅ 会话环境变量注入
- ✅ BLADE.md 上下文系统
- ✅ 上下文查看命令

### Sprint 5: 交互式界面 (Week 5)

**目标:** 实现 REPL 中的配置管理

**任务:**
- [ ] 实现 /config 斜杠命令
- [ ] 使用 Ink 构建配置查看界面
- [ ] 显示配置来源和优先级
- [ ] 实现配置追踪功能 (/config trace)
- [ ] 添加配置验证功能

**交付物:**
- ✅ /config 交互式界面
- ✅ 配置来源追踪
- ✅ 配置验证和提示
## 九、配置职责总结

| 配置项 | config.json | settings.json | 说明 |
|--------|-------------|---------------|------|
| API Key | ✅ | ❌ | 认证凭证 |
| Base URL | ✅ | ❌ | API 端点 |
| 模型配置 | ✅ | ❌ | 模型名称、参数 |
| UI 配置 | ✅ | ❌ | 主题、语言、字体 |
| 核心配置 | ✅ | ❌ | debug、telemetry |
| 权限控制 | ❌ | ✅ | allow/ask/deny |
| Hooks | ❌ | ✅ | Pre/Post 工具执行 |
| 环境变量 | ❌ | ✅ | 会话级环境变量 |
| 配置层级 | 2层 | 3层 | 用户/项目 vs 用户/项目/本地 |
| 数据结构 | 扁平化 | 部分嵌套 | 简单直接 vs 分组管理 |
| Git 提交 | 可选 | 部分提交 | config.json 可选，settings.json 提交，settings.local.json 不提交 |
## 十、关键设计决策总结

### ✅ 采用的设计

- **双配置文件** - config.json + settings.json 职责分离
- **扁平化 config** - 避免过度嵌套，简单直接
- **统一运行时对象** - 内存中合并为 BladeConfig
- **无 CLI 命令** - 仅通过文件编辑和 REPL
- **3层 settings** - 支持团队共享和本地覆盖
- **参考 Claude Code** - 权限系统、Hooks、配置方式

### ❌ 不采用的设计

- **企业配置层级** - 暂不考虑企业场景
- **版本字段** - 配置文件不需要版本号
- **复杂 CLI 命令** - 不提供 config set/get 等命令
- **向后兼容** - 全新设计，不考虑旧版本迁移
- **分离的配置对象** - 运行时统一为一个对象
Update Todos

## 十一、待办事项

- [ ] 完善权限系统的 glob 模式支持
- [ ] 添加更多 Hooks 示例
- [ ] 实现配置验证和错误提示
- [ ] 添加配置迁移工具
- [ ] 完善文档和示例

## 十二、Claude 实施计划

### Blade 双配置系统实施计划

#### 设计概要

基于 Claude Code 设计理念，实现 config.json (基础配置) + settings.json (行为配置) 的双文件系统，运行时合并为统一的 BladeConfig 对象。

#### 核心特性

- **双文件分离** - config.json (扁平化) + settings.json (嵌套)
- **统一对象流转** - 内存中合并为单一 BladeConfig
- **3+2 层级** - config 两层，settings 三层（含 local）
- **权限系统** - allow/ask/deny 三级工具访问控制
- **Hooks 系统** - Pre/Post 工具执行自动化
- **环境变量** - 支持插值 ($VAR, ${VAR:-default}) 和注入
- **Git 友好** - 自动忽略 settings.local.json

#### 实施阶段 (5周)

**Sprint 1 (Week 1): 配置基础架构**
- 定义 BladeConfig 类型和默认配置
- 实现 ConfigManager 双配置加载
- 实现环境变量插值
- 自动配置 Git 忽略

**Sprint 2 (Week 2): 权限系统**
- 实现 PermissionChecker
- 支持多种匹配模式（精确/前缀/通配/glob）
- 集成到工具执行流程

**Sprint 3 (Week 3): Hooks 系统**
- 实现 HookExecutor
- 支持变量替换
- 集成到工具执行流程

**Sprint 4 (Week 4): 环境和上下文**
- 环境变量注入
- BLADE.md 上下文系统
- /memory 命令

**Sprint 5 (Week 5): 交互式界面**
- /config 斜杠命令
- Ink UI 配置界面
- 配置追踪和验证

#### 主要文件变更

- `src/config/types.ts` - 类型定义
- `src/config/defaults.ts` - 默认配置
- `src/config/ConfigManager.ts` - 配置管理器
- `src/config/PermissionChecker.ts` - 权限检查器
- `src/config/HookExecutor.ts` - Hooks 执行器

#### 用户使用方式

- 编辑 `~/.blade/config.json` 和 `.blade/config.json`
- 编辑 `~/.blade/settings.json`、`.blade/settings.json` 和 `.blade/settings.local.json`
- REPL 中使用 `/config` 查看和管理配置
- 无需 CLI 子命令