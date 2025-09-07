/**
 * 多层安全架构 - SecurityManager
 * 实现Claude Code的6层安全防护体系
 */

import { EventEmitter } from 'events';
import { ErrorFactory } from '../error/index.js';

// 安全层级接口定义
export interface SecurityLayer {
  process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>>;
  getLevel(): SecurityLevel;
  isEnabled(): boolean;
  getConfig(): SecurityLayerConfig;
}

export enum SecurityLevel {
  INPUT_VALIDATION = 1,
  AUTHENTICATION = 2,
  AUTHORIZATION = 3,
  DATA_SANITIZATION = 4,
  OUTPUT_FILTERING = 5,
  AUDIT_LOGGING = 6,
}

export interface SecurityLayerConfig {
  enabled: boolean;
  strictMode: boolean;
  customRules?: SecurityRule[];
  escalationThreshold?: number;
  failureAction: 'block' | 'log' | 'notify';
}

export interface SecurityRule {
  name: string;
  description: string;
  condition: (data: unknown) => boolean;
  action: 'allow' | 'block' | 'sanitize' | 'transform';
  metadata?: Record<string, unknown>;
}

export interface SecurityRequest<T> {
  id: string;
  data: T;
  context: SecurityContext;
  blocked?: boolean;
  blockedReason?: string;
  transformations: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SecurityResponse<T> {
  id: string;
  data: T;
  success: boolean;
  blocked: boolean;
  blockedReason?: string;
  transformations: Record<string, unknown>;
  auditTrail: AuditEvent[];
  securityLevels: SecurityLevel[];
}

export interface SecurityContext {
  userId?: string;
  sessionId?: string;
  operationType: string;
  timestamp: number;
  ipAddress?: string;
  userAgent?: string;
  permissions?: string[];
  roles?: string[];
  metadata?: Record<string, unknown>;
}

export interface AuditEvent {
  timestamp: number;
  layer: SecurityLevel;
  action: string;
  requestId: string;
  data: Record<string, unknown>;
  result: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

// 输入验证层配置
interface InputValidationConfig extends SecurityLayerConfig {
  maxInputLength: number;
  validationRules: InputValidationRule[];
  allowedChars: string[];
  forbiddenPatterns: RegExp[];
  sanitizer: InputSanitizer;
}

interface InputValidationRule {
  field: string;
  type: 'required' | 'length' | 'pattern' | 'custom';
  condition: unknown;
  errorMessage: string;
}

interface InputSanitizer {
  sanitize(input: string): string;
  validateXML(input: string): boolean;
  validateSQL(input: string): boolean;
  checkInjection(input: string): boolean;
}

// 认证层配置
interface AuthenticationConfig extends SecurityLayerConfig {
  authMethods: string[];
  tokenValidSeconds: number;
  sessionTimeout: number;
  passwordPolicy: PasswordPolicy;
}

interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecial: boolean;
  disallowedPatterns: string[];
}

// 权限控制层配置
interface AuthorizationConfig extends SecurityLayerConfig {
  permissions: Permission[];
  roles: Role[];
  acl: AccessControlList;
}

interface Permission {
  name: string;
  resource: string;
  action: string;
  condition?: string;
}

interface Role {
  name: string;
  permissions: string[];
  inheritedFrom?: string[];
}

interface AccessControlList {
  entries: ACLEntry[];
  defaultDeny: boolean;
}

interface ACLEntry {
  subject: string;
  resource: string;
  action: string;
  effect: 'allow' | 'deny';
  condition?: string;
}

// 数据净化层配置
interface DataSanitizationConfig extends SecurityLayerConfig {
  sanitizationRules: DataSanitizationRule[];
  encryptionEnabled: boolean;
  anonymizationEnabled: boolean;
}

interface DataSanitizationRule {
  type: 'email' | 'phone' | 'ssn' | 'credit_card' | 'custom';
  field: string;
  method: 'hash' | 'encrypt' | 'anonymize' | 'remove' | 'mask';
  mode: 'comprehensive' | 'fast';
}

// 输出过滤层配置
interface OutputFilteringConfig extends SecurityLayerConfig {
  filteringRules: OutputFilteringRule[];
  replacementStrings: Record<string, string>;
  blacklist: string[];
}

interface OutputFilteringRule {
  field: string;
  action: 'remove' | 'mask' | 'replace' | 'encode';
  replacement?: string;
  position?: 'before' | 'after' | 'around';
}

// 审计日志层配置
interface AuditLoggingConfig extends SecurityLayerConfig {
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  storageTarget: 'file' | 'database' | 'remote' | 'multiple';
  rotationEnabled: boolean;
  encryptionEnabled: boolean;
  retentionPeriod: number;
}

/**
 * 输入验证层
 */
class InputValidationLayer implements SecurityLayer {
  private config: InputValidationConfig;

