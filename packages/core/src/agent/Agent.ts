/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { ChatService, type Message } from '../services/ChatService.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import type { AgentConfig, AgentResponse, AgentTask } from './types.js';

export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;

  // 核心组件
  private chatService!: ChatService;
  private executionEngine!: ExecutionEngine;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
  }

  /**
   * 初始化Agent
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化Agent...');

      // 初始化核心组件
      this.chatService = new ChatService(this.config.chat);

      // 初始化执行引擎
      this.executionEngine = new ExecutionEngine(this.chatService, this.config);

      this.isInitialized = true;
      this.log('Agent初始化完成');
      this.emit('initialized');
    } catch (error) {
      this.error('Agent初始化失败', error);
      throw error;
    }
  }

  /**
   * 执行任务
   */
  public async executeTask(task: AgentTask): Promise<AgentResponse> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    this.activeTask = task;
    this.emit('taskStarted', task);

    try {
      this.log(`开始执行任务: ${task.id}`);

      // 根据任务类型选择执行策略
      let response: AgentResponse;

      if (task.type === 'parallel') {
        // 并行子Agent执行
        response = await this.executionEngine.executeParallelTask(task);
      } else if (task.type === 'steering') {
        // 隐式压束执行
        response = await this.executionEngine.executeSteeringTask(task);
      } else {
        // 默认简单执行
        response = await this.executionEngine.executeSimpleTask(task);
      }

      this.activeTask = undefined;
      this.emit('taskCompleted', task, response);
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.emit('taskFailed', task, error);
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 简单聊天接口
   */
  public async chat(message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: message,
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  /**
   * 带系统提示的聊天接口
   */
  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: message,
      context: { systemPrompt },
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): ChatService {
    return this.chatService;
  }

  /**
   * 获取Agent状态统计
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        chatService: this.chatService ? 'ready' : 'not_loaded',
        executionEngine: this.executionEngine ? 'ready' : 'not_loaded',
      },
    };
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    this.log('销毁Agent...');

    try {
      this.removeAllListeners();
      this.isInitialized = false;
      this.log('Agent已销毁');
    } catch (error) {
      this.error('Agent销毁失败', error);
      throw error;
    }
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 日志记录
   */
  private log(message: string, data?: unknown): void {
    console.log(`[MainAgent] ${message}`, data || '');
  }

  /**
   * 错误记录
   */
  private error(message: string, error?: unknown): void {
    console.error(`[MainAgent] ${message}`, error || '');
  }
}