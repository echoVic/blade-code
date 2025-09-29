import { jest } from '@jest/globals';
import {
  APIMockFactory,
  DatabaseMock,
  FileSystemMockFactory,
  MockFactory,
  NetworkMockFactory,
} from '../index';

// Blade 项目特定的 Mock 工具

export interface BladeMockConfig {
  agentId?: string;
  workspacePath?: string;
  configPath?: string;
  apiKey?: string;
  baseUrl?: string;
  theme?: string;
}

// Agent 相关 Mock
export class AgentMockFactory extends MockFactory {
  static createAgent(config: BladeMockConfig = {}) {
    const defaultConfig: BladeMockConfig = {
      agentId: 'test-agent-123',
      workspacePath: '/test/workspace',
      configPath: '/test/config.json',
      apiKey: 'test-api-key',
      baseUrl: 'https://api.test.com',
      theme: 'default',
    };

    const finalConfig = { ...defaultConfig, ...config };

    return {
      init: this.createAsync({
        returnValue: {
          success: true,
          agentId: finalConfig.agentId,
          initializedAt: new Date().toISOString(),
        },
      }),

      chat: this.createAsync({
        returnValue: {
          message: 'Mock response from agent',
          timestamp: new Date().toISOString(),
          agentId: finalConfig.agentId,
        },
      }),

      generateCode: this.createAsync({
        returnValue: {
          code: 'console.log("Hello, world!");',
          language: 'javascript',
          timestamp: new Date().toISOString(),
        },
      }),

      executeTool: this.createAsync({
        returnValue: {
          result: 'Tool executed successfully',
          duration: 100,
          timestamp: new Date().toISOString(),
        },
      }),

      destroy: this.createAsync({
        returnValue: {
          success: true,
          destroyedAt: new Date().toISOString(),
        },
      }),

      getConfig: this.create({
        returnValue: finalConfig,
      }),
    };
  }
}

// CLI 相关 Mock
export class CLIMockFactory extends MockFactory {
  static createCommand() {
    return {
      parse: this.create({
        returnValue: {
          args: ['test'],
          options: { verbose: true },
          command: 'test',
        },
      }),

      help: this.create({
        returnValue: {
          usage: 'blade <command> [options]',
          commands: ['help', 'config', 'run'],
          examples: [],
        },
      }),

      version: this.create({
        returnValue: {
          version: '1.0.0',
          name: 'blade',
        },
      }),
    };
  }

  static createInquirer() {
    return {
      prompt: this.createAsync({
        returnValue: {
          name: 'test',
          email: 'test@example.com',
          confirm: true,
        },
      }),

      confirm: this.createAsync({
        returnValue: true,
      }),

      checkbox: this.createAsync({
        returnValue: ['option1', 'option2'],
      }),

      list: this.createAsync({
        returnValue: 'option1',
      }),

      input: this.createAsync({
        returnValue: 'test input',
      }),

      password: this.createAsync({
        returnValue: 'test password',
      }),
    };
  }
}

