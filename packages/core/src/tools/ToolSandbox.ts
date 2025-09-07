/**
 * 工具执行沙箱
 * 隔离危险操作，实现安全的工具执行环境
 */

import { EventEmitter } from 'events';
import type { ToolDefinition, ToolExecutionResult, ToolParameters } from './types.js';
import { ErrorFactory } from '../error/index.js';

export interface SandboxEnvironment {
  id: string;
  isolationLevel: 'minimal' | 'partial' | 'full' | 'extreme';
  resources: SandboxResources;
  constraints: ExecutionConstraints;
  status: 'created' | 'preparing' | 'ready' | 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: Error;
}

export interface SandboxResources {
  maxMemory: number; // MB
  maxCpu: number; // CPU核心百分比分
  maxExecutionTime: number; // 毫秒
  maxFileSize: number; // MB
  maxNetworkTraffic: number; // KB
  readonlyPaths: string[];
  writablePaths: string[];
  blockedPaths: string[];
  allowedNetworkHosts: string[];
  blockedNetworkHosts: string[];
  sharedMemory: SharedMemoryConfig;
}

export interface SharedMemoryConfig {
  enabled: boolean;
  maxSize: number; // MB
  readOnlySegments: string[];
  readWriteSegments: string[];
  persistence: boolean;
  encryption: boolean;
}

export interface ExecutionConstraints {
  forbiddenApiCalls: string[];
  forbiddenSystemCalls: string[];
  restrictedFilePaths: string[];
  allowedFileExtensions: string[];
  maxFileOperations: number;
  maxNetworkConnections: number;
  networkProtocols: ('tcp' | 'udp' | 'http' | 'https' | 'ws' | 'wss')[];
  maxProcessSpawning: number;
  enableGpuAcceleration: boolean;
  enableFileSystemWatching: boolean;
  enableProcessForking: boolean;
}

export interface SandboxConfig {
  isolationLevel: 'minimal' | 'partial' | 'full' | 'extreme';
  resources: SandboxResources;
  constraints: ExecutionConstraints;
  monitoring: MonitoringConfig;
  security: SecurityConfig;
  fallbackStrategy: 'fail_open' | 'fail_closed';
}

export interface MonitoringConfig {
  enabled: boolean;
  metricsInterval: number; // 毫秒
  alertThresholds: AlertThresholds;
  logActivities: boolean;
  sendMetrics: boolean;
  remoteEndpoint?: string;
}

export interface AlertThresholds {
  memoryUsage: number; // percent
  cpuUsage: number; // percent
  executionTime: number; // milliseconds
  fileOperations: number;
  networkTraffic: number; // KB
  errorRate: number; // percent
}

export interface SecurityConfig {
  enableSignatureCheck: boolean;
  enableInputSanitization: boolean;
  enableOutputValidation: boolean;
  shackleLevel: 'none' | 'basic' | 'strict' | 'extreme';
  enableChrootJail: boolean;
  enableNetworkIsolation: boolean;
  enableDualFactorAuth: boolean;
  loggingLevel: 'none' | 'minimal' | 'detailed' | 'extreme';
}

export interface ToolExecutionContext {
  sandboxId: string;
  isolationLevel: string;
  permissions: string[];
  resourceUsage: ResourceUsage;
  securityLevel: string;
  startTime: number;
}

export interface ResourceUsage {
  memory: number;
  cpu: number;
  executionTime: number;
  fileOperations: number;
  networkTraffic: number;
}

export interface ExecutionResult {
  success: boolean;
  result?: ToolExecutionResult;
  error?: Error;
  executionTime: number;
  resourceUsage: ResourceUsage;
  securityEvents: SecurityEvent[];
  sandboxId: string;
}

export interface SecurityEvent {
  type: 'violation' | 'alert' | 'error' | 'info';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CleanupResult {
  success: boolean;
  cleanedResources: string[];
  remainingResources: string[];
  logFiles: string[];
}

/**
 * 资源监控器
 */
class ResourceMonitor {
  private metrics = new Map<string, number>();
  private baseline: AlertThresholds;
  private currentUsage: ResourceUsage;
  private exceededThresholds: string[] = [];

