# 权限系统增强计划

> 基于 Claude Code 源码分析的权限系统改进方案

## 目录

- [概述](#概述)
- [当前问题](#当前问题)
- [Claude Code 经验总结](#claude-code-经验总结)
- [改进方案](#改进方案)
  - [Phase 1: 敏感文件检测 (P0)](#phase-1-敏感文件检测-p0)
  - [Phase 2: 路径变体匹配 (P0)](#phase-2-路径变体匹配-p0)
  - [Phase 3: 工具级权限控制 (P1)](#phase-3-工具级权限控制-p1)
  - [Phase 4: 危险路径检测优化 (P1)](#phase-4-危险路径检测优化-p1)
  - [Phase 5: 多源配置支持 (P2)](#phase-5-多源配置支持-p2)
  - [Phase 6: 测试与文档 (P1)](#phase-6-测试与文档-p1)
- [实施时间线](#实施时间线)
- [风险评估](#风险评估)
- [参考资料](#参考资料)

## 概述

本文档描述了基于 Claude Code 源码分析的权限系统改进方案。当前 Blade 的权限系统存在以下局限：

1. **缺乏敏感文件自动检测** - 无法自动识别 `.env`、`.key`、`.pem` 等敏感文件
2. **路径匹配不够灵活** - 用户配置的路径必须精确匹配，不支持路径变体（绝对/相对/标准化）
3. **缺少工具级权限** - 无法简单地允许/拒绝整个工具，必须匹配具体调用
4. **危险路径检测过于简单** - 硬编码的危险路径检测逻辑，不够全面
5. **配置源单一** - 只支持单一配置文件，不支持 local/project/global 多级配置

## 当前问题

### 问题案例：Bash 权限匹配失败

**现象**：用户在 `settings.local.json` 中配置了 `Bash(command:*)`，但仍然每次都需要确认。

**根本原因**：

1. LLM 在调用工具时添加了 `description` 元数据参数
2. 实际签名变成：`Bash(command:git status, description:Show status)`
3. 规则 `Bash(command:*)` 无法匹配，因为 picomatch 的 `*` 不跨越逗号
4. `description` 不在 Bash 工具 schema 中，是 LLM 添加的额外元数据

**已修复**：在 `PermissionChecker.ts:177` 移除了 `description: params.description`

## Claude Code 经验总结

通过分析 Claude Code 源码，发现其权限系统采用**分层检查架构**：

### 检查顺序（优先级从高到低）

```
1. Tool-level deny rules (工具级拒绝)
   ↓
2. File-level deny rules (文件级拒绝)
   ↓
3. Sensitive file detection (敏感文件检测)
   ↓
4. Ask rules (确认规则)
   ↓
5. Mode-specific checks (模式检查)
   ↓
6. Allow rules (允许规则)
   ↓
7. Default: ASK (默认确认)
```

### 核心特性

#### 1. 敏感文件检测（TD8 & PD8 函数）

Claude Code 自动检测以下敏感文件：

```typescript
// 高危敏感文件
const HIGH_SENSITIVITY = [
  '.env', '.env.local', '.env.production',
  '**/*.key', '**/*.pem',
  '~/.ssh/id_rsa', '~/.ssh/id_ed25519',
  '~/.aws/credentials', '~/.config/gcloud/credentials.json',
  '**/credentials.json', '**/service-account.json'
];

// 中危敏感文件
const MEDIUM_SENSITIVITY = [
  '.git/config', '.npmrc', '.pypirc',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
];
```

#### 2. 路径变体匹配（dO 函数）

为每个路径生成多个变体进行匹配：

```typescript
function generatePathVariants(path: string, rootDir: string): string[] {
  return [
    path,                              // 原始路径
    normalizePath(path),               // 标准化路径
    resolve(path),                     // 绝对路径
    relative(rootDir, path),           // 相对于根目录
    relative(homedir(), path),         // 相对于 home 目录
  ];
}
```

**优势**：用户可以用任何格式配置路径，系统自动匹配所有变体。

#### 3. 工具级权限

支持直接允许/拒绝整个工具：

```json
{
  "allow": ["Read", "Grep"],
  "deny": ["Bash", "Write"]
}
```

#### 4. 多源配置解析

配置优先级：`local > project > global > default`

```
~/.blade/settings.local.json    (最高优先级)
  ↓
$PROJECT/.blade/settings.json   (项目配置)
  ↓
~/.blade/settings.json          (用户全局配置)
  ↓
Default config                  (默认配置)
```

## 改进方案

### Phase 1: 敏感文件检测 (P0)

**目标**：自动检测并保护敏感文件，无需用户手动配置

#### 新增文件

`src/tools/validation/SensitiveFileDetector.ts`

```typescript
import picomatch from 'picomatch';
import { relative, resolve } from 'path';

/**
 * 敏感文件严重程度
 */
export enum SensitivityLevel {
  HIGH = 'high',       // 高危：密钥、凭证
  MEDIUM = 'medium',   // 中危：配置文件、锁文件
  LOW = 'low',         // 低危：日志、临时文件
}

/**
 * 敏感文件检测结果
 */
export interface SensitiveFileResult {
  isSensitive: boolean;
  level?: SensitivityLevel;
  matchedPattern?: string;
  reason?: string;
}

/**
 * 敏感文件检测器
 */
export class SensitiveFileDetector {
  private static readonly HIGH_PATTERNS = [
    // 环境变量文件
    '**/.env',
    '**/.env.*',
    '**/env.local',

    // 密钥文件
    '**/*.key',
    '**/*.pem',
    '**/*.p12',
    '**/*.pfx',

    // SSH 密钥
    '~/.ssh/id_rsa',
    '~/.ssh/id_ed25519',
    '~/.ssh/id_ecdsa',
    '~/.ssh/id_dsa',

    // 云服务凭证
    '~/.aws/credentials',
    '~/.aws/config',
    '~/.config/gcloud/credentials.json',
    '~/.config/gcloud/application_default_credentials.json',
    '~/.azure/credentials',

    // 服务账号
    '**/credentials.json',
    '**/service-account.json',
    '**/client_secret*.json',

    // 数据库配置
    '**/.pgpass',
    '**/.my.cnf',

    // API 密钥
    '**/*secret*.json',
    '**/*token*.json',
  ];

  private static readonly MEDIUM_PATTERNS = [
    // Git 配置
    '**/.git/config',
    '**/.gitconfig',

    // 包管理器配置
    '**/.npmrc',
    '**/.yarnrc',
    '**/.pypirc',

    // 锁文件（重要但可修改）
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/Pipfile.lock',
    '**/poetry.lock',

    // Docker 配置
    '**/.dockercfg',
    '~/.docker/config.json',
  ];

  private static readonly LOW_PATTERNS = [
    // 日志文件
    '**/*.log',
    '**/logs/**',

    // 临时文件
    '**/.tmp/**',
    '**/tmp/**',
    '**/*.tmp',

    // IDE 配置（可能包含路径等敏感信息）
    '**/.vscode/settings.json',
    '**/.idea/**',
  ];

  /**
   * 检测文件是否敏感
   */
  static detect(filePath: string, rootDir?: string): SensitiveFileResult {
    const normalizedPath = this.normalizePath(filePath, rootDir);

    // 检查高危模式
    for (const pattern of this.HIGH_PATTERNS) {
      if (this.matchPattern(normalizedPath, pattern)) {
        return {
          isSensitive: true,
          level: SensitivityLevel.HIGH,
          matchedPattern: pattern,
          reason: '检测到高危敏感文件（密钥/凭证/环境变量）',
        };
      }
    }

    // 检查中危模式
    for (const pattern of this.MEDIUM_PATTERNS) {
      if (this.matchPattern(normalizedPath, pattern)) {
        return {
          isSensitive: true,
          level: SensitivityLevel.MEDIUM,
          matchedPattern: pattern,
          reason: '检测到中危敏感文件（配置/锁文件）',
        };
      }
    }

    // 检查低危模式
    for (const pattern of this.LOW_PATTERNS) {
      if (this.matchPattern(normalizedPath, pattern)) {
        return {
          isSensitive: true,
          level: SensitivityLevel.LOW,
          matchedPattern: pattern,
          reason: '检测到低危敏感文件（日志/临时文件）',
        };
      }
    }

    return { isSensitive: false };
  }

  /**
   * 批量检测多个文件
   */
  static detectBatch(filePaths: string[], rootDir?: string): Map<string, SensitiveFileResult> {
    const results = new Map<string, SensitiveFileResult>();

    for (const path of filePaths) {
      results.set(path, this.detect(path, rootDir));
    }

    return results;
  }

  /**
   * 标准化路径（处理 ~ 和相对路径）
   */
  private static normalizePath(filePath: string, rootDir?: string): string {
    let normalized = filePath;

    // 处理 ~ 开头的路径
    if (normalized.startsWith('~/')) {
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      normalized = normalized.replace('~', homedir);
    }

    // 转换为绝对路径
    normalized = resolve(normalized);

    // 如果提供了根目录，同时保留相对路径表示
    if (rootDir) {
      const relativePath = relative(rootDir, normalized);
      // 返回更短的那个（可能是相对路径）
      return relativePath.length < normalized.length ? relativePath : normalized;
    }

    return normalized;
  }

  /**
   * 使用 picomatch 进行模式匹配
   */
  private static matchPattern(path: string, pattern: string): boolean {
    const normalizedPattern = this.normalizePath(pattern);
    return picomatch.isMatch(path, normalizedPattern, { dot: true });
  }
}
```

#### 集成到 PermissionStage

修改 `src/tools/execution/PipelineStages.ts`：

```typescript
import { SensitiveFileDetector, SensitivityLevel } from '../validation/SensitiveFileDetector.js';

export class PermissionStage implements ExecutionStage {
  async process(execution: ToolExecution): Promise<void> {
    // ... 现有代码 ...

    // 【新增】敏感文件检测
    if (affectedPaths.length > 0) {
      const sensitiveResults = SensitiveFileDetector.detectBatch(
        affectedPaths,
        process.cwd()
      );

      for (const [path, result] of sensitiveResults) {
        if (result.isSensitive) {
          // 高危敏感文件：强制确认
          if (result.level === SensitivityLevel.HIGH) {
            this.logger.warn(`检测到高危敏感文件: ${path}`);
            this.logger.warn(`原因: ${result.reason}`);

            // 即使有 allow 规则也需要确认
            checkResult.result = PermissionResult.ASK;
            checkResult.reason = `${result.reason}: ${path}`;
            break;
          }

          // 中危敏感文件：记录警告
          if (result.level === SensitivityLevel.MEDIUM) {
            this.logger.warn(`检测到中危敏感文件: ${path} (${result.reason})`);
          }
        }
      }
    }

    // ... 现有权限检查逻辑 ...
  }
}
```

### Phase 2: 路径变体匹配 (P0)

**目标**：支持灵活的路径配置，自动匹配多种路径表示形式

#### 新增文件

`src/security/PathMatcher.ts`

```typescript
import { normalize, resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import picomatch from 'picomatch';

/**
 * 路径匹配器 - 生成路径变体并进行灵活匹配
 */
export class PathMatcher {
  /**
   * 生成路径的所有变体
   */
  static generateVariants(path: string, rootDir?: string): string[] {
    const variants = new Set<string>();

    // 1. 原始路径
    variants.add(path);

    // 2. 标准化路径（处理 . 和 ..）
    const normalized = normalize(path);
    variants.add(normalized);

    // 3. 绝对路径
    let absolutePath: string;
    if (isAbsolute(path)) {
      absolutePath = path;
    } else {
      absolutePath = resolve(process.cwd(), path);
    }
    variants.add(absolutePath);
    variants.add(normalize(absolutePath));

    // 4. 相对于根目录的路径
    if (rootDir) {
      const relativeToRoot = relative(rootDir, absolutePath);
      variants.add(relativeToRoot);
      variants.add(normalize(relativeToRoot));
    }

    // 5. 相对于当前工作目录的路径
    const relativeToCwd = relative(process.cwd(), absolutePath);
    variants.add(relativeToCwd);
    variants.add(normalize(relativeToCwd));

    // 6. 相对于 home 目录的路径（如果在 home 内）
    const home = homedir();
    if (absolutePath.startsWith(home)) {
      const relativeToHome = relative(home, absolutePath);
      variants.add(`~/${relativeToHome}`);
      variants.add(normalize(`~/${relativeToHome}`));
    }

    // 7. 处理 Windows 路径分隔符
    if (process.platform === 'win32') {
      const windowsVariants = Array.from(variants).map(v => v.replace(/\\/g, '/'));
      windowsVariants.forEach(v => variants.add(v));
    }

    return Array.from(variants);
  }

  /**
   * 检查路径是否匹配规则（支持路径变体）
   */
  static matches(
    path: string,
    pattern: string,
    options?: { rootDir?: string; matchOptions?: picomatch.PicomatchOptions }
  ): boolean {
    const { rootDir, matchOptions = { dot: true } } = options || {};

    // 生成路径的所有变体
    const pathVariants = this.generateVariants(path, rootDir);

    // 生成模式的所有变体
    const patternVariants = this.generateVariants(pattern, rootDir);

    // 尝试所有变体组合
    for (const pathVariant of pathVariants) {
      for (const patternVariant of patternVariants) {
        if (picomatch.isMatch(pathVariant, patternVariant, matchOptions)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 批量匹配：检查路径是否匹配任一规则
   */
  static matchesAny(
    path: string,
    patterns: string[],
    options?: { rootDir?: string; matchOptions?: picomatch.PicomatchOptions }
  ): { matched: boolean; matchedPattern?: string } {
    for (const pattern of patterns) {
      if (this.matches(path, pattern, options)) {
        return { matched: true, matchedPattern: pattern };
      }
    }
    return { matched: false };
  }
}
```

#### 集成到 PermissionChecker

修改 `src/config/PermissionChecker.ts`：

```typescript
import { PathMatcher } from '../security/PathMatcher.js';

export class PermissionChecker {
  /**
   * 匹配参数（增强版：支持路径变体匹配）
   */
  private matchParams(sigParams: string, ruleParams: string): boolean {
    if (!sigParams || !ruleParams) {
      return false;
    }

    const sigPairs = this.parseParamPairs(sigParams);
    const rulePairs = this.parseParamPairs(ruleParams);

    for (const [ruleKey, ruleValue] of Object.entries(rulePairs)) {
      const sigValue = sigPairs[ruleKey];

      if (sigValue === undefined) {
        return false;
      }

      // 【新增】路径参数使用路径变体匹配
      if (this.isPathParam(ruleKey)) {
        if (!PathMatcher.matches(sigValue, ruleValue)) {
          return false;
        }
        continue;
      }

      // 原有的 glob 匹配逻辑
      if (
        ruleValue.includes('*') ||
        ruleValue.includes('{') ||
        ruleValue.includes('?')
      ) {
        if (!picomatch.isMatch(sigValue, ruleValue, { dot: true })) {
          return false;
        }
      } else if (sigValue !== ruleValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * 判断参数是否为路径参数
   */
  private isPathParam(paramKey: string): boolean {
    return (
      paramKey === 'file_path' ||
      paramKey === 'path' ||
      paramKey === 'cwd' ||
      paramKey === 'directory' ||
      paramKey === 'notebook_path'
    );
  }
}
```

### Phase 3: 工具级权限控制 (P1)

**目标**：支持直接允许/拒绝整个工具，无需匹配具体参数

#### 修改 PermissionChecker

修改 `src/config/PermissionChecker.ts`：

```typescript
export class PermissionChecker {
  /**
   * 检查工具调用权限（增强版：支持工具级规则）
   */
  check(descriptor: ToolInvocationDescriptor): PermissionCheckResult {
    const { toolName } = descriptor;
    const signature = PermissionChecker.buildSignature(descriptor);

    // 【新增】优先级 0: 工具级 deny 规则
    if (this.config.deny.includes(toolName)) {
      return {
        result: PermissionResult.DENY,
        matchedRule: toolName,
        matchType: 'exact',
        reason: `工具 ${toolName} 被全局拒绝`,
      };
    }

    // 优先级 1: 签名级 deny 规则
    const denyMatch = this.matchRules(signature, this.config.deny);
    if (denyMatch) {
      return {
        result: PermissionResult.DENY,
        matchedRule: denyMatch.rule,
        matchType: denyMatch.type,
        reason: `工具调用被拒绝规则阻止: ${denyMatch.rule}`,
      };
    }

    // 【新增】优先级 2: 工具级 allow 规则
    if (this.config.allow.includes(toolName)) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: toolName,
        matchType: 'exact',
        reason: `工具 ${toolName} 被全局允许`,
      };
    }

    // 优先级 3: 签名级 allow 规则
    const allowMatch = this.matchRules(signature, this.config.allow);
    if (allowMatch) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: allowMatch.rule,
        matchType: allowMatch.type,
        reason: `工具调用符合允许规则: ${allowMatch.rule}`,
      };
    }

    // 优先级 4: ask 规则
    const askMatch = this.matchRules(signature, this.config.ask);
    if (askMatch) {
      return {
        result: PermissionResult.ASK,
        matchedRule: askMatch.rule,
        matchType: askMatch.type,
        reason: `工具调用需要用户确认: ${askMatch.rule}`,
      };
    }

    // 默认: ASK
    return {
      result: PermissionResult.ASK,
      reason: '工具调用未匹配任何规则,默认需要确认',
    };
  }
}
```

#### 配置示例

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Grep",
      "Glob"
    ],
    "deny": [
      "Bash",
      "Write(file_path:**/*.env)"
    ],
    "ask": [
      "Write",
      "Edit"
    ]
  }
}
```

### Phase 4: 危险路径检测优化 (P1)

**目标**：将硬编码的危险路径检测提取为可配置的规则

#### 新增配置类型

修改 `src/config/types.ts`：

```typescript
/**
 * 危险路径配置
 */
export interface DangerousPathConfig {
  /** 系统关键目录 */
  systemPaths: string[];
  /** 系统配置目录 */
  configPaths: string[];
  /** 敏感文件模式 */
  sensitivePatterns: string[];
  /** 是否启用路径遍历检测 */
  detectTraversal: boolean;
}

/**
 * 设置配置
 */
export interface SettingsConfig {
  permissions: PermissionConfig;
  hooks: HookConfig;
  environment: EnvironmentConfig;
  dangerousPaths?: DangerousPathConfig; // 【新增】
}
```

#### 默认危险路径配置

修改 `src/config/defaults.ts`：

```typescript
/**
 * 默认危险路径配置
 */
export const DEFAULT_DANGEROUS_PATHS: DangerousPathConfig = {
  systemPaths: [
    '/etc',
    '/sys',
    '/proc',
    '/dev',
    '/boot',
    '/root',
    '/var/log',
    'C:\\Windows\\System32',
    'C:\\Windows\\SysWOW64',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ],
  configPaths: [
    '~/.ssh',
    '~/.aws',
    '~/.config',
    '/etc/ssh',
    '/etc/passwd',
    '/etc/shadow',
  ],
  sensitivePatterns: [
    '**/.env*',
    '**/*.key',
    '**/*.pem',
    '**/credentials.json',
  ],
  detectTraversal: true,
};
```

#### 优化 PipelineStages

修改 `src/tools/execution/PipelineStages.ts`：

```typescript
export class PermissionStage implements ExecutionStage {
  async process(execution: ToolExecution): Promise<void> {
    // ... 现有代码 ...

    // 【优化】危险路径检测（使用配置）
    if (affectedPaths.length > 0) {
      const dangerousPathConfig =
        this.configManager.getConfig().settings.dangerousPaths ||
        DEFAULT_DANGEROUS_PATHS;

      const dangerousPaths = affectedPaths.filter((path: string) => {
        // 路径遍历检测
        if (dangerousPathConfig.detectTraversal && path.includes('..')) {
          return true;
        }

        // 系统路径检测
        for (const systemPath of dangerousPathConfig.systemPaths) {
          if (path.startsWith(systemPath) || path.includes(systemPath)) {
            return true;
          }
        }

        // 配置路径检测
        for (const configPath of dangerousPathConfig.configPaths) {
          if (PathMatcher.matches(path, configPath)) {
            return true;
          }
        }

        // 敏感文件模式检测
        for (const pattern of dangerousPathConfig.sensitivePatterns) {
          if (PathMatcher.matches(path, pattern)) {
            return true;
          }
        }

        return false;
      });

      if (dangerousPaths.length > 0) {
        execution.abort(`访问危险路径被拒绝: ${dangerousPaths.join(', ')}`);
        return;
      }
    }

    // ... 现有代码 ...
  }
}
```

### Phase 5: 多源配置支持 (P2)

**目标**：支持 local/project/global 三级配置，优先级：local > project > global

#### 新增配置解析器

`src/config/PermissionConfigResolver.ts`

```typescript
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { PermissionConfig } from './types.js';

/**
 * 权限配置解析器 - 支持多源配置合并
 */
export class PermissionConfigResolver {
  /**
   * 解析并合并多源权限配置
   */
  static resolve(projectRoot?: string): PermissionConfig {
    const configs: PermissionConfig[] = [];

    // 1. 全局配置 (~/.blade/settings.json)
    const globalConfig = this.loadGlobalConfig();
    if (globalConfig) {
      configs.push(globalConfig.permissions);
    }

    // 2. 项目配置 ($PROJECT/.blade/settings.json)
    if (projectRoot) {
      const projectConfig = this.loadProjectConfig(projectRoot);
      if (projectConfig) {
        configs.push(projectConfig.permissions);
      }
    }

    // 3. 本地配置 ($PROJECT/.blade/settings.local.json) - 最高优先级
    if (projectRoot) {
      const localConfig = this.loadLocalConfig(projectRoot);
      if (localConfig) {
        configs.push(localConfig.permissions);
      }
    }

    // 合并配置（后面的覆盖前面的）
    return this.mergeConfigs(configs);
  }

  /**
   * 合并多个权限配置
   */
  private static mergeConfigs(configs: PermissionConfig[]): PermissionConfig {
    const merged: PermissionConfig = {
      allow: [],
      ask: [],
      deny: [],
    };

    for (const config of configs) {
      // deny 规则：累加（不覆盖）
      if (config.deny) {
        merged.deny = [...merged.deny, ...config.deny];
      }

      // allow 规则：累加（不覆盖）
      if (config.allow) {
        merged.allow = [...merged.allow, ...config.allow];
      }

      // ask 规则：累加（不覆盖）
      if (config.ask) {
        merged.ask = [...merged.ask, ...config.ask];
      }
    }

    // 去重
    merged.allow = Array.from(new Set(merged.allow));
    merged.ask = Array.from(new Set(merged.ask));
    merged.deny = Array.from(new Set(merged.deny));

    return merged;
  }

  /**
   * 加载全局配置
   */
  private static loadGlobalConfig(): { permissions: PermissionConfig } | null {
    const globalPath = resolve(homedir(), '.blade', 'settings.json');
    if (existsSync(globalPath)) {
      try {
        return require(globalPath);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * 加载项目配置
   */
  private static loadProjectConfig(projectRoot: string): { permissions: PermissionConfig } | null {
    const projectPath = resolve(projectRoot, '.blade', 'settings.json');
    if (existsSync(projectPath)) {
      try {
        return require(projectPath);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * 加载本地配置
   */
  private static loadLocalConfig(projectRoot: string): { permissions: PermissionConfig } | null {
    const localPath = resolve(projectRoot, '.blade', 'settings.local.json');
    if (existsSync(localPath)) {
      try {
        return require(localPath);
      } catch {
        return null;
      }
    }
    return null;
  }
}
```

#### 集成到 ConfigManager

修改 `src/config/ConfigManager.ts`：

```typescript
import { PermissionConfigResolver } from './PermissionConfigResolver.js';

export class ConfigManager {
  /**
   * 加载设置配置（增强版：支持多源合并）
   */
  private loadSettings(): SettingsConfig {
    // 【新增】使用解析器合并多源权限配置
    const mergedPermissions = PermissionConfigResolver.resolve(this.projectRoot);

    // 其他配置仍使用现有逻辑
    const settings: SettingsConfig = {
      permissions: mergedPermissions,
      hooks: this.loadHooks(),
      environment: this.loadEnvironment(),
    };

    return settings;
  }
}
```

### Phase 6: 测试与文档 (P1)

#### 测试计划

**单元测试**：

1. `tests/unit/security/SensitiveFileDetector.test.ts`
   - 测试高/中/低危文件检测
   - 测试路径标准化
   - 测试批量检测

2. `tests/unit/security/PathMatcher.test.ts`
   - 测试路径变体生成
   - 测试跨平台路径匹配
   - 测试 home 目录处理

3. `tests/unit/config/PermissionChecker.test.ts`
   - 测试工具级权限
   - 测试路径变体匹配集成
   - 测试分层检查逻辑

4. `tests/unit/config/PermissionConfigResolver.test.ts`
   - 测试多源配置合并
   - 测试配置优先级
   - 测试去重逻辑

**集成测试**：

1. `tests/integration/permission-system.test.ts`
   - 测试完整的权限检查流程
   - 测试敏感文件检测集成
   - 测试多源配置集成

**E2E 测试**：

1. `tests/e2e/sensitive-file-protection.test.ts`
   - 测试用户尝试访问 `.env` 文件
   - 测试用户尝试访问 SSH 密钥
   - 验证自动确认提示

#### 文档更新

1. **用户文档** (`docs/public/configuration/permissions.md`)
   - 添加工具级权限示例
   - 添加敏感文件保护说明
   - 添加路径配置灵活性说明
   - 添加多源配置说明

2. **开发者文档** (`docs/development/architecture/permission-system.md`)
   - 更新架构图
   - 添加分层检查流程图
   - 添加路径变体匹配原理

3. **示例配置**
   - 创建 `.blade/settings.example.json` 展示最佳实践

## 实施时间线

### Week 1 (3 days)

- **Day 1**: Phase 1 - 敏感文件检测
  - 实现 `SensitiveFileDetector`
  - 集成到 `PermissionStage`
  - 编写单元测试

- **Day 2**: Phase 2 - 路径变体匹配
  - 实现 `PathMatcher`
  - 集成到 `PermissionChecker`
  - 编写单元测试

- **Day 3**: Phase 3 - 工具级权限
  - 修改 `PermissionChecker.check()`
  - 更新配置示例
  - 编写单元测试

### Week 2 (2-4 days)

- **Day 4**: Phase 4 - 危险路径优化
  - 更新配置类型
  - 优化 `PipelineStages`
  - 编写单元测试

- **Day 5**: Phase 5 - 多源配置（可选）
  - 实现 `PermissionConfigResolver`
  - 集成到 `ConfigManager`
  - 编写单元测试

- **Day 6-7**: Phase 6 - 测试与文档
  - 编写集成测试和 E2E 测试
  - 更新用户文档
  - 更新开发者文档
  - 创建示例配置

**总计**: 5-7 天

## 风险评估

### 高风险

1. **破坏性变更** - 修改 `PermissionChecker` 可能影响现有规则
   - **缓解**: 增加全面的回归测试
   - **缓解**: 保持向后兼容，旧规则仍然有效

2. **性能影响** - 路径变体生成可能增加检查开销
   - **缓解**: 使用缓存机制缓存路径变体
   - **缓解**: 性能测试确保开销可接受（< 10ms）

### 中风险

1. **配置迁移** - 多源配置可能导致用户配置混乱
   - **缓解**: 提供详细的迁移指南
   - **缓解**: 提供配置验证命令

2. **跨平台兼容性** - Windows/Linux/Mac 路径处理差异
   - **缓解**: 在所有平台上进行测试
   - **缓解**: 使用 Node.js 标准库的跨平台 API

### 低风险

1. **误报** - 敏感文件检测可能误判正常文件
   - **缓解**: 提供配置覆盖机制
   - **缓解**: 收集用户反馈优化模式

## 参考资料

### Claude Code 源码分析

- **TD8 函数**: 敏感文件检测逻辑
- **PD8 函数**: 敏感文件模式列表
- **dO 函数**: 路径变体生成
- **分层检查架构**: Tool-level → File-level → Sensitive → Ask → Mode → Allow → Default

### Blade 现有实现

- [PermissionChecker.ts](../../src/config/PermissionChecker.ts)
- [PipelineStages.ts](../../src/tools/execution/PipelineStages.ts)
- [ConfigManager.ts](../../src/config/ConfigManager.ts)
- [权限配置文档](../public/configuration/permissions.md)

### 相关技术

- [picomatch](https://github.com/micromatch/picomatch) - Glob 模式匹配
- [minimatch](https://github.com/isaacs/minimatch) - Claude Code 使用的 glob 库

---

**文档版本**: 1.0
**创建日期**: 2025-01-XX
**最后更新**: 2025-01-XX
**状态**: 待实施
