/**
 * 主题引擎核心类型定义
 */

import type { 
  DesignTokens, 
  ThemeConfig, 
  ThemeMode, 
  ThemeVariant, 
  ThemePreset,
  ThemeValidationResult,
  ThemeMapper,
  ThemeGeneratorOptions 
} from './design-tokens';

// 主题事件类型
export type ThemeEventType = 
  | 'theme:changed'
  | 'theme:loaded'
  | 'theme:saved'
  | 'theme:created'
  | 'theme:deleted'
  | 'theme:switched'
  | 'theme:variant:loaded'
  | 'theme:variant:applied'
  | 'theme:validation:failed'
  | 'theme:token:accessed';

// 主题事件参数
export interface ThemeEvent {
  type: ThemeEventType;
  timestamp: number;
  data?: any;
  source?: string;
}

// 主题事件监听器
export type ThemeEventListener = (event: ThemeEvent) => void;

// 主题引擎配置
export interface ThemeEngineConfig {
  // 默认主题
  defaultTheme?: string;
  // 默认模式
  defaultMode?: keyof ThemeMode;
  // 是否启用CSS变量
  enableCSSVariables?: boolean;
  // 是否启用热重载
  enableHotReload?: boolean;
  // 是否启用缓存
  enableCache?: boolean;
  // 缓存持续时间
  cacheTTL?: number;
  // 验证级别
  validationLevel?: 'strict' | 'normal' | 'loose';
  // 调试模式
  debug?: boolean;
  // 性能优化
  optimizePerformance?: boolean;
  // 自定义令牌处理器
  customTokenHandlers?: Record<string, (value: any) => any>;
}

// 主题缓存选项
export interface ThemeCacheOptions {
  enabled: boolean;
  maxSize: number;
  ttl: number;
  strategy: 'lru' | 'fifo' | 'lfu';
}

// 主题处理器接口
export interface ThemeProcessor {
  // 处理主题令牌
  process(tokens: DesignTokens): DesignTokens;
  // 验证令牌
  validate(tokens: DesignTokens): ThemeValidationResult;
  // 转换令牌格式
  transform(tokens: DesignTokens, format: string): any;
  // 获取处理器名称
  getName(): string;
}

// 主题适配器接口
export interface ThemeAdapter {
  // 将主题应用到具体的平台
  apply(theme: ThemeConfig): void;
  // 移除主题
  remove(themeId: string): void;
  // 切换主题
  switch(themeId: string): void;
  // 获取当前应用的主题
  getCurrentTheme(): ThemeConfig | null;
  // 获取适配器名称
  getName(): string;
}

// 主题存储接口
export interface ThemeStorage {
  // 保存主题
  save(theme: ThemeConfig): Promise<void>;
  // 加载主题
  load(themeId: string): Promise<ThemeConfig | null>;
  // 删除主题
  delete(themeId: string): Promise<void>;
  // 获取所有主题
  list(): Promise<ThemeConfig[]>;
  // 判断主题是否存在
  exists(themeId: string): Promise<boolean>;
  // 清空存储
  clear(): Promise<void>;
  // 获取存储统计信息
  getStats(): Promise<ThemeStorageStats>;
}

// 主题存储统计信息
export interface ThemeStorageStats {
  totalThemes: number;
  totalSize: number;
  lastUsedTheme: string;
  createdAt: Date;
  updatedAt: Date;
}

// 主题上下文
export interface ThemeContext {
  // 当前主题
  currentTheme: ThemeConfig;
  // 当前模式
  currentMode: keyof ThemeMode;
  // 当前变体
  currentVariant?: ThemeVariant;
  // 父级主题上下文
  parent: ThemeContext | null;
  // 子级主题上下文
  children: ThemeContext[];
  // 作用域
  scope: 'global' | 'local' | 'component';
  // 层级
  level: number;
  // 是否已激活
  isActive: boolean;
}

// 主题解析器
export interface ThemeResolver {
  // 解析主题令牌
  resolve(tokenPath: string): any;
  // 解析主题变量
  resolveVariable(variableName: string): any;
  // 解析主题函数
  resolveFunction(functionName: string, ...args: any[]): any;
  // 解析主题引用
  resolveReference(reference: string): any;
  // 获取所有可解析路径
  getResolvablePaths(): string[];
}

