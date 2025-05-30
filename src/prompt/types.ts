import type { LLMMessage } from '../llm/BaseLLM.js';

/**
 * 模型提供商类型
 */
export type ModelProvider = 'qwen' | 'volcengine' | 'openai' | 'claude';

/**
 * 角色定义接口
 */
export interface Role {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  restrictions: string[];
  personalityTraits: string[];
  communicationStyle: string;
}

/**
 * Prompt模板接口
 */
export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  variables: PromptVariable[];
  metadata: PromptMetadata;
}

/**
 * Prompt变量定义
 */
export interface PromptVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  defaultValue?: any;
  validation?: VariableValidation;
}

/**
 * 变量验证规则
 */
export interface VariableValidation {
  pattern?: string; // 正则表达式
  minLength?: number;
  maxLength?: number;
  min?: number; // 数字最小值
  max?: number; // 数字最大值
  options?: string[]; // 枚举选项
}

/**
 * Prompt元数据
 */
export interface PromptMetadata {
  createdAt: Date;
  updatedAt: Date;
  version: string;
  author: string;
  tags: string[];
  category: string;
  optimizedFor: ModelProvider[];
}

/**
 * 工作流任务状态
 */
export type TaskStatus = 'todo' | 'in-progress' | 'completed' | 'blocked' | 'cancelled';

/**
 * 工作流任务
 */
export interface WorkflowTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dependencies: string[]; // 依赖的任务ID
  estimatedTime?: number; // 预估时间（分钟）
  actualTime?: number; // 实际时间（分钟）
  tags: string[];
  assignee?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  notes: string[];
}

/**
 * 工作流配置
 */
export interface WorkflowConfig {
  maxConcurrentTasks: number;
  autoSave: boolean;
  trackTime: boolean;
  generateReports: boolean;
  templatePath: string;
}

/**
 * 叙述性更新类型
 */
export type NarrativeType =
  | 'thinking'
  | 'planning'
  | 'action'
  | 'result'
  | 'reflection'
  | 'decision';

/**
 * 叙述性更新条目
 */
export interface NarrativeEntry {
  id: string;
  type: NarrativeType;
  timestamp: Date;
  content: string;
  context?: Record<string, any>;
  metadata: {
    taskId?: string;
    actionType?: string;
    severity?: 'info' | 'warning' | 'error' | 'success';
    tags: string[];
  };
}

/**
 * 模型优化配置
 */
export interface ModelOptimization {
  provider: ModelProvider;
  maxTokens: number;
  temperature: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  promptStrategy: PromptStrategy;
}

/**
 * Prompt策略
 */
export interface PromptStrategy {
  useSystemMessage: boolean;
  instructionFormat: 'direct' | 'conversational' | 'structured';
  contextHandling: 'truncate' | 'summarize' | 'sliding-window';
  responseFormat: 'text' | 'json' | 'markdown' | 'structured';
  chainOfThought: boolean;
  fewShotExamples: boolean;
}

/**
 * Prompt构建选项
 */
export interface PromptBuildOptions {
  role?: Role;
  variables?: Record<string, any>;
  includeWorkflow?: boolean;
  includeNarrative?: boolean;
  modelOptimization?: ModelOptimization;
  customInstructions?: string[];
}

/**
 * 构建结果
 */
export interface PromptBuildResult {
  messages: LLMMessage[];
  metadata: {
    templateId: string;
    roleId?: string;
    variablesUsed: string[];
    optimizedFor: ModelProvider;
    buildTimestamp: Date;
    estimatedTokens: number;
  };
}
