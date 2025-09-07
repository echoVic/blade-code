/**
 * 统一工具调度系统
 * 借鉴Gemini CLI的智能工具调度器，支持依赖关系分析和并发控制
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolCallRequest,
  type ToolCallResponse,
  ToolExecutionError,
  ToolRegistrationError,
} from './types.js';
import { ToolValidator } from './validator.js';

export interface DependencyGraph {
  nodes: Map<string, ToolNode>;
  edges: DependencyEdge[];
}

export interface ToolNode {
  tool: ToolDefinition;
  dependencies: string[];
  dependents: string[];
  executionOrder: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'depends_on' | 'conflicts_with' | 'supports';
  metadata?: Record<string, unknown>;
}

export interface ExecutionPlan {
  stages: ExecutionStage[];
  totalStages: number;
  estimatedDuration: number;
  toolCount: number;
  parallelGroups: string[][];
}

export interface ExecutionStage {
  stageNumber: number;
  tools: PlannedTool[];
  parallelism: number;
  estimatedDuration: number;
  dependencies: string[];
}

export interface PlannedTool {
  toolName: string;
  tool: ToolDefinition;
  parameters: Record<string, unknown>;
  priority: number;
  timeout: number;
  retryCount: number;
}

export interface SchedulingOptions {
  maxParallelism?: number;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  priorityBoost?: Record<string, number>;
  dependencyAnalysis?: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelay: number;
  backoffMultiplier: number;
  maxDelay: number;
  retryableErrors: string[];
}

export interface ToolSchedulerConfig {
  maxConcurrentTools?: number;
  maxExecutionTime?: number;
  defaultTimeout?: number;
  enableDependencyAnalysis?: boolean;
  enableRetryMechanism?: boolean;
  debug?: boolean;
}

export interface ToolCategory {
  name: string;
  tools: ToolDefinition[];
  priority: number;
  description: string;
}

/**
 * 统一工具调度器 - 实现智能工具调度和依赖管理
 */
export class UnifiedToolScheduler extends EventEmitter {
  private tools = new Map<string, ToolDefinition>();
  private toolStates = new Map<string, { enabled: boolean; permissions: string[]; priority: number }>();
  private toolCategories = new Map<string, ToolCategory>();
  private dependencyGraph: DependencyGraph = {
    nodes: new Map(),
    edges: [],
  };
  private activeExecutions = new Map<string, Promise<ToolExecutionResult>>();
  private executionHistory: ToolExecutionHistory[] = [];
  private config: Required<ToolSchedulerConfig>;

  constructor(config: ToolSchedulerConfig = {}) {
    super();

    this.config = {
      maxConcurrentTools: config.maxConcurrentTools ?? 10,
      maxExecutionTime: config.maxExecutionTime ?? 300000, // 5分钟
      defaultTimeout: config.defaultTimeout ?? 30000, // 30秒
      enableDependencyAnalysis: config.enableDependencyAnalysis ?? true,
      enableRetryMechanism: config.enableRetryMechanism ?? true,
      debug: config.debug ?? false,
    };

    this.log('统一工具调度器已初始化', { config: this.config });
    this.initializeBuiltinCategories();
  }

