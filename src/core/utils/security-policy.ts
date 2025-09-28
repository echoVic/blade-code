/**
 * 安全配置和策略管理
 * 管理应用程序的安全设置和策略
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigEncryptor } from './config-encryptor.js';

export interface SecurityPolicy {
  // 身份认证策略
  auth: {
    maxLoginAttempts: number;
    lockoutDuration: number; // 分钟
    passwordMinLength: number;
    passwordRequireComplexity: boolean;
    sessionTimeout: number; // 分钟
    twoFactorAuthRequired: boolean;
    apiKeyRotationEnabled: boolean;
    apiKeyMaxAge: number; // 天
  };

  // 输入验证策略
  inputValidation: {
    maxInputLength: number;
    allowHtml: boolean;
    sanitizeInput: boolean;
    rateLimit: {
      requests: number;
      period: number; // 毫秒
    };
  };

  // 文件系统安全策略
  fileSystem: {
    allowedDirectories: string[];
    allowedExtensions: string[];
    maxFileSize: number; // 字节
    scanForViruses: boolean;
    quarantineSuspiciousFiles: boolean;
  };

  // 网络安全策略
  network: {
    allowedHosts: string[];
    corsOrigins: string[];
    rateLimit: {
      requests: number;
      period: number; // 毫秒
    };
    timeout: number; // 毫秒
    requireHttps: boolean;
    certificatePinning: boolean;
  };

  // AI/提示词安全策略
  promptSecurity: {
    detectInjection: boolean;
    sanitizeInput: boolean;
    maxPromptLength: number;
    allowedModels: string[];
    contentFilterEnabled: boolean;
    generatedContentReview: boolean;
  };

  // 日志和监控策略
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    logSensitiveData: boolean;
    retentionDays: number;
    auditEvents: boolean;
  };

  // 数据保护策略
  dataProtection: {
    encryptSensitiveData: boolean;
    encryptionAlgorithm: string;
    dataRetentionDays: number;
    backupRequired: boolean;
    backupEncryption: boolean;
  };
}

export class SecurityPolicyManager {
  private static instance: SecurityPolicyManager;
  private policy: SecurityPolicy;
  private policyFile: string;

  private constructor() {
    this.policyFile = join(process.cwd(), 'config', 'security-policy.json');
    this.policy = this.loadDefaultPolicy();
    this.loadPolicy();
  }

  static getInstance(): SecurityPolicyManager {
    if (!SecurityPolicyManager.instance) {
      SecurityPolicyManager.instance = new SecurityPolicyManager();
    }
    return SecurityPolicyManager.instance;
  }

  /**
   * 获取当前安全策略
   */
  getPolicy(): SecurityPolicy {
    return { ...this.policy };
  }

  /**
   * 更新安全策略
   */
  updatePolicy(updates: Partial<SecurityPolicy>): void {
    this.policy = { ...this.policy, ...updates };
    this.savePolicy();
  }

  /**
   * 验证访问权限
   */
  validateAccess(
    resource: string,
    action: string,
    userContext?: any
  ): { allowed: boolean; reason?: string } {
    // 基本访问控制检查
    if (!userContext) {
      return { allowed: false, reason: '未提供用户上下文' };
    }

    // 检查资源和操作是否被允许
    const permissions = this.getResourcePermissions(resource);
    if (!permissions.includes(action)) {
      return { allowed: false, reason: '权限不足' };
    }

    // 检查用户角色
    if (!this.hasRequiredRole(userContext, resource, action)) {
      return { allowed: false, reason: '角色权限不足' };
    }

    return { allowed: true };
  }

  /**
   * 检查是否符合安全策略
   */
  checkCompliance(
    checkType: keyof SecurityPolicy,
    data: any
  ): { compliant: boolean; violations: string[] } {
    const violations: string[] = [];

    switch (checkType) {
      case 'inputValidation':
        this.checkInputValidation(data, violations);
        break;
      case 'fileSystem':
        this.checkFileSystemSecurity(data, violations);
        break;
      case 'network':
        this.checkNetworkSecurity(data, violations);
        break;
      case 'promptSecurity':
        this.checkPromptSecurity(data, violations);
        break;
      default:
        violations.push(`不支持的安全检查类型: ${checkType}`);
    }

    return {
      compliant: violations.length === 0,
      violations,
    };
  }

  /**
   * 应用安全策略到数据
   */
  applyPolicy(data: any, policyType: keyof SecurityPolicy): any {
    switch (policyType) {
      case 'inputValidation':
        return this.applyInputValidation(data);
      case 'dataProtection':
        return this.applyDataProtection(data);
      case 'logging':
        return this.applyLoggingPolicy(data);
      default:
        return data;
    }
  }

  /**
   * 监控策略违规
   */
  monitorPolicyViolations(): void {
    // 在实际应用中，这里会定期检查策略合规性
    // 并记录任何违规行为
  }

  /**
   * 生成合规性报告
   */
  generateComplianceReport(): string {
    const policy = this.getPolicy();
    
    let report = `=== 安全策略合规性报告 ===\n\n`;
    report += `生成时间: ${new Date().toISOString()}\n\n`;

    // 认证策略
    report += `认证策略:\n`;
    report += `- 最大登录尝试次数: ${policy.auth.maxLoginAttempts}\n`;
    report += `- 锁定时长: ${policy.auth.lockoutDuration} 分钟\n`;
    report += `- 密码最小长度: ${policy.auth.passwordMinLength}\n`;
    report += `- 会话超时: ${policy.auth.sessionTimeout} 分钟\n`;
    report += `- 双因素认证: ${policy.auth.twoFactorAuthRequired ? '启用' : '禁用'}\n\n`;

    // 输入验证策略
    report += `输入验证策略:\n`;
    report += `- 最大输入长度: ${policy.inputValidation.maxInputLength}\n`;
    report += `- 允许HTML: ${policy.inputValidation.allowHtml ? '是' : '否'}\n`;
    report += `- 输入净化: ${policy.inputValidation.sanitizeInput ? '是' : '否'}\n`;
    report += `- 速率限制: ${policy.inputValidation.rateLimit.requests} 请求/${policy.inputValidation.rateLimit.period}ms\n\n`;

    // 网络安全策略
    report += `网络安全策略:\n`;
    report += `- 强制HTTPS: ${policy.network.requireHttps ? '是' : '否'}\n`;
    report += `- 证书固定: ${policy.network.certificatePinning ? '是' : '否'}\n`;
    report += `- 速率限制: ${policy.network.rateLimit.requests} 请求/${policy.network.rateLimit.period}ms\n`;
    report += `- 超时设置: ${policy.network.timeout}ms\n\n`;

    return report;
  }

  /**
   * 加载默认策略
   */
  private loadDefaultPolicy(): SecurityPolicy {
    return {
      auth: {
        maxLoginAttempts: 5,
        lockoutDuration: 30,
        passwordMinLength: 12,
        passwordRequireComplexity: true,
        sessionTimeout: 60,
        twoFactorAuthRequired: false,
        apiKeyRotationEnabled: true,
        apiKeyMaxAge: 90,
      },
      inputValidation: {
        maxInputLength: 4000,
        allowHtml: false,
        sanitizeInput: true,
        rateLimit: {
          requests: 100,
          period: 60000,
        },
      },
      fileSystem: {
        allowedDirectories: [
          process.cwd(),
          join(require('os').homedir(), '.blade'),
          require('os').tmpdir(),
        ],
        allowedExtensions: [
          '.txt', '.json', '.md', '.js', '.ts', '.jsx', '.tsx', 
          '.css', '.scss', '.html', '.xml', '.yaml', '.yml',
          '.png', '.jpg', '.jpeg', '.gif', '.svg'
        ],
        maxFileSize: 10 * 1024 * 1024, // 10MB
        scanForViruses: false,
        quarantineSuspiciousFiles: true,
      },
      network: {
        allowedHosts: [
          'api.openai.com',
          'api.anthropic.com',
          'localhost',
          '127.0.0.1',
        ],
        corsOrigins: ['http://localhost:3000'],
        rateLimit: {
          requests: 1000,
          period: 3600000, // 1小时
        },
        timeout: 30000,
        requireHttps: true,
        certificatePinning: false,
      },
      promptSecurity: {
        detectInjection: true,
        sanitizeInput: true,
        maxPromptLength: 10000,
        allowedModels: [
          'gpt-4',
          'gpt-3.5-turbo',
          'claude-3-opus',
          'claude-3-sonnet',
          'Qwen3-Coder',
        ],
        contentFilterEnabled: true,
        generatedContentReview: true,
      },
      logging: {
        level: 'info',
        logSensitiveData: false,
        retentionDays: 30,
        auditEvents: true,
      },
      dataProtection: {
        encryptSensitiveData: true,
        encryptionAlgorithm: 'aes-256-gcm',
        dataRetentionDays: 365,
        backupRequired: true,
        backupEncryption: true,
      },
    };
  }

  /**
   * 加载策略配置
   */
  private loadPolicy(): void {
    try {
      // 确保策略文件路径在项目目录内
      const baseDir = process.cwd();
      const configDir = join(baseDir, 'config');
      
      if (this.policyFile.startsWith(configDir) && existsSync(this.policyFile)) {
        const content = readFileSync(this.policyFile, 'utf8');
        const loadedPolicy = JSON.parse(content);
        this.policy = { ...this.policy, ...loadedPolicy };
      } else {
        this.savePolicy();
      }
    } catch (error) {
      console.warn('无法加载安全策略配置，使用默认配置:', error);
    }
  }

  /**
   * 保存策略配置
   */
  private savePolicy(): void {
    try {
      // 使用固定的、安全的路径
      const baseDir = process.cwd();
      const configDir = join(baseDir, 'config');
      
      // 确保路径在项目目录内
      if (configDir.startsWith(baseDir) && !existsSync(configDir)) {
        require('fs').mkdirSync(configDir, { recursive: true });
      }
      
      // 确保策略文件路径在配置目录内
      if (this.policyFile.startsWith(configDir)) {
        writeFileSync(
          this.policyFile,
          JSON.stringify(this.policy, null, 2),
          'utf8'
        );
      }
    } catch (error) {
      console.error('保存安全策略配置失败:', error);
    }
  }

  /**
   * 获取资源权限
   */
  private getResourcePermissions(resource: string): string[] {
    // 在实际应用中，这里会从配置或数据库中获取权限
    const permissions: Record<string, string[]> = {
      'api-keys': ['read', 'write', 'delete', 'rotate'],
      'files': ['read', 'write', 'delete'],
      'models': ['use', 'configure'],
      'settings': ['read', 'write'],
      'logs': ['read'],
    };

    return permissions[resource] || [];
  }

  /**
   * 检查用户角色
   */
  private hasRequiredRole(userContext: any, resource: string, action: string): boolean {
    // 在实际应用中，这里会检查用户的角色和权限
    // 简化的实现：假设所有认证用户都有基本权限
    return !!userContext?.userId;
  }

  /**
   * 检查输入验证
   */
  private checkInputValidation(data: any, violations: string[]): void {
    const policy = this.policy.inputValidation;

    if (typeof data === 'string') {
      if (data.length > policy.maxInputLength) {
        violations.push(`输入长度超过限制 (${data.length} > ${policy.maxInputLength})`);
      }

      // 检查HTML内容
      if (!policy.allowHtml && /<[^>]*>/g.test(data)) {
        violations.push('检测到HTML内容');
      }
    }
  }

  /**
   * 检查文件系统安全
   */
  private checkFileSystemSecurity(data: any, violations: string[]): void {
    const policy = this.policy.fileSystem;

    if (data?.filePath) {
      // 检查文件扩展名
      const ext = data.filePath.split('.').pop()?.toLowerCase();
      const extWithDot = ext ? `.${ext}` : '';
      
      if (!policy.allowedExtensions.some(allowed => 
        allowed === extWithDot || allowed === ext
      )) {
        violations.push(`不支持的文件扩展名: ${extWithDot}`);
      }

      // 检查文件大小
      if (data.fileSize && data.fileSize > policy.maxFileSize) {
        violations.push(`文件大小超过限制 (${data.fileSize} > ${policy.maxFileSize})`);
      }
    }
  }

  /**
   * 检查网络安全
   */
  private checkNetworkSecurity(data: any, violations: string[]): void {
    const policy = this.policy.network;

    if (data?.url) {
      try {
        const url = new URL(data.url);
        
        // 检查HTTPS
        if (policy.requireHttps && url.protocol !== 'https:') {
          violations.push('只允许HTTPS连接');
        }

        // 检查主机白名单
        if (policy.allowedHosts.length > 0 && 
            !policy.allowedHosts.includes(url.hostname)) {
          violations.push(`主机不在允许列表中: ${url.hostname}`);
        }
      } catch (error) {
        violations.push('无效的URL格式');
      }
    }
  }

  /**
   * 检查提示词安全
   */
  private checkPromptSecurity(data: any, violations: string[]): void {
    const policy = this.policy.promptSecurity;

    if (data?.prompt && typeof data.prompt === 'string') {
      if (data.prompt.length > policy.maxPromptLength) {
        violations.push(`提示词长度超过限制 (${data.prompt.length} > ${policy.maxPromptLength})`);
      }

      // 在实际应用中，这里可以调用提示词安全检测工具
      // const injection = PromptSecurity.detectPromptInjection(data.prompt);
      // if (injection.isInjection) {
      //   violations.push('检测到潜在的提示词注入攻击');
      // }
    }
  }

  /**
   * 应用输入验证
   */
  private applyInputValidation(data: any): any {
    if (typeof data === 'string' && this.policy.inputValidation.sanitizeInput) {
      // 在实际应用中，这里会调用输入净化工具
      // return this.sanitizeInput(data);
      return data.replace(/[<>]/g, ''); // 简单示例
    }
    return data;
  }

  /**
   * 应用数据保护
   */
  private applyDataProtection(data: any): any {
    if (this.policy.dataProtection.encryptSensitiveData) {
      return ConfigEncryptor.encryptConfig(data);
    }
    return data;
  }

  /**
   * 应用日志策略
   */
  private applyLoggingPolicy(data: any): any {
    if (!this.policy.logging.logSensitiveData) {
      // 在实际应用中，这里会调用错误处理工具来脱敏数据
      // return ErrorHandler.sanitizeError(JSON.stringify(data));
      return '[SENSITIVE_DATA_REDACTED]';
    }
    return data;
  }
}

// 创建全局策略管理器实例
export const securityPolicyManager = SecurityPolicyManager.getInstance();

// 策略应用装饰器
export function ApplySecurityPolicy(policyType: keyof SecurityPolicy) {
  return function(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = function(...args: any[]) {
      // 应用安全策略
      const processedArgs = args.map(arg => 
        securityPolicyManager.applyPolicy(arg, policyType)
      );

      // 执行原方法
      const result = originalMethod.apply(this, processedArgs);

      // 应用安全策略到返回值
      return securityPolicyManager.applyPolicy(result, policyType);
    };
  };
}

// 权限检查装饰器
export function RequirePermission(resource: string, action: string) {
  return function(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = function(...args: any[]) {
      // 获取用户上下文（假设从第一个参数或this获取）
      const userContext = args[0]?.userContext || (this as any)?.userContext;
      
      const access = securityPolicyManager.validateAccess(resource, action, userContext);
      if (!access.allowed) {
        throw new Error(`访问被拒绝: ${access.reason}`);
      }

      return originalMethod.apply(this, args);
    };
  };
}