  constructor(config: Partial<InputValidationConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? true,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'block',
      maxInputLength: config.maxInputLength ?? 10000,
      validationRules: config.validationRules ?? [],
      allowedChars: config.allowedChars ?? [/* 允许的字符集合 */],
      forbiddenPatterns: config.forbiddenPatterns ?? [
        /<script[^>]*>.*?<\/script>/gi, // script标签
        /javascript:/gi, // javascript协议
        /on\w+\s*=/gi, // 事件处理器
      ],
      sanitizer: config.sanitizer ?? this.createDefaultSanitizer(),
    };
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    const auditEvent: AuditEvent = {
      timestamp: Date.now(),
      layer: this.getLevel(),
      action: 'validate_input',
      requestId: request.id,
      data: { originalData: request.data },
      result: true,
    };

    try {
      // 检查传入数据是否可被序列化
      if (typeof request.data === 'string') {
        request.data = await this.validateAndSanitizeInput(request.data) as T;
      } else if (Array.isArray(request.data) || typeof request.data === 'object') {
        request.data = await this.validateComplexInput(request.data) as T;
      }

      auditEvent.result = true;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      return request;
    } catch (error) {
      auditEvent.result = false;
      auditEvent.error = (error as Error).message;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      if (this.config.failureAction === 'block') {
        request.blocked = true;
        request.blockedReason = `输入验证失败: ${(error as Error).message}`;
      }

      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.INPUT_VALIDATION;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private async validateAndSanitizeInput(input: string): Promise<string> {
    // 长度检查
    if (input.length > this.config.maxInputLength) {
      throw new Error(`输入长度超过最大限制: ${input.length} > ${this.config.maxInputLength}`);
    }

    // 危险字符检查
    for (const pattern of this.config.forbiddenPatterns) {
      if (pattern.test(input)) {
        throw new Error(`检测到危险模式: ${pattern.source}`);
      }
    }

    // SQL注入检查
    if (this.config.sanitizer.checkInjection(input)) {
      throw new Error('检测到SQL注入风险');
    }

    // XSS攻击检查
    if (!this.config.sanitizer.validateXML(input)) {
      throw new Error('检测到XSS攻击风险');
    }

    // 应用自定义清洗规则
    let sanitized = this.config.sanitizer.sanitize(input);
    
    // 应用自定义安全规则
    for (const rule of this.config.customRules || []) {
      if (rule.condition(input)) {
        switch (rule.action) {
          case 'block':
            throw new Error(`安全规则阻止: ${rule.name}`);
          case 'sanitize':
          case 'transform':
            sanitized = sanitized.replace(/[^\w\s-]/g, '');
            break;
        }
      }
    }

    return sanitized;
  }

  private async validateComplexInput(data: unknown): Promise<unknown> {
    // 递归验证对象和数组
    if (Array.isArray(data)) {
      return data.map(item => this.validateComplexInput(item));
    } else if (typeof data === 'object' && data !== null) {
      const validatedData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        validatedData[key] = this.validateComplexInput(value);
      }
      return validatedData;
    } else if (typeof data === 'string') {
      return this.validateAndSanitizeInput(data);
    }
    return data;
  }

  private createDefaultSanitizer(): InputSanitizer {
    return {
      sanitize: (input: string) => input.trim(),
      validateXML: (input: string) => {
        // 基本的XML验证
        return !/<script|<iframe|<object|<embed|<form/i.test(input);
      },
      validateSQL: (input: string) => {
        const sqlKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'EXEC', 'UNION'];
        const upperInput = input.toUpperCase();
        return !sqlKeywords.some(keyword => upperInput.includes(keyword));
      },
      checkInjection: (input: string) => {
        // 基本注入检测
        const injectionPatterns = [
          /['"`;]/, // 引号
          /union.*select/i,
          /drop.*table/i,
          /script.*src/i,
        ];
        return injectionPatterns.some(pattern => pattern.test(input));
      },
    };
  }
}

/**
 * 身份认证层
 */
class AuthenticationLayer implements SecurityLayer {
  private config: AuthenticationConfig;
  private validTokens: Map<string, { userId: string; expiresAt: number }> = new Map();

  constructor(config: Partial<AuthenticationConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? true,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'block',
      authMethods: config.authMethods ?? ['token', 'session'],
      tokenValidSeconds: config.tokenValidSeconds ?? 3600,
      sessionTimeout: config.sessionTimeout ?? 1800,
      passwordPolicy: config.passwordPolicy ?? this.createDefaultPasswordPolicy(),
    };
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    const auditEvent: AuditEvent = {
      timestamp: Date.now(),
      layer: this.getLevel(),
      action: 'authenticate',
      requestId: request.id,
      data: { userId: request.context.userId },
      result: true,
    };