  /**
   * 注册工具到调度器
   */
  public async registerTool(tool: ToolDefinition, priority = 50): Promise<void> {
    try {
      this.validateToolDefinition(tool);

      // 检查工具是否已存在
      if (this.tools.has(tool.name)) {
        throw new ToolRegistrationError(`工具 "${tool.name}" 已存在`);
      }

      // 注册工具
      this.tools.set(tool.name, tool);
      this.toolStates.set(tool.name, {
        enabled: true,
        permissions: [],
        priority,
      });

      // 添加到相应的分类
      this.addToolToCategory(tool);

      // 更新依赖图
      if (this.config.enableDependencyAnalysis) {
        this.updateDependencyGraph();
      }

      this.log(`工具 "${tool.name}" 注册成功`, {
        category: tool.category,
        priority,
        version: tool.version,
      });

      this.emit('toolRegistered', { toolName: tool.name, tool, priority });
    } catch (error) {
      this.log(`工具 "${tool.name}" 注册失败`, { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 批量调度工具执行
   */
  public async scheduleToolExecution(
    requests: ToolCallRequest[],
    context: ToolExecutionContext,
    options?: SchedulingOptions
  ): Promise<ToolCallResponse[]> {
    const startTime = Date.now();
    
    try {
      this.log(`开始批量调度 ${requests.length} 个工具`);

      // 创建执行计划
      const executionPlan = await this.createExecutionPlan(requests, options);
      
      // 执行计划
      const results = await this.executeExecutionPlan(executionPlan, context, options);

      const totalDuration = Date.now() - startTime;
      this.log(`工具批量执行完成`, {
        totalDuration,
        toolCount: requests.length,
        successCount: results.filter(r => r.result.success).length,
      });

      return results;
    } catch (error) {
      this.error(`工具批量执行失败`, error as Error);
      throw error;
    }
  }

  /**
   * 创建智能执行计划
   */
  private async createExecutionPlan(
    requests: ToolCallRequest[],
    options?: SchedulingOptions
  ): Promise<ExecutionPlan> {
    const maxConcurrency = options?.maxParallelism ?? this.config.maxConcurrentTools;
    
    // 验证和准备工具请求
    const plannedTools: PlannedTool[] = [];
    for (const request of requests) {
      const tool = this.tools.get(request.toolName);
      if (!tool) {
        throw new ToolRegistrationError(`工具 "${request.toolName}" 未注册`);
      }

      if (!this.isToolEnabled(request.toolName)) {
        throw new ToolExecutionError(`工具 "${request.toolName}" 已禁用`, request.toolName);
      }

      // 处理参数
      const processedParams = ToolValidator.applyDefaults(request.parameters, tool.parameters);
      ToolValidator.sanitizeParameters(processedParams, tool.parameters);
      ToolValidator.validateParameters(processedParams, tool.parameters, tool.required);

      const toolState = this.toolStates.get(request.toolName)!;
      plannedTools.push({
        toolName: request.toolName,
        tool,
        parameters: processedParams,
        priority: options?.priorityBoost?.[request.toolName] ?? toolState.priority,
        timeout: options?.timeout ?? this.config.defaultTimeout,
        retryCount: 0,
      });
    }

    // 排序（按优先级和依赖关系）
    const sortedTools = this.sortToolsForExecution(plannedTools);

    // 构建执行阶段
    const stages: ExecutionStage[] = [];
    let currentStage: ExecutionStage = {
      stageNumber: 1,
      tools: [],
      parallelism: 0,
      estimatedDuration: 0,
      dependencies: [],
    };

    for (let i = 0; i < sortedTools.length; i++) {
      const plannedTool = sortedTools[i];
      const canParallel = this.canExecuteInParallel(plannedTool, currentStage.tools);

      if (canParallel && currentStage.tools.length < maxConcurrency) {
        currentStage.tools.push(plannedTool);
        currentStage.parallelism = Math.max(currentStage.parallelism, currentStage.tools.length);
      } else {
        if (currentStage.tools.length > 0) {
          stages.push({ ...currentStage });
        }

        currentStage = {
          stageNumber: stages.length + 1,
          tools: [plannedTool],
          parallelism: 1,
          estimatedDuration: this.estimateToolDuration(plannedTool),
          dependencies: stages.length > 0 ? stages[stages.length - 1].tools.map(t => t.toolName) : [],
        };
      }
    }

    if (currentStage.tools.length > 0) {
      stages.push(currentStage);
    }

    // 计算并行组
    const parallelGroups = this.identifyParallelGroups(stages);

    return {
      stages,
      totalStages: stages.length,
      estimatedDuration: stages.reduce((sum, stage) => sum + stage.estimatedDuration, 0),
      toolCount: plannedTools.length,
      parallelGroups,
    };
  }

  /**
   * 执行执行计划
   */
  private async executeExecutionPlan(
    plan: ExecutionPlan,
    context: ToolExecutionContext,
    options?: SchedulingOptions
  ): Promise<ToolCallResponse[]> {
    const allResults: ToolCallResponse[] = [];

    for (const stage of plan.stages) {
      this.log(`执行阶段 ${stage.stageNumber}/${plan.totalStages}`, {
        toolCount: stage.tools.length,
        parallelism: stage.parallelism,
      });

      const stageResults = await this.executeStage(stage, context, options);
      allResults.push(...stageResults);

      // 检查是否有失败
      const failedResults = stageResults.filter(r => !r.result.success);
      if (failedResults.length > 0 && !this.shouldContinueOnFailure(failedResults, options)) {
        this.log(`阶段 ${stage.stageNumber} 有 ${failedResults.length} 个执行失败，中止后续执行`);
        break;
      }
    }

    return allResults;
  }

  /**
   * 执行单个阶段
   */
  private async executeStage(
    stage: ExecutionStage,
    context: ToolExecutionContext,
    options?: SchedulingOptions
  ): Promise<ToolCallResponse[]> {
    const stagePromises: Promise<ToolCallResponse>[] = [];

    for (const plannedTool of stage.tools) {
      const stageContext: ToolExecutionContext = {
        ...context,
        stageNumber: stage.stageNumber,
        estimatedDuration: plannedTool.timeout,
      };

      const executionPromise = this.executeToolWithRetry(plannedTool, stageContext, options);
      stagePromises.push(executionPromise);
    }

    return Promise.all(stagePromises);
  }

  /**
   * 执行工具（带重试机制）
   */
  private async executeToolWithRetry(
    plannedTool: PlannedTool,
    context: ToolExecutionContext,
    options?: SchedulingOptions
  ): Promise<ToolCallResponse> {
    const requestId = randomUUID();
    const startTime = Date.now();

    const request: ToolCallRequest = {
      toolName: plannedTool.toolName,
      parameters: plannedTool.parameters,
      context,
    };

    const retryPolicy = options?.retryPolicy || {
      maxAttempts: 3,
      initialDelay: 1000,
      backoffMultiplier: 2,
      maxDelay: 30000,
      retryableErrors: ['timeout', 'network', 'rate_limit'],
    };

    let lastError: Error | undefined;
    let attempts = 0;

    while (attempts < retryPolicy.maxAttempts) {
      try {
        attempts++;
        this.log(`尝试执行工具 "${plannedTool.toolName}" (第${attempts}次)`);

        const result = await this.executeSingleTool(request, plannedTool, requestId);

        if (result.success) {
          if (attempts > 1) {
            this.log(`工具 "${plannedTool.toolName}" 在重试后成功`);
          }
          return result;
        } else {
          throw new Error(`工具执行失败: ${result.error}`);
        }
      } catch (error) {
        lastError = error as Error;
        this.log(`工具 "${plannedTool.toolName}" 执行失败 (第${attempts}次)`, { error: lastError.message });

        if (attempts >= retryPolicy.maxAttempts || !this.shouldRetryError(error as Error, retryPolicy)) {
          break;
        }

        // 计算延迟
        const delay = Math.min(
          retryPolicy.initialDelay * Math.pow(retryPolicy.backoffMultiplier, attempts - 1),
          retryPolicy.maxDelay
        );

        this.log(`等待 ${delay}ms 后重试`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // 所有重试都失败
    const errorResponse: ToolCallResponse = {
      requestId,
      toolName: plannedTool.toolName,
      result: {
        success: false,
        error: lastError?.message || '执行失败',
        duration: Date.now() - startTime,
      },
      context,
    };

    this.emit('toolCallFailed', errorResponse);
    return errorResponse;
  }

  /**
   * 执行单个工具
   */
  private async executeSingleTool(
    request: ToolCallRequest,
    plannedTool: PlannedTool,
    requestId: string
  ): Promise<ToolCallResponse> {
    const startTime = Date.now();

    try {
      // 检查并发限制
      if (this.activeExecutions.size >= this.config.maxConcurrentTools) {
        throw new ToolExecutionError('达到最大并发工具执行限制', plannedTool.toolName);
      }

      this.log(`开始执行工具 "${plannedTool.toolName}"`);

      this.emit('toolCallStarted', {
        requestId,
        toolName: plannedTool.toolName,
        parameters: plannedTool.parameters,
        context: request.context,
      });

      // 创建执行Promise并设置超时
      const executionPromise = this.executeToolWithTimeout(plannedTool);
      this.activeExecutions.set(requestId, executionPromise);

      const result = await executionPromise;
      result.duration = Date.now() - startTime;

      const response: ToolCallResponse = {
        requestId,
        toolName: plannedTool.toolName,
        result,
        context: request.context,
      };

      // 记录历史
      this.addToHistory({
        executionId: requestId,
        toolName: plannedTool.toolName,
        parameters: plannedTool.parameters,
        result,
        context: request.context,
        createdAt: new Date(),
      });

      this.emit('toolCallCompleted', response);
      return response;
    } catch (error) {
      const result: ToolExecutionResult = {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };

      const response: ToolCallResponse = {
        requestId,
        toolName: plannedTool.toolName,
        result,
        context: request.context,
      };

      this.emit('toolCallFailed', { ...response, error });
      return response;
    } finally {
      this.activeExecutions.delete(requestId);
    }
  }

  /**
   * 分析工具依赖关系
   */
  private analyzeToolDependencies(tools: ToolDefinition[]): DependencyGraph {
    const graph: DependencyGraph = {
      nodes: new Map(),
      edges: [],
    };

    // 创建节点
    for (const tool of tools) {
      const node: ToolNode = {
        tool,
        dependencies: tool.dependencies || [],
        dependents: [],
        executionOrder: 0,
      };
      graph.nodes.set(tool.name, node);
    }

    // 创建边（依赖关系）
    for (const tool of tools) {
      if (tool.dependencies) {
        for (const depName of tool.dependencies) {
          const edge: DependencyEdge = {
            from: depName,
            to: tool.name,
            type: 'depends_on',
          };
          graph.edges.push(edge);

          // 更新幸存者关系
          const depNode = graph.nodes.get(depName);
          const toolNode = graph.nodes.get(tool.name);
          if (depNode && toolNode) {
            depNode.dependents.push(tool.name);
            toolNode.dependencies.push(depName);
          }
        }
      }
    }

    return graph;
  }

  /**
   * 工具排序（拓扑排序）
   */
  private sortToolsForExecution(plannedTools: PlannedTool[]): PlannedTool[] {
    if (!this.config.enableDependencyAnalysis) {
      // 不启用依赖分析时按优先级排序
      return plannedTools.sort((a, b) => b.priority - a.priority);
    }

    // 获取相关工具定义
    const toolDefs = plannedTools.map(pt => pt.tool);
    const dependencyGraph = this.analyzeToolDependencies(toolDefs);

    // 执行拓扑排序
    const sortedToolNames = this.topologicalSort(dependencyGraph);

    // 按排序结果重新排列工具
    const toolMap = new Map(plannedTools.map(pt => [pt.toolName, pt]));
    const sortedTools: PlannedTool[] = [];

    for (const toolName of sortedToolNames) {
      const plannedTool = toolMap.get(toolName);
      if (plannedTool) {
        sortedTools.push(plannedTool);
      }
    }

    return sortedTools;
  }

  /**
   * 拓扑排序实现
   */
  private topologicalSort(graph: DependencyGraph): string[] {
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeName: string) => {
      if (visiting.has(nodeName)) {
        throw new Error(`检测到循环依赖: ${nodeName}`);
      }
      if (visited.has(nodeName)) {
        return;
      }

      visiting.add(nodeName);
      const node = graph.nodes.get(nodeName);
      if (node) {
        for (const dep of node.dependencies) {
          visit(dep);
        }
      }
      visiting.delete(nodeName);

      visited.add(nodeName);
      sorted.push(nodeName);
    };

    for (const [nodeName] of graph.nodes) {
      visit(nodeName);
    }

    return sorted;
  }

  /**
   * 判断工具是否可并行执行
   */
  private canExecuteInParallel(plannedTool: PlannedTool, currentStageTools: PlannedTool[]): boolean {
    // 检查资源冲突
    for (const currentTool of currentStageTools) {
      if (this.hasResourceConflict(plannedTool, currentTool)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 检查资源冲突
   */
  private hasResourceConflict(tool1: PlannedTool, tool2: PlannedTool): boolean {
    // 资源冲突判断逻辑（根据实际情况扩展）
    const resourceTags1 = tool1.tool.metadata?.resources || [];
    const resourceTags2 = tool2.tool.metadata?.resources || [];

    return resourceTags1.some((resource: string) => resourceTags2.includes(resource));
  }

  /**
   * 计算工具执行时间估计
   */
  private estimateToolDuration(plannedTool: PlannedTool): number {
    // 基于历史数据或工具元数据估算执行时间
    const executionTime = plannedTool.tool.metadata?.executionTime || 1000; // 默认1秒
    const retryMultiplier = plannedTool.retryCount > 0 ? 1.5 : 1;
    
    return executionTime * retryMultiplier;
  }

  /**
   * 识别并行组
   */
  private identifyParallelGroups(stages: ExecutionStage[]): string[][] {
    const parallelGroups: string[][] = [];
    
    for (const stage of stages) {
      if (stage.tools.length > 1) {
        parallelGroups.push(stage.tools.map(t => t.toolName));
      }
    }

    return parallelGroups;
  }

  /**
   * 判断失败时是否继续执行
   */
  private shouldContinueOnFailure(failedResults: ToolCallResponse[], options?: SchedulingOptions): boolean {
    // 如果设置了忽略失败或失败率较低，可以继续
    const failureRate = failedResults.length / allResults.length;
    const maxFailureRate = 0.3; // 30%的最大失败率

    return failureRate <= maxFailureRate && !options?.strictFailureHandling;
  }

  /**
   * 判断错误是否应该重试
   */
  private shouldRetryError(error: Error, retryPolicy: RetryPolicy): boolean {
    const errorMessage = error.message.toLowerCase();
    return retryPolicy.retryableErrors.some(retryableError =>
      errorMessage.includes(retryableError.toLowerCase())
    );
  }

  /**
   * 执行工具并设超时
   */
  private executeToolWithTimeout(plannedTool: PlannedTool): Promise<ToolExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new ToolExecutionError(`工具执行超时 (${plannedTool.timeout}ms)`, plannedTool.toolName));
      }, plannedTool.timeout);

      Promise.resolve(plannedTool.tool.execute(plannedTool.parameters))
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(new ToolExecutionError(`工具执行错误: ${error.message}`, plannedTool.toolName, error));
        });
    });
  }

  /**
   * 添加工具到分类
   */
  private addToolToCategory(tool: ToolDefinition): void {
    const categoryName = tool.category || 'other';
    
    if (!this.toolCategories.has(categoryName)) {
      this.toolCategories.set(categoryName, {
        name: categoryName,
        tools: [],
        priority: this.getCategoryPriority(categoryName),
        description: this.getCategoryDescription(categoryName),
      });
    }

    const category = this.toolCategories.get(categoryName)!;
    category.tools.push(tool);
  }

  /**
   * 获取分类优先级
   */
  private getCategoryPriority(categoryName: string): number {
    const priorityMap: Record<string, number> = {
      'file_operation': 90,
      'code_analysis': 80,
      'code_generation': 70,
      'data_processing': 60,
      'network': 50,
      'system': 40,
      'other': 10,
    };

    return priorityMap[categoryName] ?? 10;
  }

  /**
   * 获取分类描述
   */
  private getCategoryDescription(categoryName: string): string {
    const descriptionMap: Record<string, string> = {
      'file_operation': '文件操作工具',
      'code_analysis': '代码分析工具',
      'code_generation': '代码生成工具',
      'data_processing': '数据处理工具',
      'network': '网络通信工具',
      'system': '系统工具',
      'other': '其他工具',
    };

    return descriptionMap[categoryName] ?? '未分类工具';
  }

  /**
   * 更新整个依赖图
   */
  private updateDependencyGraph(): void {
    const allTools = Array.from(this.tools.values());
    this.dependencyGraph = this.analyzeToolDependencies(allTools);
  }

  /**
   * 初始化内置分类
   */
  private initializeBuiltinCategories(): void {
    const categories = [
      { name: 'file_operation', priority: 90, description: '文件操作相关工具' },
      { name: 'code_analysis', priority: 80, description: '代码分析和重构工具' },
      { name: 'code_generation', priority: 70, description: '代码生成和模板工具' },
      { name: 'data_processing', priority: 60, description: '数据处理和分析工具' },
      { name: 'network', priority: 50, description: '网络通信和API工具' },
      { name: 'system', priority: 40, description: '系统级操作工具' },
      { name: 'other', priority: 10, description: '其他工具' },
    ];

    for (const category of categories) {
      this.toolCategories.set(category.name, {
        name: category.name,
        tools: [],
        priority: category.priority,
        description: category.description,
      });
    }
  }

  /**
   * 工具定义验证
   */
  private validateToolDefinition(tool: ToolDefinition): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new ToolRegistrationError('工具名称必须是非空字符串');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new ToolRegistrationError('工具描述必须是非空字符串');
    }

