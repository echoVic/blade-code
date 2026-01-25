/**
 * ConfigService - 配置持久化路由层
 *
 * 职责：
 * 1. 字段路由（config.json vs settings.json）
 * 2. scope 路由（local/project/global）
 * 3. 临时字段过滤
 * 4. 防抖（300ms）+ 立即持久化
 * 5. 并发写入安全（Per-file Mutex + Read-Modify-Write）
 * 6. 向前兼容（保留未知字段）
 */

import { Mutex } from 'async-mutex';
import { merge } from 'lodash-es';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { BladeConfig, PermissionConfig } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';

const logger = createLogger(LogCategory.SERVICE);

// ============================================
// 字段路由类型定义
// ============================================

type MergeStrategy = 'replace' | 'append-dedupe' | 'deep-merge';
type ConfigTarget = 'config' | 'settings';
type ConfigScope = 'local' | 'project' | 'global';

interface FieldRouting {
  target: ConfigTarget;
  defaultScope: ConfigScope;
  mergeStrategy: MergeStrategy;
  persistable: boolean;
}

// ============================================
// FIELD_ROUTING_TABLE - 单一真相源
// ============================================

/**
 * 字段路由表：定义每个配置字段的持久化行为
 *
 * 所有其他常量（PERSISTABLE_FIELDS、NON_PERSISTABLE_FIELDS 等）从此表自动派生
 */
const FIELD_ROUTING_TABLE: Record<string, FieldRouting> = {
  // ===== config.json 字段（基础配置）=====
  models: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace', // 完全替换数组
    persistable: true,
  },
  currentModelId: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  temperature: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  maxContextTokens: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  maxOutputTokens: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  timeout: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  theme: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  uiTheme: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  language: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  debug: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  fontSize: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  autoSaveSessions: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  notifyBuild: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  notifyErrors: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  notifySounds: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  privacyTelemetry: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },
  privacyCrash: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: true,
  },

  // ===== settings.json 字段（行为配置）=====
  permissionMode: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false, // 运行时状态，不持久化
  },
  permissions: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace', // 完全替换（允许删除规则）
    persistable: true,
  },
  hooks: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'deep-merge', // 深度合并对象
    persistable: true,
  },
  env: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'deep-merge',
    persistable: true,
  },
  disableAllHooks: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: true,
  },
  maxTurns: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: true,
  },
  mcpServers: {
    target: 'config',
    defaultScope: 'global', // MCP 服务器配置存储在用户全局配置中
    mergeStrategy: 'replace',
    persistable: true,
  },

  // ===== 非持久化字段（在 BladeConfig 中但不保存到磁盘）=====
  // 这些字段在 BladeConfig 中定义，但默认不持久化
  stream: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: false,
  },
  topP: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: false,
  },
  topK: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: false,
  },
  mcpEnabled: {
    target: 'config',
    defaultScope: 'global',
    mergeStrategy: 'replace',
    persistable: false,
  },

  // ===== CLI 临时字段（绝不持久化）=====
  systemPrompt: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  appendSystemPrompt: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  initialMessage: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  resumeSessionId: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  forkSession: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  allowedTools: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  disallowedTools: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  mcpConfigPaths: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  strictMcpConfig: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },

  addDirs: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  outputFormat: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  inputFormat: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  print: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  includePartialMessages: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  replayUserMessages: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  agentsConfig: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
  settingSources: {
    target: 'settings',
    defaultScope: 'local',
    mergeStrategy: 'replace',
    persistable: false,
  },
};

// ============================================
// 派生常量（从 FIELD_ROUTING_TABLE 自动生成）
// ============================================

/**
 * 可持久化的字段集合
 * 从 FIELD_ROUTING_TABLE 中提取 persistable: true 的字段
 */
const _PERSISTABLE_FIELDS = new Set(
  Object.entries(FIELD_ROUTING_TABLE)
    .filter(([_, routing]) => routing.persistable)
    .map(([field]) => field)
);

/**
 * 不可持久化的字段集合（包含两类）
 *
 * 1. **BladeConfig 永久字段但选择不持久化**:
 *    - stream, topP, topK, fontSize, mcpEnabled
 *    - 在类型定义中，但不写入文件（用户不希望或不需要持久化）
 *
 * 2. **CLI 运行时临时参数**:
 *    - systemPrompt, initialMessage, resumeSessionId, forkSession 等
 *    - 仅存在于 CLI 启动期间，从不持久化
 */