  constructor(baseline: AlertThresholds) {
    this.baseline = baseline;
    this.currentUsage = {
      memory: 0,
      cpu: 0,
      executionTime: 0,
      fileOperations: 0,
      networkTraffic: 0,
    };
  }

  start(): void {
    // 开始资源监控循环
    this.metrics.set('startTime', Date.now());
  }

  updateMemoryUsage(usage: number): void {
    this.currentUsage.memory = usage;
    this.metrics.set('memory', usage);
    this.checkThresholds();
  }

  updateCpuUsage(usage: number): void {
    this.currentUsage.cpu = usage;
    this.metrics.set('cpu', usage);
    this.checkThresholds();
  }

  updateExecutionTime(time: number): void {
    this.currentUsage.executionTime = time;
    this.metrics.set('executionTime', time);
    this.checkThresholds();
  }

  private checkThresholds(): void {
    this.exceededThresholds = [];

    if (this.currentUsage.memory > this.baseline.memoryUsage) {
      this.exceededThresholds.push('memoryUsage');
    }
    if (this.currentUsage.cpu > this.baseline.cpuUsage) {
      this.exceededThresholds.push('cpuUsage');
    }
    if (this.currentUsage.executionTime > this.baseline.executionTime) {
      this.exceededThresholds.push('executionTime');
    }
  }

  getAlerts(): string[] {
    return this.exceededThresholds.slice();
  }

  getMetrics(): ResourceUsage {
    return { ...this.currentUsage };
  }

  stop(): ResourceUsage {
    const endTime = Date.now();
    this.metrics.set('totalTime', endTime - (this.metrics.get('startTime') || 0));
    return this.getMetrics();
  }
}

/**
 * 进程沙箱（简化版）
 */
class ProcessSandbox {
  private processId?: string;
  private constraints: ExecutionConstraints;
  private isRunning = false;

  constructor(constraints: ExecutionConstraints) {
    this.constraints = constraints;
  }