// LLM 相关 Mock
export class LLMMockFactory extends APIMockFactory {
  static createLLMProvider() {
    return {
      chat: this.createAsync({
        returnValue: {
          choices: [
            {
              message: {
                content: 'This is a mock response from the LLM',
                role: 'assistant',
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: Date.now() / 1000,
        },
      }),

      complete: this.createAsync({
        returnValue: {
          choices: [
            {
              text: 'Mock completion text',
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 30,
            total_tokens: 80,
          },
        },
      }),

      embed: this.createAsync({
        returnValue: {
          data: [
            {
              embedding: Array(1536).fill(0.1),
              index: 0,
              object: 'embedding',
            },
          ],
          usage: {
            prompt_tokens: 10,
            total_tokens: 10,
          },
        },
      }),

      validateApiKey: this.createAsync({
        returnValue: {
          valid: true,
          account: {
            id: 'acc_123',
            email: 'test@example.com',
            name: 'Test Account',
          },
        },
      }),
    };
  }
}

// 工具相关 Mock
export class ToolMockFactory extends MockFactory {
  static createTool(toolName: string) {
    const baseTool = {
      name: toolName,
      description: `Mock ${toolName} tool`,
      execute: this.createAsync({
        returnValue: {
          success: true,
          result: `${toolName} executed successfully`,
          duration: Math.floor(Math.random() * 1000) + 100,
        },
      }),

      validate: this.create({
        returnValue: {
          valid: true,
          errors: [],
        },
      }),

      getSchema: this.create({
        returnValue: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: `Input for ${toolName}`,
            },
          },
          required: ['input'],
        },
      }),
    };

    // 添加工具特定的 Mock
    switch (toolName) {
      case 'git-status':
        return {
          ...baseTool,
          execute: this.createAsync({
            returnValue: {
              success: true,
              result: {
                branch: 'main',
                staged: ['file1.ts', 'file2.js'],
                unstaged: ['file3.ts'],
                untracked: ['new-file.txt'],
                ahead: 2,
                behind: 0,
              },
            },
          }),
        };

      case 'git-add':
        return {
          ...baseTool,
          execute: this.createAsync({
            returnValue: {
              success: true,
              result: {
                added: ['file1.ts', 'file2.js'],
                message: 'Files added to staging area',
              },
            },
          }),
        };

      case 'file-system':
        return {
          ...baseTool,
          execute: this.createAsync({
            returnValue: {
              success: true,
              result: {
                operation: 'read',
                path: '/test/file.txt',
                content: 'File content here',
                stats: {
                  size: 1024,
                  created: new Date().toISOString(),
                  modified: new Date().toISOString(),
                },
              },
            },
          }),
        };

      default:
        return baseTool;
    }
  }

  static createToolManager() {
    return {
      registerTool: this.create({
        returnValue: true,
      }),

      getTool: this.create({
        returnValue: this.createTool('mock-tool'),
      }),

      listTools: this.create({
        returnValue: [
          'git-status',
          'git-add',
          'git-commit',
          'file-system',
          'network-request',
          'code-review',
        ],
      }),

      executeTool: this.createAsync({
        returnValue: {
          success: true,
          result: 'Tool executed via manager',
          duration: 500,
        },
      }),

      validateTool: this.create({
        returnValue: {
          valid: true,
          errors: [],
        },
      }),
    };
  }
}

// 配置相关 Mock
export class ConfigMockFactory extends MockFactory {
  static createConfigManager() {
    return {
      loadConfig: this.createAsync({
        returnValue: {
          version: '1.0.0',
          agent: {
            name: 'Blade',
            model: 'gpt-4',
            maxTokens: 4000,
          },
          workspace: {
            path: '/workspace',
            projects: [],
          },
          theme: {
            name: 'default',
            colors: {
              primary: '#007acc',
              secondary: '#6c757d',
            },
          },
        },
      }),

      saveConfig: this.createAsync({
        returnValue: {
          success: true,
          path: '/config/blade.json',
          savedAt: new Date().toISOString(),
        },
      }),

      mergeConfig: this.createAsync({
        returnValue: {
          merged: {
            version: '1.0.0',
            agent: {
              name: 'Blade Pro',
              model: 'gpt-4',
              maxTokens: 8000,
            },
          },
          conflicts: [],
        },
      }),

      validateConfig: this.create({
        returnValue: {
          valid: true,
          errors: [],
          warnings: [],
        },
      }),

      getConfigSchema: this.create({
        returnValue: {
          type: 'object',
          properties: {
            agent: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                model: { type: 'string' },
                maxTokens: { type: 'number' },
              },
            },
          },
        },
      }),
    };
  }
}

// UI 相关 Mock
export class UIMockFactory extends MockFactory {
  static createInkComponent() {
    return {
      render: this.create({
        returnValue: '<div>Mock Ink Component</div>',
      }),

      useApp: this.create({
        returnValue: {
          exit: jest.fn(),
          redraw: jest.fn(),
        },
      }),

      useInput: this.create({
        returnValue: {
          input: '',
          setRawMode: jest.fn(),
        },
      }),

      useStdout: this.create({
        returnValue: {
          write: jest.fn(),
          columns: 80,
          rows: 24,
        },
      }),
    };
  }

  static createThemeManager() {
    return {
      getCurrentTheme: this.create({
        returnValue: {
          name: 'default',
          colors: {
            primary: '#007acc',
            secondary: '#6c757d',
            success: '#28a745',
            danger: '#dc3545',
            warning: '#ffc107',
            info: '#17a2b8',
          },
          fonts: {
            primary: 'monospace',
            secondary: 'sans-serif',
          },
        },
      }),

      setTheme: this.createAsync({
        returnValue: {
          success: true,
          message: 'Theme changed to dark',
          theme: {
            name: 'dark',
            colors: {
              primary: '#ffffff',
              background: '#1a1a1a',
            },
          },
        },
      }),

      listThemes: this.create({
        returnValue: ['default', 'dark', 'light', 'high-contrast'],
      }),

      validateTheme: this.create({
        returnValue: {
          valid: true,
          errors: [],
        },
      }),
    };
  }
}