const _NON_PERSISTABLE_FIELDS = new Set(
  Object.entries(FIELD_ROUTING_TABLE)
    .filter(([_, routing]) => !routing.persistable)
    .map(([field]) => field)
);

// ============================================
// 保存选项类型
// ============================================

export interface SaveOptions {
  scope?: ConfigScope;
  immediate?: boolean;
}

// ============================================
// ConfigService 类
// ============================================

export class ConfigService {
  private static instance: ConfigService | null = null;

  // 防抖相关
  private pendingUpdates: Map<string, Record<string, unknown>> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  // Per-file 互斥锁（使用 async-mutex）
  private fileLocks: Map<string, Mutex> = new Map();

  // 错误记录
  private lastSaveError: Error | null = null;

  // 防抖延迟（毫秒）
  private readonly debounceDelay = 300;

  private constructor() {}

  /**
   * 获取单例实例
   */
  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * 重置实例（仅用于测试）
   */
  public static resetInstance(): void {
    if (ConfigService.instance) {
      // 清理所有定时器
      for (const timer of ConfigService.instance.timers.values()) {
        clearTimeout(timer);
      }
    }
    ConfigService.instance = null;
  }

  // ============================================
  // 公共 API
  // ============================================

  /**
   * 保存配置更新
   *
   * @param updates 要保存的配置项
   * @param options 保存选项
   */
  async save(updates: Partial<BladeConfig>, options: SaveOptions = {}): Promise<void> {
    // 1. 验证字段可持久化性
    this.validatePersistableFields(updates);

    // 2. 按 target 和 scope 分组
    const grouped = this.groupUpdatesByTarget(updates, options.scope);

    // 3. 根据 immediate 选项决定持久化方式
    if (options.immediate) {
      // 立即持久化
      await Promise.all(
        Array.from(grouped.entries()).map(([filePath, fieldUpdates]) =>
          this.flushTarget(filePath, fieldUpdates)
        )
      );
    } else {
      // 使用防抖
      for (const [filePath, fieldUpdates] of grouped) {
        this.scheduleSave(filePath, fieldUpdates);
      }
    }
  }

  /**
   * 立即刷新所有待持久化变更
   */
  async flush(): Promise<void> {
    // 取消所有待处理的定时器
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // 立即刷新所有待持久化变更
    const promises = Array.from(this.pendingUpdates.entries()).map(
      ([filePath, updates]) => this.flushTarget(filePath, updates)
    );

    this.pendingUpdates.clear();
    await Promise.all(promises);
  }

  /**
   * 获取最后一次保存错误
   *
   * @returns 最后一次保存失败的错误，如果没有错误则返回 null
   */
  getLastSaveError(): Error | null {
    return this.lastSaveError;
  }

  /**
   * 清除最后一次保存错误
   */
  clearLastSaveError(): void {
    this.lastSaveError = null;
  }

  /**
   * 追加权限规则（手动实现 append-dedupe 策略）
   * 默认 scope 为 'local'，与 FIELD_ROUTING_TABLE.permissions.defaultScope 一致
   *
   * ⚠️ 并发安全：整个 Read-Modify-Write 在 per-file mutex 保护下执行
   */
  async appendPermissionRule(rule: string, options: SaveOptions = {}): Promise<void> {
    const scope = options.scope ?? 'local';
    const filePath = this.resolveFilePath('settings', scope);

    // 使用 flushTargetWithModifier 确保 Read-Modify-Write 原子性
    await this.flushTargetWithModifier(filePath, (existingConfig) => {
      const existingPermissions = (existingConfig.permissions as PermissionConfig) ?? {
        allow: [],
        ask: [],
        deny: [],
      };

      // 追加并去重
      const updatedPermissions: PermissionConfig = {
        allow: this.dedupeArray([...(existingPermissions.allow || []), rule]),
        ask: existingPermissions.ask || [],
        deny: existingPermissions.deny || [],
      };

      // 返回完整配置（保留其他字段）
      return {
        ...existingConfig,
        permissions: updatedPermissions,
      };
    });
  }