    try {
      // 验证用户身份
      if (request.context.userId) {
        const isAuthenticated = await this.authenticateUser(request.context);
        
        if (!isAuthenticated) {
          throw new Error('用户身份验证失败');
        }

        // 验证权限级别
        await this.validatePermissionLevel(request.context);
      } else {
        // 检查匿名访问权限
        const allowAnonymous = await this.checkAnonymousAccess(request.context);
        if (!allowAnonymous) {
          throw new Error('匿名访问被拒绝');
        }
      }

      auditEvent.result = true;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      return request;
    } catch (error) {
      auditEvent.result = false;
      auditEvent.error = (error as Error).message;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      if (this.config.failureAction === 'block') {
        request.blocked = true;
        request.blockedReason = `身份认证失败: ${(error as Error).message}`;
      }

      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.AUTHENTICATION;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private async authenticateUser(context: SecurityContext): Promise<boolean> {
    // 验证Token
    if (context.metadata?.token) {
      const tokenInfo = this.validTokens.get(context.metadata.token as string);
      
      if (!tokenInfo) {
        return false;
      }

      // 检查token是否过期
      if (Date.now() > tokenInfo.expiresAt) {
        this.validTokens.delete(context.metadata.token as string);
        return false;
      }

      return tokenInfo.userId === context.userId;
    }

    // 检查会话
    if (context.sessionId) {
      // TODO: 实际会话验证逻辑
      return true;
    }

    // 检查基本凭证
    if (context.metadata?.credentials) {
      const { username, password } = context.metadata.credentials as Record<string, string>;
      return await this.validateCredentials(username, password);
    }

    return false;
  }

  private async validateCredentials(username: string, password: string): Promise<boolean> {
    // 密码策略验证
    if (password.length < this.config.passwordPolicy.minLength) {
      return false;
    }

    if (this.config.passwordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
      return false;
    }

    if (this.config.passwordPolicy.requireLowercase && !/[a-z]/.test(password)) {
      return false;
    }

    if (this.config.passwordPolicy.requireNumbers && !/\d/.test(password)) {
      return false;
    }

    // 实际凭据验证应连接外部认证服务
    return true; // 模拟验证成功
  }

  private async validatePermissionLevel(context: SecurityContext): Promise<void> {
    // 检查用户是否有执行此操作的权限级别
    if (!context.permissions || context.permissions.length === 0) {
      throw new Error('用户没有分配任何权限');
    }
  }

  private async checkAnonymousAccess(context: SecurityContext): Promise<boolean> {
    // 检查是否允许匿名访问
    return context.operationType === 'read'; // 只允许读取操作
  }

  private createDefaultPasswordPolicy(): PasswordPolicy {
    return {
      minLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecial: true,
      disallowedPatterns: ['123456', 'password', 'admin'],
    };
  }

  // 辅助方法：创建token
  createToken(userId: string): string {
    const token = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = Date.now() + this.config.tokenValidSeconds * 1000;
    
    this.validTokens.set(token, { userId, expiresAt });
    return token;
  }

  // 辅助方法：验证token
  validateToken(token: string): boolean {
    const tokenInfo = this.validTokens.get(token);
    
    if (!tokenInfo) {
      return false;
    }

    if (Date.now() > tokenInfo.expiresAt) {
      this.validTokens.delete(token);
      return false;
    }

    return true;
  }
}

/**
 * 权限控制层
 */
class AuthorizationLayer implements SecurityLayer {
  private config: AuthorizationConfig;

  constructor(config: Partial<AuthorizationConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? true,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'block',
      permissions: config.permissions ?? this.createDefaultPermissions(),
      roles: config.roles ?? this.createDefaultRoles(),
      acl: config.acl ?? this.createDefaultACL(),
    };
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    const auditEvent: AuditEvent = {
      timestamp: Date.now(),
      layer: this.getLevel(),
      action: 'authorize',
      requestId: request.id,
      data: { userId: request.context.userId, operation: request.context.operationType },
      result: true,
    };

