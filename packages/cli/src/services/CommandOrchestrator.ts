/**
 * 命令编排器 - 对接 @blade/core 服务
 * 作为纯粹的流程编排器，调用 core 包的服务来完成业务逻辑
 */

import { Agent, LLMManager, ContextComponent, ToolComponent } from '@blade-ai/core';
import { ConfigService } from '../config/ConfigService.js';

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, any>;
}

export class CommandOrchestrator {
  private static instance: CommandOrchestrator;
  private agent: Agent | null = null;
  private llmManager: LLMManager | null = null;
  private contextComponent: ContextComponent | null = null;
  private toolComponent: ToolComponent | null = null;
  private configService: ConfigService;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): CommandOrchestrator {
    if (!CommandOrchestrator.instance) {
      CommandOrchestrator.instance = new CommandOrchestrator();
    }
    return CommandOrchestrator.instance;
  }

  /**
   * 初始化编排器
   */
  async initialize(): Promise<void> {
    try {
      const config = this.configService.getConfig();
      
      // 初始化 core 服务
      this.agent = new Agent({
        apiKey: config.auth.apiKey,
        baseUrl: config.auth.baseUrl,
        modelName: config.auth.modelName,
      });

      await this.agent.init();
      
      // 获取核心组件
      this.llmManager = this.agent.getLLMManager();
      this.contextComponent = this.agent.getContextComponent();
      this.toolComponent = this.agent.getToolComponent();

    } catch (error) {
      console.error('命令编排器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 统一命令执行入口
   */
  async executeCommand(input: string): Promise<CommandResult> {
    const trimmedInput = input.trim();
    
    if (trimmedInput.startsWith('/')) {
      // 斜杠命令
      const parts = trimmedInput.slice(1).split(' ');
      const command = parts[0];
      const args = parts.slice(1);
      return await this.executeSlashCommand(command, args);
    } else {
      // 自然语言
      return await this.executeNaturalLanguage(trimmedInput);
    }
  }

  /**
   * 执行斜杠命令
   */
  async executeSlashCommand(command: string, args: string[] = []): Promise<CommandResult> {
    try {
      if (!this.agent) {
        await this.initialize();
      }

      switch (command.toLowerCase()) {
        case 'help':
          return await this.executeHelpCommand();
        case 'clear':
          return await this.executeClearCommand();
        case 'status':
          return await this.executeStatusCommand();
        case 'config':
          return await this.executeConfigCommand(args);
        case 'tools':
          return await this.executeToolsCommand();
        default:
          return {
            success: false,
            error: `未知命令: /${command}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: `执行命令失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * 执行自然语言命令
   */
  async executeNaturalLanguage(input: string): Promise<CommandResult> {
    try {
      if (!this.agent) {
        await this.initialize();
      }

      // 使用 core 的 Agent 处理自然语言输入
      const response = await this.agent!.chat(input);
      
      return {
        success: true,
        output: response,
        metadata: {
          type: 'naturalLanguage',
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `处理自然语言失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * 帮助命令
   */
  private async executeHelpCommand(): Promise<CommandResult> {
    const helpText = `
🚀 Blade AI 助手 - 可用命令

📋 斜杠命令:
  /help     - 显示帮助信息
  /clear    - 清除会话历史
  /status   - 显示系统状态
  /config   - 配置管理
  /tools    - 查看可用工具

💬 自然语言:
  直接输入问题或指令，例如:
  "帮我写一个函数"
  "review 这个文件"
  "解释这段代码"

🎯 示例:
  /config get apiKey
  "帮我优化这段代码"
  "review src/main.ts"
    `;

    return {
      success: true,
      output: helpText,
    };
  }

  /**
   * 清除命令
   */
  private async executeClearCommand(): Promise<CommandResult> {
    if (this.contextComponent && typeof this.contextComponent.clear === 'function') {
      this.contextComponent.clear();
    }
    
    return {
      success: true,
      output: '✅ 会话历史已清除',
    };
  }

  /**
   * 状态命令
   */
  private async executeStatusCommand(): Promise<CommandResult> {
    const config = this.configService.getConfig();
    const status = {
      agent: this.agent ? '已初始化' : '未初始化',
      model: config.auth.modelName || '未设置',
      tools: (this.toolComponent && typeof this.toolComponent.getToolCount === 'function') ? this.toolComponent.getToolCount() : 0,
      context: (this.contextComponent && typeof this.contextComponent.getMessageCount === 'function') ? this.contextComponent.getMessageCount() : 0,
    };

    const statusText = `
📊 系统状态:
  🤖 Agent: ${status.agent}
  🧠 模型: ${status.model}
  🛠️  工具: ${status.tools} 个
  💬 上下文: ${status.context} 条消息
    `;

    return {
      success: true,
      output: statusText,
    };
  }

  /**
   * 配置命令
   */
  private async executeConfigCommand(args: string[]): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: '使用方法: /config <get|set> <key> [value]',
      };
    }

    const [action, key, value] = args;
    
    switch (action.toLowerCase()) {
      case 'get':
        return await this.handleConfigGet(key);
      case 'set':
        return await this.handleConfigSet(key, value);
      default:
        return {
          success: false,
          error: `未知操作: ${action}`,
        };
    }
  }

  /**
   * 获取配置
   */
  private async handleConfigGet(key: string): Promise<CommandResult> {
    const config = this.configService.getConfig();
    const value = this.getNestedConfigValue(config, key);
    
    if (value === undefined) {
      return {
        success: false,
        error: `配置项不存在: ${key}`,
      };
    }

    return {
      success: true,
      output: `${key} = ${JSON.stringify(value, null, 2)}`,
    };
  }

  /**
   * 设置配置
   */
  private async handleConfigSet(key: string, value: string): Promise<CommandResult> {
    try {
      // 这里可以实现配置设置逻辑
      return {
        success: false,
        error: '配置设置功能尚未实现',
      };
    } catch (error) {
      return {
        success: false,
        error: `设置配置失败: ${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }

  /**
   * 工具命令
   */
  private async executeToolsCommand(): Promise<CommandResult> {
    if (!this.toolComponent) {
      return {
        success: false,
        error: '工具组件未初始化',
      };
    }

    if (!this.toolComponent || typeof this.toolComponent.listTools !== 'function') {
      return {
        success: true,
        output: `🛠️ 可用工具 (0 个): 工具组件未初始化`,
      };
    }

    const tools = this.toolComponent.listTools();
    const toolList = tools.map(tool => 
      `  • ${tool.name} - ${tool.description}`
    ).join('\n');

    return {
      success: true,
      output: `🛠️ 可用工具 (${tools.length} 个):\n${toolList}`,
    };
  }

  /**
   * 获取嵌套配置值
   */
  private getNestedConfigValue(config: any, path: string): any {
    return path.split('.').reduce((obj, key) => {
      return obj && obj[key] !== undefined ? obj[key] : undefined;
    }, config);
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.agent) {
      await this.agent.destroy();
      this.agent = null;
    }
    this.llmManager = null;
    this.contextComponent = null;
    this.toolComponent = null;
  }
}