/**
 * 错误处理系统与配置系统集成示例
 */

import { ConfigManager } from '../config/ConfigManager.js';
import { 
  ErrorFactory, 
  globalErrorMonitor,
  type ErrorMonitoringConfig
} from '../error/index.js';

/**
 * 增强版配置管理器，集成错误处理
 */
export class EnhancedConfigManager extends ConfigManager {
  private errorMonitoringConfig: ErrorMonitoringConfig;

  constructor() {
    super();
    
    // 从配置中获取错误监控设置
    this.errorMonitoringConfig = this.getErrorMonitoringConfig();
    
    // 配置全局错误监控器
    if (this.errorMonitoringConfig.enabled) {
      globalErrorMonitor['config'] = {
        ...globalErrorMonitor['config'],
        ...this.errorMonitoringConfig
      };
    }
  }

  private getErrorMonitoringConfig(): ErrorMonitoringConfig {
    return {
      enabled: this.get('errorMonitoringEnabled') ?? true,
      sampleRate: this.get('errorSampleRate') ?? 1.0,
      maxErrorsPerMinute: this.get('maxErrorsPerMinute') ?? 100,
      excludePatterns: this.get('errorExcludePatterns') ?? [],
      includePatterns: this.get('errorIncludePatterns') ?? [],
      autoReport: this.get('autoErrorReport') ?? false,
      storeReports: this.get('storeErrorReports') ?? true,
      maxStoredReports: this.get('maxStoredErrorReports') ?? 1000,
      enableConsole: this.get('enableErrorConsole') ?? true,
      enableFile: this.get('enableErrorFile') ?? false,
      logFilePath: this.get('errorLogPath') ?? undefined
    };
  }

  /**
   * 重写加载用户配置方法，添加错误处理
   */
  protected loadUserConfig(): void {
    const configPath = this.get('userConfigPath') || '.blade/config.json';
    
    try {
      super.loadUserConfig();
      
      // 记录配置加载成功
      if (this.errorMonitoringConfig.enabled && this.errorMonitoringConfig.enableConsole) {
        console.info(`[配置] 成功加载用户配置: ${configPath}`);
      }
    } catch (error) {
      const configError = ErrorFactory.createConfigError(
        'CONFIG_LOAD_FAILED',
        `用户配置加载失败: ${configPath}`,
        {
          context: { configPath, error: error instanceof Error ? error.message : String(error) },
          retryable: false,
          recoverable: true,
          suggestions: [
            '检查配置文件路径是否正确',
            '确认配置文件格式是否有效',
            '检查文件读取权限'
          ]
        }
      );
      
      globalErrorMonitor.monitor(configError);
      
      // 如果是关键配置加载失败，抛出错误
      if (this.isCriticalConfigPath(configPath)) {
        throw configError;
      }
      
      console.warn(`[警告] 用户配置加载失败，使用默认配置: ${configError.message}`);
    }
  }

  /**
   * 重写加载项目配置方法，添加错误处理
   */
  protected loadProjectConfig(): void {
    try {
      super.loadProjectConfig();
      
      if (this.errorMonitoringConfig.enabled && this.errorMonitoringConfig.enableConsole) {
        console.info('[配置] 成功加载项目配置');
      }
    } catch (error) {
      const configError = ErrorFactory.createConfigError(
        'CONFIG_LOAD_FAILED',
        '项目配置加载失败',
        {
          context: { error: error instanceof Error ? error.message : String(error) },
          retryable: false,
          recoverable: true,
          suggestions: [
            '检查项目配置文件格式',
            '确认项目配置文件权限',
            '验证配置文件内容'
          ]
        }
      );
      
      globalErrorMonitor.monitor(configError);
      console.warn(`[警告] 项目配置加载失败: ${configError.message}`);
    }
  }

  /**
   * 重写配置更新方法，添加验证和错误处理
   */
  updateConfig(updates: Partial<any>): void {
    try {
      // 验证更新配置
      const validationErrors = this.validateConfig(updates);
      if (validationErrors.length > 0) {
        const validationError = ErrorFactory.createConfigError(
          'CONFIG_VALIDATION_FAILED',
          '配置更新验证失败',
          {
            context: { updates, validationErrors: validationErrors.map(e => e.message) },
            severity: 'WARNING' as any,
            retryable: false,
            suggestions: [
              '检查配置项类型是否正确',
              '确认必需配置项是否提供',
              '查看配置文档了解正确格式'
            ]
          }
        );
        
        globalErrorMonitor.monitor(validationError);
        console.warn(`[配置验证警告] ${validationError.message}`);
      }
      
      super.updateConfig(updates);
      
      if (this.errorMonitoringConfig.enabled && this.errorMonitoringConfig.enableConsole) {
        console.info('[配置] 配置更新成功');
      }
    } catch (error) {
      const configError = ErrorFactory.createConfigError(
        'CONFIG_SAVE_FAILED',
        '配置更新失败',
        {
          context: { updates, error: error instanceof Error ? error.message : String(error) },
          retryable: true,
          suggestions: [
            '重试配置更新操作',
            '检查配置存储权限',
            '确认配置格式正确'
          ]
        }
      );
      
      globalErrorMonitor.monitor(configError);
      throw configError;
    }
  }

  /**
   * 判断是否为关键配置路径
   */
  private isCriticalConfigPath(configPath: string): boolean {
    // 可以根据业务需求定义关键配置路径
    const criticalPaths = [
      'system-config.json',
      'security-config.json',
      'database-config.json'
    ];
    
    return criticalPaths.some(criticalPath => configPath.includes(criticalPath));
  }

  /**
   * 获取配置加载统计
   */
  getConfigLoadStats(): {
    totalLoads: number;
    successfulLoads: number;
    failedLoads: number;
    lastError?: string;
  } {
    // 这里应该实现实际的统计逻辑
    // 暂时返回示例数据
    return {
      totalLoads: 1,
      successfulLoads: 1,
      failedLoads: 0
    };
  }
}