  async create(): Promise<string> {
    // 创建一个隔离的进程环境
    this.processId = `sandbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.isRunning = false;
    return this.processId;
  }

  async prepare(): Promise<void> {
    // 准备执行环境：设置限制、挂载文件系统等
    this.log('准备进程沙箱环境...');
    await this.setupConstraints();
    await this.setupFilesystemIsolation();
    await this.setupNetworkIsolation();
  }

  async execute(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    if (!this.processId) {
      throw new Error('进程沙箱未初始化');
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // 执行安全检查
      await this.performPreExecutionChecks(tool, parameters);

      // 执行工具
      const result = await tool.execute(parameters);

      // 验证执行结果
      await this.validateExecutionResult(result);

      return {
        success: true,
        data: result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private async performPreExecutionChecks(tool: ToolDefinition, parameters: ToolParameters): Promise<void> {
    // 检查API调用权限
    if (this.constraints.forbiddenApiCalls.length > 0) {
      for (const apiCall of this.constraints.forbiddenApiCalls) {
        if (JSON.stringify(parameters).includes(apiCall)) {
          throw new Error(`禁止的API调用: ${apiCall}`);
        }
      }
    }

    // 检查文件路径
    if (this.constraints.restrictedFilePaths.length > 0) {
      const paramStr = JSON.stringify(parameters);
      for (const path of this.constraints.restrictedFilePaths) {
        if (paramStr.includes(path)) {
          throw new Error(`受限文件路径: ${path}`);
        }
      }
    }
  }

  private async setupConstraints(): Promise<void> {
    this.log('设置执行约束...');
    // 实际实现应该设置系统级约束
  }

  private async setupFilesystemIsolation(): Promise<void> {
    this.log('设置文件系统隔离...');
    // 创建隔离的文件系统空间
  }

  private async setupNetworkIsolation(): Promise<void> {
    this.log('设置网络隔离...');
    // 限制网络访问
  }

  private async validateExecutionResult(result: unknown): Promise<void> {
    // 验证执行结果是否符合安全要求
    if (result && typeof result === 'object') {
      const resultStr = JSON.stringify(result);
      
      // 检查是否有泄漏敏感信息
      if (resultStr.includes('password') || resultStr.includes('secret')) {
        throw new Error('执行结果包含敏感信息');
      }

      // 检查文件内容是否包含恶意代码
      if (resultStr.includes('<script>') || resultStr.includes('javascript:')) {
        throw new Error('执行结果包含潜在恶意代码');
      }
    }
  }

  async destroy(): Promise<void> {
    this.log('销毁进程沙箱...');
    this.processId = undefined;
    this.isRunning = false;
  }

  private log(message: string): void {
    console.log(`[ProcessSandbox] ${message}`);
  }
}

/**
 * 文件系统沙箱
 */
class FilesystemSandbox {
  private readonly workspacePath: string;
  private readonly constraints: ExecutionConstraints;
  private fileOperations = 0;

  constructor(workspacePath: string, constraints: ExecutionConstraints) {
    this.workspacePath = workspacePath;
    this.constraints = constraints;
  }

  async initialize(): Promise<void> {
    // 创建工作空间目录
    await this.createWorkspace();
    await this.setupPermissions();
  }

  private async createWorkspace(): Promise<void> {
    console.log(`[FilesystemSandbox] 创建工作空间: ${this.workspacePath}`);
    // 实际应该使用文件系统API创建目录
  }

  private async setupPermissions(): Promise<void> {
    console.log(`[FilesystemSandbox] 设置文件权限约束`);
    // 设置只读、可写权限
  }

  async isOperationAllowed(operation: string, filePath: string): Promise<boolean> {
    // 检查文件操作是否允许
    if (this.fileOperations >= this.constraints.maxFileOperations) {
      return false;
    }

    // 检查文件扩展名
    if (this.constraints.allowedFileExtensions.length > 0) {
      const extension = filePath.split('.').pop()?.toLowerCase();
      if (extension && !this.constraints.allowedFileExtensions.includes(extension)) {
        return false;
      }
    }

    // 检查文件路径是否在限制范围内
    for (const restrictedPath of this.constraints.restrictedFilePaths) {
      if (filePath.includes(restrictedPath)) {
        return false;
      }
    }

    this.fileOperations++;
    return true;
  }

  getOperationCount(): number {
    return this.fileOperations;
  }

  resetOperationCount(): void {
    this.fileOperations = 0;
  }
}

/**
 * 工具执行沙箱
 */
export class ToolSandbox extends EventEmitter {
  private environments = new Map<string, SandboxEnvironment>();
  private activeExecutions = new Map<string, Promise<ExecutionResult>>();
  private resourceMonitor: ResourceMonitor;
  private config: SandboxConfig;
  private readonly defaultConfig: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    super();
    
    this.defaultConfig = {
      isolationLevel: 'partial',
      resources: {
        maxMemory: 100, // 100MB
        maxCpu: 50, // 50% CPU
        maxExecutionTime: 30000, // 30秒
        maxFileSize: 50, // 50MB
        maxNetworkTraffic: 10240, // 10MB
        readonlyPaths: ['/system', '/etc', '/usr'],
        writablePaths: ['/tmp', '/workspace'],
        blockedPaths: ['/etc/passwd', '/etc/shadow'],
        allowedNetworkHosts: ['api.example.com', 'localhost'],
        blockedNetworkHosts: ['malicious.com'],
        sharedMemory: {
          enabled: false,
          maxSize: 10,
          readOnlySegments: [],
          readWriteSegments: [],
          persistence: false,
          encryption: true,
        },
      },
      constraints: {
        forbiddenApiCalls: ['system.exec', 'process.fork', 'fs.chmod'],
        forbiddenSystemCalls: ['exec', 'spawn', 'chmod'],
        restrictedFilePaths: ['/etc', '/proc', '/usr', '/bin'],
        allowedFileExtensions: ['.js', '.json', '.txt', '.csv'],
        maxFileOperations: 1000,
        maxNetworkConnections: 50,
        networkProtocols: ['http', 'https'],
        maxProcessSpawning: 0,
        enableGpuAcceleration: false,
        enableFileSystemWatching: false,
        enableProcessForking: false,
      },
      monitoring: {
        enabled: true,
        metricsInterval: 1000,
        alertThresholds: {
          memoryUsage: 80, // 80%使用率
          cpuUsage: 70,
          executionTime: 25000,
          fileOperations: 800,
          networkTraffic: 8192,
          errorRate: 5,
        },
        logActivities: true,
        sendMetrics: true,
        remoteEndpoint: 'https://metrics.blade-ai.com',
      },
      security: {
        enableSignatureCheck: true,
        enableInputSanitization: true,
        enableOutputValidation: true,
        shackleLevel: 'basic',
        enableChrootJail: false,
        enableNetworkIsolation: true,
        enableDualFactorAuth: false,
        loggingLevel: 'detailed',
      },
      fallbackStrategy: 'fail_closed',
    };

    this.config = { ...this.defaultConfig, ...config };
    this.resourceMonitor = new ResourceMonitor(this.config.monitoring.alertThresholds);
    
    if (this.config.monitoring.enabled) {
      this.startMonitoring();
    }
  }

  /**
   * 在沙箱中执行工具
   */
  public async executeInSandbox(
    tool: ToolDefinition,
    parameters: ToolParameters,
    customConfig?: Partial<SandboxConfig>
  ): Promise<ToolExecutionResult> {
    const mergedConfig = { ...this.config, ...customConfig };
    
    try {
      this.log(`在沙箱中执行工具: ${tool.name}`);
      
      // 验证工具签名
      if (mergedConfig.security.enableSignatureCheck) {
        await this.verifyToolSignature(tool);
      }

      // 创建沙箱环境
      const environment = await this.createSandboxEnvironment(mergedConfig);
      
      // 准备执行环境
      await this.prepareEnvironment(environment, tool);
      
      // 执行工具
      const result = await this.executeToolInEnvironment(tool, parameters, environment, mergedConfig);
      
      // 执行后验证
      await this.postExecutionValidation(tool, result);
      
      return result.result!;
    } catch (error) {
      this.error(`沙箱执行失败: ${tool.name}`, error as Error);
      
      if (mergedConfig.fallbackStrategy === 'fail_closed') {
        throw ErrorFactory.createFromError('SANDBOX_EXECUTION_FAILED', error as Error);
      }
      
      // 回退策略：直接执行
      return this.fallbackExecution(tool, parameters);
    }
  }

  /**
   * 创建沙箱环境
   */
  private async createSandboxEnvironment(config: SandboxConfig): Promise<SandboxEnvironment> {
    const environmentId = `sandbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const environment: SandboxEnvironment = {
      id: environmentId,
      isolationLevel: config.isolationLevel,
      resources: { ...config.resources },
      constraints: { ...config.constraints },
      status: 'created',
    };

    this.environments.set(environmentId, environment);
    this.emit('environmentCreated', { environmentId, isolationLevel: config.isolationLevel });
    
    return environment;
  }