// 主题转换器
export interface ThemeTransformer {
  // 转换主题令牌
  transform(tokens: DesignTokens, targetFormat: string): any;
  // 支持的格式
  getSupportedFormats(): string[];
  // 获取转换器名称
  getName(): string;
}

// 主题验证器
export interface ThemeValidator {
  // 验证主题
  validate(theme: ThemeConfig): ThemeValidationResult;
  // 验证令牌
  validateTokens(tokens: DesignTokens): ThemeValidationResult;
  // 验证配置
  validateConfig(config: ThemeEngineConfig): boolean;
  // 获取验证规则
  getValidationRules(): ThemeValidationRule[];
}

// 验证规则
export interface ThemeValidationRule {
  // 规则名称
  name: string;
  // 规则描述
  description: string;
  // 规则类型
  type: 'required' | 'type' | 'format' | 'range' | 'custom';
  // 规则路径
  path: string;
  // 验证函数
  validator: (value: any) => boolean;
  // 错误消息
  errorMessage: string;
  // 严重程度
  severity: 'error' | 'warning' | 'info';
  // 是否启用
  enabled: boolean;
}

// 主题工厂
export interface ThemeFactory {
  // 创建主题
  create(options: Partial<ThemeConfig>): ThemeConfig;
  // 克隆主题
  clone(theme: ThemeConfig): ThemeConfig;
  // 合并主题
  merge(target: ThemeConfig, source: Partial<ThemeConfig>): ThemeConfig;
  // 从预设创建
  createFromPreset(presetId: string, overrides?: Partial<ThemeConfig>): ThemeConfig;
  // 获取可用的预设
  getAvailablePresets(): ThemePreset[];
}

// 主题钩子
export interface ThemeHooks {
  // 主题变更前钩子
  beforeThemeChange?: (oldTheme: ThemeConfig, newTheme: ThemeConfig) => boolean | Promise<boolean>;
  // 主题变更后钩子
  afterThemeChange?: (oldTheme: ThemeConfig, newTheme: ThemeConfig) => void | Promise<void>;
  // 令牌访问钩子
  onTokenAccess?: (tokenPath: string, value: any) => void;
  // 令牌变更钩子
  onTokenChange?: (tokenPath: string, oldValue: any, newValue: any) => void;
  // 主题初始化钩子
  onThemeInit?: (theme: ThemeConfig) => void | Promise<void>;
  // 主题销毁钩子
  onThemeDestroy?: (theme: ThemeConfig) => void | Promise<void>;
}

// 主题性能监控
export interface ThemePerformanceMonitor {
  // 开始监控
  start(): void;
  // 停止监控
  stop(): void;
  // 获取性能数据
  getMetrics(): ThemePerformanceMetrics;
  // 重置性能数据
  reset(): void;
}

// 主题性能指标
export interface ThemePerformanceMetrics {
  // 主题加载时间
  themeLoadTime: number;
  // 主题切换时间
  themeSwitchTime: number;
  // 令牌解析时间
  tokenResolveTime: number;
  // 缓存命中率
  cacheHitRate: number;
  // 内存使用量
  memoryUsage: number;
  // 事件处理时间
  eventHandlerTime: number;
  // 验证时间
  validationTime: number;
  // 转换时间
  transformationTime: number;
  // 总请求数
  totalRequests: number;
  // 错误数
  errorCount: number;
  // 最后更新时间
  lastUpdated: Date;
}

// 主题配置选项
export interface ThemeEngineOptions {
  // 引擎配置
  config?: ThemeEngineConfig;
  // 存储选项
  storage?: ThemeStorage;
  // 缓存选项
  cache?: ThemeCacheOptions;
  // 主题处理器
  processors?: ThemeProcessor[];
  // 主题适配器
  adapters?: ThemeAdapter[];
  // 主题转换器
  transformers?: ThemeTransformer[];
  // 主题验证器
  validators?: ThemeValidator[];
  // 主题工厂
  factory?: ThemeFactory;
  // 主题钩子
  hooks?: ThemeHooks;
  // 性能监控
  performance?: ThemePerformanceMonitor;
}