    if (!tool.parameters || typeof tool.parameters !== 'object') {
      throw new ToolRegistrationError('工具参数定义必须是对象');
    }

    if (typeof tool.execute !== 'function') {
      throw new ToolRegistrationError('工具执行函数必须是函数');
    }
  }

  /**
   * 启用/禁用工具
   */
  public setToolEnabled(toolName: string, enabled: boolean): void {
    const state = this.toolStates.get(toolName);
    if (!state) {
      throw new ToolRegistrationError(`工具 "${toolName}" 未注册`);
    }

    state.enabled = enabled;
    this.log(`工具 "${toolName}" ${enabled ? '已启用' : '已禁用'}`);
    this.emit('toolStateChanged', { toolName, enabled });
  }

  /**
   * 检查工具是否启用
   */
  public isToolEnabled(toolName: string): boolean {
    const state = this.toolStates.get(toolName);
    return state?.enabled ?? false;
  }

  /**
   * 获取工具分类
   */
  public getToolCategories(): ToolCategory[] {
    return Array.from(this.toolCategories.values())
      .filter(category => category.tools.length > 0)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取调度器统计信息
   */
  public getSchedulerStats(): Record<string, unknown> {
    const categories = this.getToolCategories();
    
    return {
      totalTools: this.tools.size,
      enabledTools: Array.from(this.toolStates.values()).filter(s => s.enabled).length,
      activeExecutions: this.activeExecutions.size,
      executionHistory: this.executionHistory.length,
      toolCategories: categories.map(c => ({
        name: c.name,
        toolCount: c.tools.length,
        priority: c.priority,
      })),
      dependencyGraph: {
        nodeCount: this.dependencyGraph.nodes.size,
        edgeCount: this.dependencyGraph.edges.length,
      },
    };
  }

  /**
   * 添加到执行历史
   */
  private addToHistory(history: ToolExecutionHistory): void {
    this.executionHistory.push(history);

    // 限制历史记录大小
    if (this.executionHistory.length > 5000) {
      this.executionHistory = this.executionHistory.slice(-4000);
    }
  }

  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.log(`[UnifiedToolScheduler] ${message}`, data || '');
    }
  }

  private error(message: string, error?: Error): void {
    console.error(`[UnifiedToolScheduler] ${message}`, error || '');
  }
}