    try {
      // 检查主体权限
      const userPermissions = this.getUserPermissions(request.context);
      const requiredPermissions = this.getRequiredPermissions(request.context);
      
      for (const permission of requiredPermissions) {
        if (!userPermissions.includes(permission)) {
          throw new Error(`缺少权限: ${permission}`);
        }
      }

      // 检查访问控制列表
      const aclAllows = await this.checkACL(request.context);
      if (!aclAllows) {
        throw new Error('访问控制列表拒绝访问');
      }

      // 检查角色权限
      const roleAllows = await this.checkRolePermissions(request.context);
      if (!roleAllows) {
        throw new Error('角色权限不足');
      }

      auditEvent.result = true;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      return request;
    } catch (error) {
      auditEvent.result = false;
      auditEvent.error = (error as Error).message;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      if (this.config.failureAction === 'block') {
        request.blocked = true;
        request.blockedReason = `权限控制失败: ${(error as Error).message}`;
      }

      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.AUTHORIZATION;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private getUserPermissions(context: SecurityContext): string[] {
    if (!context.userId || !context.permissions) {
      return [];
    }
    return context.permissions;
  }

  private getRequiredPermissions(context: SecurityContext): string[] {
    // 根据操作类型确定需要的权限
    const operationToPermission = {
      'create': 'write',
      'read': 'read',
      'update': 'write',
      'delete': 'write',
      'execute': 'execute',
      'admin': 'admin',
    };

    return [operationToPermission[context.operationType as keyof typeof operationToPermission] || 'read'];
  }

  private async checkACL(context: SecurityContext): Promise<boolean> {
    // 检查访问控制列表
    for (const entry of this.config.acl.entries) {
      if (this.matchesACL(entry, context)) {
        return entry.effect === 'allow';
      }
    }

    return this.config.acl.defaultDeny ? false : true;
  }

  private matchesACL(entry: ACLEntry, context: SecurityContext): boolean {
    // 检查主体匹配
    if (entry.subject !== '*' && entry.subject !== context.userId) {
      return false;
    }

    // 检查操作匹配
    if (entry.action !== '*' && entry.action !== context.operationType) {
      return false;
    }

    return true;
  }

  private async checkRolePermissions(context: SecurityContext): Promise<boolean> {
    if (!context.roles || context.roles.length === 0) {
      return this.config.strictMode ? false : true;
    }

    for (const roleName of context.roles) {
      const role = this.config.roles.find(r => r.name === roleName);
      if (role) {
        // 检查角色是否有足够权限
        if (this.hasRolePermission(role, context)) {
          return true;
        }
      }
    }

    return !this.config.strictMode;
  }

  private hasRolePermission(role: Role, context: SecurityContext): boolean {
    // 简化版本：检查角色是否有基本权限
    const requiredPermissions = this.getRequiredPermissions(context);
    return requiredPermissions.some(permission => role.permissions.includes(permission));
  }

  private createDefaultPermissions(): Permission[] {
    return [
      { name: 'read', resource: '*', action: 'read' },
      { name: 'write', resource: '*', action: 'write' },
      { name: 'execute', resource: '*', action: 'execute' },
      { name: 'admin', resource: '*', action: '*' },
    ];
  }

  private createDefaultRoles(): Role[] {
    return [
      { name: 'user', permissions: ['read'] },
      { name: 'developer', permissions: ['read', 'write', 'execute'] },
      { name: 'admin', permissions: ['read', 'write', 'execute', 'admin'] },
    ];
  }

  private createDefaultACL(): AccessControlList {
    return {
      entries: [
        { subject: 'admin', resource: '*', action: '*', effect: 'allow' },
        { subject: 'developer', resource: 'code', action: 'write', effect: 'allow' },
        { subject: 'user', resource: 'code', action: 'read', effect: 'allow' },
        { subject: '*', resource: 'system', action: '*', effect: 'deny' },
      ],
      defaultDeny: false,
    };
  }
}

// 继续简化实现其他安全层级类

/**
 * 数据净化层
 */
class DataSanitizationLayer implements SecurityLayer {
  private config: DataSanitizationConfig;

  constructor(config: Partial<DataSanitizationConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? true,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'block',
      sanitizationRules: config.sanitizationRules ?? this.createDefaultSanitizationRules(),
      encryptionEnabled: config.encryptionEnabled ?? true,
      anonymizationEnabled: config.anonymizationEnabled ?? true,
    };
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    const auditEvent: AuditEvent = {
      timestamp: Date.now(),
      layer: this.getLevel(),
      action: 'sanitize_data',
      requestId: request.id,
      data: { data_type: typeof request.data },
      result: true,
    };

    try {
      // 应用数据清洗规则
      request.data = await this.sanitizeData(request.data);

      auditEvent.result = true;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      return request;
    } catch (error) {
      auditEvent.result = false;
      auditEvent.error = (error as Error).message;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      if (this.config.failureAction === 'block') {
        request.blocked = true;
        request.blockedReason = `数据净化失败: ${(error as Error).message}`;
      }

      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.DATA_SANITIZATION;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private async sanitizeData<T>(data: T): Promise<T> {
    // 根据数据类型应用不同的净化规则
    if (typeof data === 'string') {
      return this.sanitizeString(data) as T;
    } else if (typeof data === 'object' && data !== null) {
      this.sanitizeObject(data);
    }
    
    return data;
  }

  private sanitizeString(input: string): string {
    // 应用字符串级别的净化
    let sanitized = input;

    for (const rule of this.config.sanitizationRules) {
      if (rule.type === 'custom' && rule.field === '*') {
        switch (rule.method) {
          case 'hash':
            sanitized = this.hashString(sanitized);
            break;
          case 'encrypt':
            sanitized = this.encryptString(sanitized);
            break;
          case 'mask':
            sanitized = this.maskString(sanitized);
            break;
        }
      }
    }

    return sanitized;
  }

  private sanitizeObject(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        obj[key] = this.sanitizeString(value);
      } else if (typeof value === 'object' && value !== null) {
        this.sanitizeObject(value as Record<string, unknown>);
      }
    }
  }

  private hashString(input: string): string {
    // 简化版本，实际应该使用加密哈希
    return Buffer.from(input).toString('base64').slice(0, 10);
  }

  private encryptString(input: string): string {
    // 模拟加密
    return `encrypted_${input}`;
  }

  private maskString(input: string): string {
    // 模拟掩码
    return '*'.repeat(input.length);
  }