// 主题路由器
export interface ThemeRouter {
  // 注册路由
  register(path: string, handler: (params: any) => any): void;
  // 解析路由
  resolve(path: string, params?: any): any;
  // 获取所有路由
  getRoutes(): string[];
  // 移除路由
  unregister(path: string): void;
}

// 主题插件
export interface ThemePlugin {
  // 插件名称
  name: string;
  // 插件版本
  version: string;
  // 插件描述
  description: string;
  // 插件依赖
  dependencies?: string[];
  // 初始化插件
  init(engine: ThemeEngine): void | Promise<void>;
  // 销毁插件
  destroy(): void | Promise<void>;
  // 插件API
  api?: Record<string, (arg1: any, ...args: any[]) => any>;
}

// 主题中间件
export interface ThemeMiddleware {
  // 中间件名称
  name: string;
  // 处理函数
  process(request: ThemeRequest, next: () => ThemeResponse): ThemeResponse;
}

// 主题请求
export interface ThemeRequest {
  // 请求类型
  type: string;
  // 请求数据
  data: any;
  // 请求路径
  path: string;
  // 请求参数
  params: Record<string, any>;
  // 请求头
  headers: Record<string, string>;
  // 请求时间
  timestamp: number;
}

// 主题响应
export interface ThemeResponse {
  // 状态码
  status: number;
  // 响应数据
  data: any;
  // 响应头
  headers: Record<string, string>;
  // 错误信息
  error?: string;
  // 响应时间
  responseTime: number;
}

// 主题序列化器
export interface ThemeSerializer {
  // 序列化主题
  serialize(theme: ThemeConfig): string;
  // 反序列化主题
  deserialize(data: string): ThemeConfig;
  // 支持的格式
  getSupportedFormats(): string[];
  // 获取序列化器名称
  getName(): string;
}

// 主题作用域
export interface ThemeScope {
  // 作用域名称
  name: string;
  // 作用域范围
  scope: 'global' | 'component' | 'utility' | 'layout';
  // 作用域层级
  level: number;
  // 父级作用域
  parent: ThemeScope | null;
  // 子级作用域
  children: ThemeScope[];
  // 作用域主题
  theme?: ThemeConfig;
  // 是否激活
  isActive: boolean;
}

// 主题别名
export interface ThemeAlias {
  // 别名名称
  name: string;
  // 别名路径
  path: string;
  // 别名描述
  description?: string;
  // 是否启用
  enabled: boolean;
  // 创建时间
  createdAt: Date;
  // 更新时间
  updatedAt: Date;
}

// 主题快捷方式
export interface ThemeShortcut {
  // 快捷方式名称
  name: string;
  // 快捷方式值
  value: any;
  // 快捷方式描述
  description?: string;
  // 参数
  params?: string[];
  // 是否启用
  enabled: boolean;
}

// 主题搜索器
export interface ThemeSearch {
  // 搜索主题
  search(query: string, options?: ThemeSearchOptions): ThemeSearchResult[];
  // 搜索令牌
  searchTokens(query: string, options?: ThemeSearchOptions): ThemeTokenSearchResult[];
  // 获取搜索建议
  getSuggestions(query: string, limit?: number): string[];
}

// 搜索选项
export interface ThemeSearchOptions {
  // 搜索范围
  scope?: 'all' | 'themes' | 'tokens' | 'components';
  // 搜索类型
  type?: 'exact' | 'fuzzy' | 'regex';
  // 搜索字段
  fields?: string[];
  // 排序方式
  sortOrder?: 'relevance' | 'name' | 'date' | 'popularity';
  // 结果限制
  limit?: number;
  // 偏移量
  offset?: number;
}

// 搜索结果
export interface ThemeSearchResult {
  // 类型
  type: 'theme' | 'token' | 'component';
  // 标题
  title: string;
  // 描述
  description?: string;
  // 路径
  path: string;
  // 相关度
  relevance: number;
  // 元数据
  metadata?: Record<string, any>;
}

// 令牌搜索结果
export interface ThemeTokenSearchResult extends ThemeSearchResult {
  // 令牌路径
  tokenPath: string;
  // 令牌值
  tokenValue: any;
  // 令牌类型
  tokenType: string;
}