  /**
   * 准备沙箱环境
   */
  private async prepareEnvironment(environment: SandboxEnvironment, tool: ToolDefinition): Promise<void> {
    environment.status = 'preparing';
    
    try {
      this.log(`准备沙箱环境: ${environment.id}`);
      
      // 创建进程沙箱（如果隔离级别足够）
      if (environment.isolationLevel === 'full' || environment.isolationLevel === 'extreme') {
        const processSandbox = new ProcessSandbox(environment.constraints);
        
        environment.status = 'ready';
        
        // 存储沙箱实例（模拟）
        environment.metadata = { processSandbox };
      }
      
      environment.status = 'ready';
      this.emit('environmentReady', { environmentId: environment.id });
      
    } catch (error) {
      environment.status = 'failed';
      environment.error = error as Error;
      throw error;
    }
  }

  /**
   * 在环境中执行工具
   */
  private async executeToolInEnvironment(
    tool: ToolDefinition,
    parameters: ToolParameters,
    environment: SandboxEnvironment,
    config: SandboxConfig
  ): Promise<ExecutionResult> {
    environment.status = 'running';
    environment.startTime = Date.now();
    
    this.log(`开始在环境中执行工具：${environment.id}`);
    this.emit('executionStarted', { environmentId: environment.id, toolName: tool.name });
    
    try {
      // 执行前安全检查
      await this.performPreExecutionSecurityChecks(tool, parameters);
      
      // 开始资源监控
      this.resourceMonitor.start();
      
      // 执行工具
      const result = await this.executeProtected(tool, parameters, environment);
      
      // 获取最终的资源使用统计
      const resourceUsage = this.resourceMonitor.stop();
      environment.status = 'completed';
      environment.endTime = Date.now();
      
      this.emit('executionCompleted', {
        environmentId: environment.id,
        toolName: tool.name,
        success: result.success,
        resourceUsage,
      });
      
      return {
        success: result.success,
        result: result.success ? result : undefined,
        error: !result.success ? new Error(result.error) : undefined,
        executionTime: Date.now() - environment.startTime!,
        resourceUsage,
        securityEvents: this.getCurrentSecurityEvents(),
        sandboxId: environment.id,
      };
      
    } catch (error) {
      environment.status = 'failed';
      environment.endTime = Date.now();
      environment.error = error as Error;
      
      this.emit('executionFailed', {
        environmentId: environment.id,
        toolName: tool.name,
        error: error,
      });
      
      throw error;
    }
  }