  private createDefaultSanitizationRules(): DataSanitizationRule[] {
    return [
      { type: 'email', field: 'email', method: 'hash', mode: 'comprehensive' },
      { type: 'phone', field: 'phone', method: 'mask', mode: 'fast' },
      { type: 'custom', field: 'password', method: 'hash', mode: 'comprehensive' },
    ];
  }
}

/**
 * 输出过滤层
 */
class OutputFilteringLayer implements SecurityLayer {
  private config: OutputFilteringConfig;

  constructor(config: Partial<OutputFilteringConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? true,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'block',
      filteringRules: config.filteringRules ?? this.createDefaultFilteringRules(),
      replacementStrings: config.replacementStrings ?? { '[REDACTED]': '***' },
      blacklist: config.blacklist ?? ['password', 'secret', 'token', 'key'],
    };
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    const auditEvent: AuditEvent = {
      timestamp: Date.now(),
      layer: this.getLevel(),
      action: 'filter_output',
      requestId: request.id,
      data: { data_type: typeof request.data },
      result: true,
    };

    try {
      // 应用输出过滤规则
      request.data = await this.filterOutput(request.data);

      auditEvent.result = true;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      return request;
    } catch (error) {
      auditEvent.result = false;
      auditEvent.error = (error as Error).message;
      request.metadata.auditTrail = [auditEvent, ...(request.metadata.auditTrail || [])];

      if (this.config.failureAction === 'block') {
        request.blocked = true;
        request.blockedReason = `输出过滤失败: ${(error as Error).message}`;
      }

      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.OUTPUT_FILTERING;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private async filterOutput<T>(data: T): Promise<T> {
    if (typeof data === 'string') {
      return this.filterString(data) as T;
    } else if (typeof data === 'object' && data !== null) {
      return this.filterObject(data as Record<string, unknown>) as T;
    }
    return data;
  }

  private filterString(input: string): string {
    let filtered = input;

    // 检查黑名单词汇
    for (const blacklistWord of this.config.blacklist) {
      if (filtered.toLowerCase().includes(blacklistWord.toLowerCase())) {
        // 替换敏感词汇
        for (const [key, replacement] of Object.entries(this.config.replacementStrings)) {
          filtered = filtered.replace(new RegExp(blacklistWord, 'gi'), replacement);
        }
      }
    }

    return filtered;
  }

  private filterObject(obj: Record<string, unknown>): Record<string, unknown> {
    const filteredObj: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // 检查字段名是否在黑名单中
      if (this.config.blacklist.some(word => key.toLowerCase().includes(word))) {
        // 应用过滤规则
        filteredObj[key] = this.applyFilteringRules(key, value);
      } else {
        // 递归过滤嵌套对象
        if (typeof value === 'object' && value !== null) {
          filteredObj[key] = this.filterObject(value as Record<string, unknown>);
        } else if (typeof value === 'string') {
          filteredObj[key] = this.filterString(value);
        } else {
          filteredObj[key] = value;
        }
      }
    }
    
    return filteredObj;
  }

  private applyFilteringRules(fieldName: string, value: unknown): unknown {
    for (const rule of this.config.filteringRules) {
      if (rule.field === fieldName || rule.field === '*') {
        switch (rule.action) {
          case 'remove':
            return '[REDACTED]';
          case 'mask':
            return '*'.repeat(String(value).length);
          case 'replace':
            return rule.replacement || '[FILTERED]';
          case 'encode':
            return Buffer.from(String(value)).toString('base64');
        }
      }
    }
    return value;
  }

  private createDefaultFilteringRules(): OutputFilteringRule[] {
    return [
      { field: 'password', action: 'remove' },
      { field: 'secret', action: 'mask' },
      { field: 'token', action: 'replace', replacement: '[TOKEN]' },
    ];
  }
}

/**
 * 审计日志层
 */
class AuditLoggingLayer implements SecurityLayer {
  private config: AuditLoggingConfig;
  private logBuffer: AuditEvent[] = [];
  private flushInterval?: NodeJS.Timeout;

  constructor(config: Partial<AuditLoggingConfig>) {
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? false,
      customRules: config.customRules ?? [],
      escalationThreshold: config.escalationThreshold ?? 0.8,
      failureAction: config.failureAction ?? 'log',
      logLevel: config.logLevel ?? 'info',
      storageTarget: config.storageTarget ?? 'file',
      rotationEnabled: config.rotationEnabled ?? true,
      encryptionEnabled: config.encryptionEnabled ?? true,
      retentionPeriod: config.retentionPeriod ?? 30 * 24 * 60 * 60 * 1000, // 30天
    };

    if (this.config.enabled) {
      this.startLogRotation();
    }
  }

  async process<T>(request: SecurityRequest<T>): Promise<SecurityRequest<T>> {
    if (!this.isEnabled()) {
      return request;
    }

    try {
      // 收集审计数据
      const auditEntry = this.createAuditEntry(request);
      
      // 记录到审计日志
      await this.writeAuditLog(auditEntry);

      // 批量处理（如果需要）
      this.logBuffer.push(auditEntry);
      
      if (this.logBuffer.length >= 100) {
        await this.flushAuditLogs();
      }

      return request;
    } catch (error) {
      // 审计日志失败不应阻止请求处理
      console.error(`[AuditLoggingLayer] 审计日志记录失败: ${(error as Error).message}`);
      return request;
    }
  }