  /**
   * 追加本地权限规则（强制 local scope）
   */
  async appendLocalPermissionRule(
    rule: string,
    options: Omit<SaveOptions, 'scope'> = {}
  ): Promise<void> {
    await this.appendPermissionRule(rule, { ...options, scope: 'local' });
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 验证字段是否可持久化
   */
  private validatePersistableFields(updates: Partial<BladeConfig>): void {
    for (const key of Object.keys(updates)) {
      const routing = FIELD_ROUTING_TABLE[key];

      if (!routing) {
        throw new Error(`Unknown config field: ${key}`);
      }

      if (!routing.persistable) {
        throw new Error(
          `Field "${key}" is non-persistable and cannot be saved to config files. ` +
            `Non-persistable fields are runtime-only and only valid for the current session.`
        );
      }
    }
  }

  /**
   * 按 target 和 scope 分组更新
   */
  private groupUpdatesByTarget(
    updates: Partial<BladeConfig>,
    scopeOverride?: ConfigScope
  ): Map<string, Record<string, unknown>> {
    const grouped = new Map<string, Record<string, unknown>>();

    for (const [key, value] of Object.entries(updates)) {
      const routing = FIELD_ROUTING_TABLE[key];
      if (!routing) continue;

      const scope = scopeOverride ?? routing.defaultScope;
      const filePath = this.resolveFilePath(routing.target, scope);

      if (!grouped.has(filePath)) {
        grouped.set(filePath, {});
      }
      grouped.get(filePath)![key] = value;
    }

    return grouped;
  }

  /**
   * 解析文件路径
   */
  private resolveFilePath(target: ConfigTarget, scope: ConfigScope): string {
    if (target === 'config') {
      return scope === 'global'
        ? path.join(os.homedir(), '.blade', 'config.json')
        : path.join(process.cwd(), '.blade', 'config.json');
    }

    // settings
    switch (scope) {
      case 'local':
        return path.join(process.cwd(), '.blade', 'settings.local.json');
      case 'project':
        return path.join(process.cwd(), '.blade', 'settings.json');
      case 'global':
        return path.join(os.homedir(), '.blade', 'settings.json');
      default:
        return path.join(process.cwd(), '.blade', 'settings.local.json');
    }
  }

  /**
   * 调度防抖保存
   */
  private scheduleSave(filePath: string, updates: Record<string, unknown>): void {
    // 获取现有的待处理更新
    const existing = this.pendingUpdates.get(filePath) ?? {};

    // 按字段合并策略合并（避免深层字段被覆盖）
    const merged = this.mergePendingUpdates(existing, updates);
    this.pendingUpdates.set(filePath, merged);

    // 取消已有定时器
    const existingTimer = this.timers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 设置新定时器
    const timer = setTimeout(async () => {
      const pendingUpdates = this.pendingUpdates.get(filePath);
      if (pendingUpdates) {
        this.pendingUpdates.delete(filePath);
        this.timers.delete(filePath);

        try {
          await this.flushTarget(filePath, pendingUpdates);
          // 成功后清除错误记录
          this.lastSaveError = null;
        } catch (error) {
          // 记录错误
          const saveError = error instanceof Error ? error : new Error(String(error));
          this.lastSaveError = saveError;

          // 记录日志（避免静默失败）
          logger.error(`Failed to save config to ${filePath}:`, saveError.message);
          logger.error('Stack trace:', saveError.stack);

          // 不重新抛出，避免未处理的 Promise rejection
        }
      }
    }, this.debounceDelay);

    this.timers.set(filePath, timer);
  }

  /**
   * 合并待处理更新（按字段合并策略）
   *
   * 用于防抖场景：300ms 内多次 save 调用需要正确合并，避免深层字段被覆盖
   */
  private mergePendingUpdates(
    existing: Record<string, unknown>,
    updates: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...existing };

    for (const [key, value] of Object.entries(updates)) {
      const routing = FIELD_ROUTING_TABLE[key];
      if (!routing) {
        // 未知字段直接替换
        result[key] = value;
        continue;
      }

      switch (routing.mergeStrategy) {
        case 'replace':
          result[key] = value;
          break;
        case 'append-dedupe':
          this.applyAppendDedupe(result, key, value);
          break;
        case 'deep-merge':
          this.applyDeepMerge(result, key, value);
          break;
      }
    }

    return result;
  }

  /**
   * 刷新目标文件（带 Per-file Mutex）
   */
  private async flushTarget(
    filePath: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    // 获取或创建该文件的 Mutex
    let mutex = this.fileLocks.get(filePath);
    if (!mutex) {
      mutex = new Mutex();
      this.fileLocks.set(filePath, mutex);
    }

    // 使用 Mutex 确保串行执行
    await mutex.runExclusive(async () => {
      await this.performWrite(filePath, updates);
    });
  }