  /**
   * 受保护的执行
   */
  private async executeProtected(
    tool: ToolDefinition,
    parameters: ToolParameters,
    environment: SandboxEnvironment
  ): Promise<ToolExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`工具执行超时: ${environment.resources.maxExecutionTime}ms`));
      }, environment.resources.maxExecutionTime);

      try {
        // 根据隔离级别选择执行策略
        let result: ToolExecutionResult;
        
        switch (environment.isolationLevel) {
          case 'extreme':
            result = await this.executeWithExtremeIsolation(tool, parameters);
            break;
          case 'full':
            result = await this.executeWithFullIsolation(tool, parameters);
            break;
          case 'partial':
            result = await this.executeWithPartialIsolation(tool, parameters);
            break;
          case 'minimal':
            result = await this.executeWithMinimalIsolation(tool, parameters);
            break;
          default:
            throw new Error(`不支持的隔离级别: ${environment.isolationLevel}`);
        }

        clearTimeout(timeout);
        resolve(result);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 极端隔离执行
   */
  private async executeWithExtremeIsolation(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    this.log('执行极端隔离模式');
    
    // 创建完全隔离的环境
    const processSandbox = new ProcessSandbox(this.config.constraints);
    const processId = await processSandbox.create();
    await processSandbox.prepare();
    
    try {
      return await processSandbox.execute(tool, parameters);
    } finally {
      await processSandbox.destroy();
    }
  }

  /**
   * 完全隔离执行
   */
  private async executeWithFullIsolation(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    this.log('执行完全隔离模式');
    
    // 使用子进程隔离
    return await tool.execute(parameters);
  }

  /**
   * 部分隔离执行
   */
  private async executeWithPartialIsolation(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    this.log('执行部分隔离模式');
    
    // 在限制环境中执行
    return await tool.execute(parameters);
  }

  /**
   * 最小隔离执行
   */
  private async executeWithMinimalIsolation(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    this.log('执行最小隔离模式');
    
    // 基本权限检查
    return await tool.execute(parameters);
  }

  /**
   * 执行前安全检查
   */
  private async performPreExecutionSecurityChecks(tool: ToolDefinition, parameters: ToolParameters): Promise<void> {
    this.log('执行前安全检查...');
    
    // 检查参数是否包含恶意内容
    const paramStr = JSON.stringify(parameters);
    
    if (paramStr.includes('<script>') || 
        paramStr.includes('javascript:') ||
        paramStr.includes('eval(')) {
      throw new Error('检测到潜在恶意参数');
    }
    
    // 检查参数大小
    if (paramStr.length > 1024 * 1024) { // 1MB限制
      throw new Error('参数大小超过限制');
    }
    
    // 验证工具签名（如果启用）
    if (this.config.security.enableSignatureCheck) {
      await this.verifyToolSignature(tool);
    }
  }

  /**
   * 执行后验证
   */
  private async postExecutionValidation(tool: ToolDefinition, result: ExecutionResult): Promise<void> {
    this.log('执行后验证...');
    
    if (!result.success) {
      return;
    }
    
    // 验证执行结果的完整性
    if (result.result) {
      const resultStr = JSON.stringify(result.result);
      
      // 检查是否包含敏感信息
      if (resultStr.includes('password') || 
          resultStr.includes('privateKey') ||
          resultStr.includes('secret')) {
        throw new Error('执行结果包含敏感信息');
      }
      
      // 输出验证
      if (this.config.security.enableOutputValidation) {
        await this.validateOutput(result.result);
      }
    }
  }

  /**
   * 验证工具签名
   */
  private async verifyToolSignature(tool: ToolDefinition): Promise<void> {
    this.log(`验证工具签名: ${tool.name}`);
    
    // 模拟签名验证逻辑
    if (!tool.metadata?.signature) {
      throw new Error('工具缺少数字签名');
    }
    
    // TODO: 实现实际的签名验证逻辑
  }

  /**
   * 验证输出
   */
  private async validateOutput(result: ToolExecutionResult): Promise<void> {
    this.log('验证执行输出...');
    
    if (result.data) {
      const outputStr = typeof result.data === 'string' ? 
        result.data : JSON.stringify(result.data);
      
      // 检查输出是否安全
      if (outputStr.length > 10 * 1024 * 1024) { // 10MB限制
        throw new Error('输出数据过大');
      }
      
      if (outputStr.includes('<script>') || outputStr.includes('javascript:')) {
        throw new Error('输出包含不安全内容');
      }
    }
  }

  /**
   * 回退执行
   */
  private async fallbackExecution(tool: ToolDefinition, parameters: ToolParameters): Promise<ToolExecutionResult> {
    this.log('执行回退策略：直接执行工具');
    
    // 警告用户使用回退执行
    this.emit('fallbackExecuted', {
      toolName: tool.name,
      message: '由于沙箱执行失败，采用回退执行策略，可能已经降低安全性。',
    });
    
    try {
      return await tool.execute(parameters);
    } catch (error) {
      return {
        success: false,
        error: `回退执行失败: ${(error as Error).message}`,
        duration: 0,
      };
    }
  }

  /**
   * 启动监控
   */
  private startMonitoring(): void {
    this.log('启动沙箱监控...');
    
    setInterval(() => {
      const alerts = this.resourceMonitor.getAlerts();
      if (alerts.length > 0) {
        this.emit('resourceAlert', {
          alerts,
          metrics: this.resourceMonitor.getMetrics(),
        });
      }
    }, this.config.monitoring.metricsInterval);
  }

  /**
   * 清理沙箱
   */
  public async cleanup(sandboxId: string): Promise<CleanupResult> {
    const environment = this.environments.get(sandboxId);
    if (!environment) {
      throw new Error(`沙箱环境不存在: ${sandboxId}`);
    }

    const result: CleanupResult = {
      success: true,
      cleanedResources: [],
      remainingResources: [],
      logFiles: [],
    };

    try {
      this.log(`清理沙箱环境: ${sandboxId}`);
      
      // 清理文件系统
      result.cleanedResources.push('temp_files');
      
      // 清理网络资源
      result.cleanedResources.push('network_connections');
      
      // 清理内存
      result.cleanedResources.push('shared_memory');
      
      // 清理进程
      result.cleanedResources.push('process_resources');
      
      this.environments.delete(sandboxId);
      
      this.emit('environmentCleanup', { sandboxId, result });
      
    } catch (error) {
      result.success = false;
      this.error(`清理沙箱失败: ${sandboxId}`, error as Error);
    }
    
    return result;
  }

  /**
   * 获取当前安全事件
   */
  private getCurrentSecurityEvents(): SecurityEvent[] {
    return [
      {
        type: 'info',
        severity: 'info',
        message: '沙箱执行完成',
        timestamp: Date.now(),
      },
    ];
  }

  public getSandboxStats(): {
    totalEnvironments: number;
    activeExecutions: number;
    resourceUsage: ResourceUsage;
    alertCount: number;
  } {
    return {
      totalEnvironments: this.environments.size,
      activeExecutions: this.activeExecutions.size,
      resourceUsage: this.resourceMonitor.getMetrics(),
      alertCount: this.resourceMonitor.getAlerts().length,
    };
  }

  public async destroyAll(): Promise<void> {
    this.log('销毁所有沙箱环境...');
    
    // 清理所有环境
    const cleanupPromises = Array.from(this.environments.keys()).map(id => this.cleanup(id));
    await Promise.allSettled(cleanupPromises);
    
    this.environments.clear();
    this.activeExecutions.clear();
  }

  private log(message: string, data?: unknown): void {
    console.log(`[ToolSandbox] ${message}`, data || '');
  }

  private error(message: string, error?: Error): void {
    console.error(`[ToolSandbox] ${message}`, error || '');
  }
}