  getLevel(): SecurityLevel {
    return SecurityLevel.AUDIT_LOGGING;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): SecurityLayerConfig {
    return this.config;
  }

  private createAuditEntry<T>(request: SecurityRequest<T>): AuditEvent {
    return {
      timestamp: Date.now(),
      layer: SecurityLevel.AUDIT_LOGGING,
      action: request.context.operationType,
      requestId: request.id,
      data: {
        userId: request.context.userId,
        sessionId: request.context.sessionId,
        ...request.metadata,
      },
      result: !request.blocked,
      blocked: request.blocked,
      metadata: {
        processingTime: Date.now() - request.context.timestamp,
        securityLevels: request.metadata.securityLevels || [],
      },
    };
  }

  private async writeAuditLog(entry: AuditEvent): Promise<void> {
    // 根据级别决定是否记录
    if (this.shouldLogByLevel(entry)) {
      const formattedEntry = this.formatAuditEntry(entry);
      
      // 根据存储目标进行不同的处理
      switch (this.config.storageTarget) {
        case 'file':
          await this.writeToFile(formattedEntry);
          break;
        case 'database':
          await this.writeToDatabase(formattedEntry);
          break;
        case 'remote':
          await this.writeToRemote(formattedEntry);
          break;
        case 'multiple':
          await this.writeToMultiple(formattedEntry);
          break;
      }
    }
  }

  private shouldLogByLevel(entry: AuditEvent): boolean {
    const levelPriority = {
      'debug': 1,
      'info': 2,
      'warning': 3,
      'error': 4,
    };

    const entryLevel = this.determineEntryLevel(entry);
    const currentLevelPriority = levelPriority[this.config.logLevel];
    const entryLevelPriority = levelPriority[entryLevel];

    return entryLevelPriority >= currentLevelPriority;
  }

  private determineEntryLevel(entry: AuditEvent): 'debug' | 'info' | 'warning' | 'error' {
    if (entry.error || entry.result === false) return 'error';
    if (entry.blocked) return 'warning';
    return 'info';
  }

  private formatAuditEntry(entry: AuditEvent): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = this.determineEntryLevel(entry).toUpperCase();
    return `[${timestamp}] [${level}] ${JSON.stringify(entry)}`;
  }

  private async writeToFile(formattedEntry: string): Promise<void> {
    // 简化的文件写入（实际应该使用文件系统API）
    console.log(`[AUDIT] ${formattedEntry}`);
  }

  private async writeToDatabase(formattedEntry: string): Promise<void> {
    // 模拟数据库存储
    console.log(`[AUDIT-DB] ${formattedEntry}`);
  }

  private async writeToRemote(formattedEntry: string): Promise<void> {
    // 模拟远程日志服务存储
    console.log(`[AUDIT-REMOTE] ${formattedEntry}`);
  }

  private async writeToMultiple(formattedEntry: string): Promise<void> {
    await Promise.all([
      this.writeToFile(formattedEntry),
      this.writeToDatabase(formattedEntry),
      this.writeToRemote(formattedEntry),
    ]);
  }

  private async flushAuditLogs(): Promise<void> {
    if (this.logBuffer.length === 0) return;

    const logsToFlush = [...this.logBuffer];
    this.logBuffer = [];

    // 批量写入日志
    for (const log of logsToFlush) {
      await this.writeAuditLog(log);
    }
  }

  private startLogRotation(): void {
    if (!this.config.rotationEnabled) return;

    // 设置每小时轮换一次日志
    this.flushInterval = setInterval(async () => {
      await this.flushAuditLogs();
      await this.rotateLogs();
    }, 60 * 60 * 1000); // 每小时
  }

  private async rotateLogs(): Promise<void> {
    // 实施日志轮换策略
    const now = Date.now();
    const thirtyDaysAgo = now - this.config.retentionPeriod;
    
    // 清理过期的审计记录
    this.logBuffer = this.logBuffer.filter(log => log.timestamp > thirtyDaysAgo);
    
    console.log('[AUDIT] 日志轮换完成');
  }

  async destroy(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flushAuditLogs();
  }
}

/**
 * 安全管理器 - 主控制器
 */
export class SecurityManager extends EventEmitter {
  private securityLayers: SecurityLayer[] = [];
  private config: SecurityManagerConfig;
  private auditTrail: AuditEvent[] = [];
  private threatDetector: ThreatDetector;

  constructor(config: Partial<SecurityManagerConfig> = {}) {
    super();
    
    this.config = {
      enabled: config.enabled ?? true,
      strictMode: config.strictMode ?? false,
      enableThreatDetection: config.enableThreatDetection ?? true,
      logSecurityEvents: config.logSecurityEvents ?? true,
      escalationThreshold: config.escalationThreshold ?? 0.8,
      layerConfigs: config.layerConfigs ?? this.createDefaultLayerConfigs(),
    };

    this.initializeSecurityLayers();
    this.threatDetector = new ThreatDetector();
  }