  /**
   * 使用修改函数刷新目标文件（确保 Read-Modify-Write 原子性）
   * 用于需要基于当前内容进行复杂修改的场景（如追加权限规则）
   *
   * @param filePath - 目标文件路径
   * @param modifier - 修改函数，接收当前配置，返回更新后的完整配置
   */
  private async flushTargetWithModifier(
    filePath: string,
    modifier: (existingConfig: Record<string, unknown>) => Record<string, unknown>
  ): Promise<void> {
    // 获取或创建该文件的 Mutex
    let mutex = this.fileLocks.get(filePath);
    if (!mutex) {
      mutex = new Mutex();
      this.fileLocks.set(filePath, mutex);
    }

    // 使用 Mutex 确保串行执行
    await mutex.runExclusive(async () => {
      // 1. 确保目录存在
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });

      // 2. 读取当前磁盘内容（Read）
      let existingConfig: Record<string, unknown> = {};
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        existingConfig = JSON.parse(content);
      } catch {
        // 文件不存在或格式错误，使用空对象
        existingConfig = {};
      }

      // 3. 应用修改函数（Modify）
      const updatedConfig = modifier(existingConfig);

      // 4. 原子写入（Write）
      await this.atomicWrite(filePath, updatedConfig);
    });
  }

  /**
   * 执行写入操作（Read-Modify-Write）
   */
  private async performWrite(
    filePath: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    // 1. 确保目录存在
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });

    // 2. 读取当前磁盘内容（Read）
    let existingConfig: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      existingConfig = JSON.parse(content);
    } catch {
      // 文件不存在或格式错误，使用空对象
      existingConfig = {};
    }

    // 3. 按字段合并策略合并（Modify）
    const mergedConfig = { ...existingConfig }; // 保留未知字段！

    for (const [key, value] of Object.entries(updates)) {
      const routing = FIELD_ROUTING_TABLE[key];
      if (!routing) {
        // 未知字段直接写入（向前兼容）
        mergedConfig[key] = value;
        continue;
      }

      switch (routing.mergeStrategy) {
        case 'replace':
          mergedConfig[key] = value;
          break;

        case 'append-dedupe':
          this.applyAppendDedupe(mergedConfig, key, value);
          break;

        case 'deep-merge':
          this.applyDeepMerge(mergedConfig, key, value);
          break;
      }
    }

    // 4. 原子写入（Write）
    await this.atomicWrite(filePath, mergedConfig);
  }

  /**
   * 应用 append-dedupe 合并策略
   */
  private applyAppendDedupe(
    config: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    // 特殊处理 permissions 对象
    if (key === 'permissions' && typeof value === 'object' && value !== null) {
      const existingPermissions = (config[key] as PermissionConfig) ?? {
        allow: [],
        ask: [],
        deny: [],
      };
      const newPermissions = value as Partial<PermissionConfig>;

      config[key] = {
        allow: this.dedupeArray([
          ...(existingPermissions.allow || []),
          ...(newPermissions.allow || []),
        ]),
        ask: this.dedupeArray([
          ...(existingPermissions.ask || []),
          ...(newPermissions.ask || []),
        ]),
        deny: this.dedupeArray([
          ...(existingPermissions.deny || []),
          ...(newPermissions.deny || []),
        ]),
      };
    } else if (Array.isArray(value)) {
      const existing = Array.isArray(config[key]) ? config[key] : [];
      config[key] = this.dedupeArray([...existing, ...value]);
    } else {
      config[key] = value;
    }
  }

  /**
   * 应用 deep-merge 合并策略（使用 lodash-es merge）
   */
  private applyDeepMerge(
    config: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const existing =
        typeof config[key] === 'object' && config[key] !== null ? config[key] : {};
      // 使用 lodash merge 进行真正的深度合并
      config[key] = merge({}, existing, value);
    } else {
      config[key] = value;
    }
  }

  /**
   * 数组去重
   */
  private dedupeArray<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
  }

  /**
   * 原子写入（使用 write-file-atomic）
   */
  private async atomicWrite(
    filePath: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2), {
      mode: 0o600, // 仅用户可读写
      encoding: 'utf-8',
    });
  }
}

// 导出单例获取函数
export function getConfigService(): ConfigService {
  return ConfigService.getInstance();
}
