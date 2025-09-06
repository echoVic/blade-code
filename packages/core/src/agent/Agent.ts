/**
 * Agent核心类 - 简化架构，基于chat统一调用
 * 负责任务执行和上下文管理
 */

import { EventEmitter } from 'events';
import { ChatService, type ChatMessage } from '../services/ChatService.js';
import { ContextCompressor } from './context/Compressor.js';
import { ContextManager } from './context/ContextManager.js';
import type { AgentConfig, AgentResponse, AgentTask } from './types.js';

export interface SubAgentResult {
  agentName: string;
  taskType: string;
  result: unknown;
  executionTime: number;
}

export interface ExecutionStep {
  id: string;
  type: 'llm' | 'tool' | 'subagent';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent核心类 - 简化架构实现
 */
export class Agent extends EventEmitter {
  private config: AgentConfig;
  private isInitialized = false;
  private activeTask?: AgentTask;

  // 核心组件
  private chatService!: ChatService;
  private contextManager!: ContextManager;
  private compressor!: ContextCompressor;

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
      this.compressor = new ContextCompressor(this.config.context);

      // 初始化上下文管理器
      this.contextManager = new ContextManager({
        enabled: true,
        defaultFilter: {
          maxTokens: this.config.context?.maxTokens || 4000,
          maxMessages: this.config.context?.maxMessages || 50,
        },
        storage: {
          compressionEnabled: this.config.context?.compressionEnabled ?? true,
        },
      });
      await this.contextManager.init();

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

      // 准备上下文
      const contextMessages = await this.contextManager.buildMessagesWithContext(task.prompt);

      // 转换消息格式
      const messages: ChatMessage[] = contextMessages.map(msg => ({
        role: msg.role === 'tool' ? 'assistant' : msg.role, // 转换tool角色为assistant
        content: msg.content,
        metadata: msg.metadata,
      }));

      // 调用Chat服务
      const content = await this.chatService.chat(messages);

      // 添加助手回复到上下文
      await this.contextManager.addAssistantMessage(content);

      const response: AgentResponse = {
        taskId: task.id,
        content,
        metadata: {
          executionMode: 'simple',
          taskType: task.type,
        },
      };

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
   * 带系统提示词的聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 创建包含系统提示词的消息列表
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const response = await this.chatService.chat(messages);

    // 添加到上下文
    await this.contextManager.addUserMessage(userMessage);
    await this.contextManager.addAssistantMessage(response);

    return response;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取上下文管理器
   */
  public getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): ChatService {
    return this.chatService;
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    this.log('销毁Agent...');

    try {
      // 销毁核心组件
      if (this.contextManager) {
        await this.contextManager.destroy();
      }

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