  /**
   * 处理安全请求
   */
  public async processSecurely<T>(
    request: SecurityRequest<T>
  ): Promise<SecurityResponse<T>> {
    if (!this.config.enabled) {
      return this.createSuccessResponse(request);
    }

    const startTime = Date.now();
    
    try {
      this.emit('securityProcessingStarted', { requestId: request.id });

      let processedRequest = request;
      const processedLevels: SecurityLevel[] = [];
      let securityScore = 1.0;

      // 按顺序处理每个安全层级
      for (const layer of this.securityLayers) {
        try {
          processedRequest = await layer.process(processedRequest);
          processedLevels.push(layer.getLevel());
          
          if (processedRequest.blocked) {
            this.log(`请求在安全层级 ${layer.getLevel()} 被阻止`, processedRequest.blockedReason);
            
            const response: SecurityResponse<T> = {
              id: request.id,
              data: processedRequest.data,
              success: false,
              blocked: true,
              blockedReason: processedRequest.blockedReason,
              transformations: processedRequest.transformations,
              auditTrail: processedRequest.metadata.auditTrail || [],
              securityLevels: processedLevels,
            };

            this.emit('securityBlocked', response);
            return response;
          }

          // 更新安全评分
          securityScore = this.calculateSecurityScore(layer, processedRequest);
          
        } catch (error) {
          this.error(`安全层级 ${layer.getLevel()} 处理失败`, error as Error);
          
          if (this.config.strictMode) {
            throw error;
          }
        }
      }

      // 威胁检测
      if (this.config.enableThreatDetection) {
        const threatLevel = await this.threatDetector.analyze(processedRequest);
        if (threatLevel > this.config.escalationThreshold) {
          this.log(`检测到高风险行为，威胁等级: ${threatLevel}`);
          this.emit('threatDetected', { requestId: request.id, threatLevel });
          
          if (this.config.strictMode) {
            return this.createBlockedResponse(request, '威胁检测: 高风险行为');
          }
        }
      }

      return this.createSuccessResponse(processedRequest, processedLevels);
    } catch (error) {
      this.error('安全处理失败', error as Error);
      throw ErrorFactory.createFromError('SECURITY_PROCESSING_FAILED', error as Error);
    } finally {
      const duration = Date.now() - startTime;
      this.emit('securityProcessingCompleted', { requestId: request.id, duration });
    }
  }

  /**
   * 获取安全层级状态
   */
  public getLayerStatus(level: SecurityLevel): {
    enabled: boolean;
    health: 'healthy' | 'warning' | 'error';
    metrics: Record<string, unknown>;
  } {
    const layer = this.securityLayers.find(l => l.getLevel() === level);
    
    if (!layer) {
      return {
        enabled: false,
        health: 'error',
        metrics: { error: '安全层级不存在' },
      };
    }

    return {
      enabled: layer.isEnabled(),
      health: layer.isEnabled() ? 'healthy' : 'warning',
      metrics: { config: layer.getConfig() },
    };
  }

  /**
   * 启用/禁用安全层级
   */
  public setLayerEnabled(level: SecurityLevel, enabled: boolean): void {
    const layer = this.securityLayers.find(l => l.getLevel() === level);
    if (layer) {
      const config = layer.getConfig();
      config.enabled = enabled;
      this.log(`安全层级 ${level} ${enabled ? '已启用' : '已禁用'}`);
    }
  }

  /**
   * 添加自定义安全规则
   */
  public addCustomRule(level: SecurityLevel, rule: SecurityRule): void {
    const layer = this.securityLayers.find(l => l.getLevel() === level);
    if (layer) {
      const config = layer.getConfig();
      if (!config.customRules) {
        config.customRules = [];
      }
      config.customRules.push(rule);
      this.log(`添加自定义安全规则到层级 ${level}: ${rule.name}`);
    }
  }

  /**
   * 获取安全统计信息
   */
  public getSecurityStats(): {
    totalRequests: number;
    blockedRequests: number;
    threatDetections: number;
    layerStatistics: Record<SecurityLevel, {
      requests: number;
      blocked: number;
      errors: number;
    }>;
  } {
    // 这里应该统计所有的安全请求
    // 现在只是返回模拟数据
    return {
      totalRequests: 1000,
      blockedRequests: 45,
      threatDetections: 12,
      layerStatistics: {
        [SecurityLevel.INPUT_VALIDATION]: { requests: 998, blocked: 25, errors: 2 },
        [SecurityLevel.AUTHENTICATION]: { requests: 990, blocked: 10, errors: 5 },
        [SecurityLevel.AUTHORIZATION]: { requests: 985, blocked: 8, errors: 3 },
        [SecurityLevel.DATA_SANITIZATION]: { requests: 982, blocked: 2, errors: 1 },
        [SecurityLevel.OUTPUT_FILTERING]: { requests: 980, blocked: 0, errors: 0 },
        [SecurityLevel.AUDIT_LOGGING]: { requests: 980, blocked: 0, errors: 5 },
      },
    };
  }