// MCP (Model Context Protocol) Mock
export class MCPMockFactory extends MockFactory {
  static createMCPClient() {
    return {
      connect: this.createAsync({
        returnValue: {
          success: true,
          clientId: 'mcp-client-123',
          connectedAt: new Date().toISOString(),
        },
      }),

      disconnect: this.createAsync({
        returnValue: {
          success: true,
          disconnectedAt: new Date().toISOString(),
        },
      }),

      sendRequest: this.createAsync({
        returnValue: {
          success: true,
          data: {
            id: 'req-123',
            result: 'Mock MCP response',
            timestamp: new Date().toISOString(),
          },
        },
      }),

      sendNotification: this.createAsync({
        returnValue: {
          success: true,
          notificationId: 'not-123',
        },
      }),

      onMessage: this.create({
        returnValue: jest.fn(),
      }),

      onError: this.create({
        returnValue: jest.fn(),
      }),
    };
  }
}

// 日志相关 Mock
export class LoggerMockFactory extends MockFactory {
  static createLogger() {
    return {
      debug: this.create(),
      info: this.create(),
      warn: this.create(),
      error: this.create(),
      fatal: this.create(),

      setLevel: this.create({
        returnValue: true,
      }),

      getLevel: this.create({
        returnValue: 'info',
      }),

      setContext: this.create({
        returnValue: true,
      }),

      clearContext: this.create({
        returnValue: true,
      }),

      addTransport: this.create({
        returnValue: true,
      }),

      removeTransport: this.create({
        returnValue: true,
      }),
    };
  }
}

// 综合测试 Mock 工具包
export class BladeMockKit {
  private mocks: Map<string, any> = new Map();

  constructor() {
    this.setupDefaultMocks();
  }

  private setupDefaultMocks(): void {
    // Agent Mocks
    const agent = AgentMockFactory.createAgent();
    this.mocks.set('agent', agent);

    // CLI Mocks
    const cli = CLIMockFactory.createCommand();
    this.mocks.set('cli', cli);

    // LLM Mocks
    const llm = LLMMockFactory.createLLMProvider();
    this.mocks.set('llm', llm);

    // Tool Mocks
    const toolManager = ToolMockFactory.createToolManager();
    this.mocks.set('toolManager', toolManager);

    // Config Mocks
    const configManager = ConfigMockFactory.createConfigManager();
    this.mocks.set('configManager', configManager);

    // Logger Mocks
    const logger = LoggerMockFactory.createLogger();
    this.mocks.set('logger', logger);

    // Database Mock
    const database = DatabaseMock.create();
    this.mocks.set('database', database);
  }

  get<T>(name: string): T {
    return this.mocks.get(name) as T;
  }

  set(name: string, mock: any): void {
    this.mocks.set(name, mock);
  }

  has(name: string): boolean {
    return this.mocks.has(name);
  }

  getAgent() {
    return this.get('agent');
  }

  getCLI() {
    return this.get('cli');
  }

  getLLM() {
    return this.get('llm');
  }

  getToolManager() {
    return this.get('toolManager');
  }

  getConfigManager() {
    return this.get('configManager');
  }

  getLogger() {
    return this.get('logger');
  }

  getDatabase() {
    return this.get('database');
  }

  clearAll(): void {
    this.mocks.forEach((mock) => {
      if (mock && typeof mock.mockClear === 'function') {
        mock.mockClear();
      }
    });
  }

  resetAll(): void {
    this.mocks.forEach((mock) => {
      if (mock && typeof mock.mockReset === 'function') {
        mock.mockReset();
      }
    });
  }

  restoreAll(): void {
    this.mocks.forEach((mock) => {
      if (mock && typeof mock.mockRestore === 'function') {
        mock.mockRestore();
      }
    });
  }

  static create(): BladeMockKit {
    return new BladeMockKit();
  }
}

// 快捷导出
export const createBladeMocks = BladeMockKit.create;

// 预设配置
export const BladeMockPresets = {
  development: {
    verbose: true,
    mockDelay: 0,
    mockErrors: false,
  },

  integration: {
    verbose: false,
    mockDelay: 100,
    mockErrors: true,
  },

  production: {
    verbose: false,
    mockDelay: 500,
    mockErrors: false,
  },
};