  /**
   * 初始化安全层级
   */
  private initializeSecurityLayers(): void {
    const configs = this.config.layerConfigs;

    this.securityLayers.push(new InputValidationLayer(configs.inputValidation));
    this.securityLayers.push(new AuthenticationLayer(configs.authentication));
    this.securityLayers.push(new AuthorizationLayer(configs.authorization));
    this.securityLayers.push(new DataSanitizationLayer(configs.dataSanitization));
    this.securityLayers.push(new OutputFilteringLayer(configs.outputFiltering));
    this.securityLayers.push(new AuditLoggingLayer(configs.auditLogging));

    this.log('安全层级初始化完成', { layerCount: this.securityLayers.length });
  }

  private createDefaultLayerConfigs():
    Record<string, Partial<SecurityLayerConfig>> {
    return {
      inputValidation: {
        enabled: true,
        strictMode: true,
        failureAction: 'block',
        maxInputLength: 10000,
      },
      authentication: {
        enabled: true,
        strictMode: true,
        failureAction: 'block',
        tokenValidSeconds: 3600,
      },
      authorization: {
        enabled: true,
        strictMode: true,
        failureAction: 'block',
      },
      dataSanitization: {
        enabled: true,
        strictMode: true,
        failureAction: 'block',
        encryptionEnabled: true,
      },
      outputFiltering: {
        enabled: true,
        strictMode: true,
        failureAction: 'log',
      },
      auditLogging: {
        enabled: true,
        strictMode: false,
        failureAction: 'log',
        logLevel: 'info',
        rotationEnabled: true,
      },
    };
  }

  private createSuccessResponse<T>(
    request: SecurityRequest<T>,
    levels: SecurityLevel[]
  ): SecurityResponse<T> {
    return {
      id: request.id,
      data: request.data,
      success: true,
      blocked: false,
      transformations: request.transformations,
      auditTrail: request.metadata.auditTrail || [],
      securityLevels: levels.length > 0 ? levels : this.securityLayers.map(l => l.getLevel()),
    };
  }

  private createBlockedResponse<T>(
    request: SecurityRequest<T>,
    reason: string
  ): SecurityResponse<T> {
    return {
      id: request.id,
      data: request.data,
      success: false,
      blocked: true,
      blockedReason: reason,
      transformations: request.transformations,
      auditTrail: request.metadata.auditTrail || [],
      securityLevels: this.securityLayers.map(l => l.getLevel()),
    };
  }

  private calculateSecurityScore(layer: SecurityLayer, request: SecurityRequest<unknown>): number {
    // 简化的安全评分计算
    const baseScore = 1.0;
    const levelMultiplier = {
      [SecurityLevel.INPUT_VALIDATION]: 0.95,
      [SecurityLevel.AUTHENTICATION]: 0.98,
      [SecurityLevel.AUTHORIZATION]: 0.99,
      [SecurityLevel.DATA_SANITIZATION]: 0.97,
      [SecurityLevel.OUTPUT_FILTERING]: 0.96,
      [SecurityLevel.AUDIT_LOGGING]: 1.0,
    };

    return baseScore * (levelMultiplier[layer.getLevel()] || 1.0);
  }

  private log(message: string, data?: unknown): void {
    if (this.config.logSecurityEvents) {
      console.log(`[SecurityManager] ${message}`, data || '');
    }
  }

  private error(message: string, error?: Error): void {
    console.error(`[SecurityManager] ${message}`, error || '');
  }
}

// 威胁检测器（简化版）
class ThreatDetector {
  private threatPatterns = [
    { pattern: /select.*from.*table/i, severity: 'high' }, // SQL注入
    { pattern: /<script.*>/i, severity: 'high' }, // XSS
    { pattern: /union.*select/i, severity: 'medium' }, // SQL注入变种
    { pattern: /exec\s*\(/i, severity: 'high' }, // 代码执行
    { pattern: /javascript:/i, severity: 'medium' }, // JavaScript注入
  ];

  async analyze(request: SecurityRequest<unknown>): Promise<number> {
    const dataStr = JSON.stringify(request.data);
    let threatLevel = 0;

    for (const pattern of this.threatPatterns) {
      if (pattern.pattern.test(dataStr)) {
        threatLevel += pattern.severity === 'high' ? 0.8 : 0.4;
      }
    }

    // 基于行为模式检测异常
    const requestFrequency = this.analyzeRequestFrequency(request);
    if (requestFrequency > 10) { // 10秒内超过10次请求
      threatLevel += 0.3;
    }

    // 阻止完全可执行的可疑内容
    if (dataStr.includes('eval(') || dataStr.includes('Function(')) {
      threatLevel = 1.0;
    }

    return Math.min(threatLevel, 1.0);
  }

  private analyzeRequestFrequency(request: SecurityRequest<unknown>): number {
    // 模拟分析请求频率的逻辑
    return 2; // 模拟低频率
  }
}

interface SecurityManagerConfig {
  enabled: boolean;
  strictMode: boolean;
  enableThreatDetection: boolean;
  logSecurityEvents: boolean;
  escalationThreshold: number;
  layerConfigs: Record<string, Partial<SecurityLayerConfig>>;
}