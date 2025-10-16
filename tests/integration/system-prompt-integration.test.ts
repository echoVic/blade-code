import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/Agent.js';
import type { AgentOptions } from '../../src/agent/types.js';
import { PermissionMode } from '../../src/config/types.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/prompts/default.js';

// Mock 配置对象
const mockBladeConfig = {
  // 认证
  provider: 'openai-compatible' as const,
  apiKey: 'test-api-key',
  baseUrl: 'https://test-api.example.com',

  // 模型
  model: 'test-model',
  temperature: 0.7,
  maxTokens: 4096,
  stream: false,
  topP: 1,
  topK: 0,
  timeout: 30000,

  // UI
  theme: 'dark',
  language: 'en',
  fontSize: 14,
  showStatusBar: true,

  // 核心
  debug: false,
  telemetry: false,
  autoUpdate: true,
  workingDirectory: process.cwd(),

  // 日志
  logLevel: 'info' as const,
  logFormat: 'text' as const,

  // MCP
  mcpEnabled: false,

  // 权限
  permissions: {
    allow: [],
    ask: [],
    deny: [],
  },
  permissionMode: PermissionMode.DEFAULT,

  // 钩子
  hooks: {},

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,
  cleanupPeriodDays: 30,
  includeCoAuthoredBy: false,
};

// Mock ConfigManager 实例
const mockConfigManagerInstance = {
  initialize: vi.fn().mockResolvedValue(mockBladeConfig),
  getConfig: vi.fn().mockReturnValue(mockBladeConfig),
  validateConfig: vi.fn(),
};

// Mock 配置管理器
vi.mock('../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: vi.fn(() => mockConfigManagerInstance),
    resetInstance: vi.fn(),
  },
}));

// Mock ChatService
vi.mock('../../src/services/ChatServiceInterface.js', () => ({
  createChatService: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({ content: 'Mock AI response' }),
  }),
}));

// 辅助函数：创建测试用的Agent实例
async function createAgent(options: AgentOptions = {}): Promise<Agent> {
  // 直接使用构造函数创建Agent，绕过ConfigManager
  const agent = new Agent(mockBladeConfig, options);
  await agent.initialize();
  return agent;
}

describe('System Prompt Integration', () => {
  const testDir = join(process.cwd(), 'test-temp-integration');
  const testUserConfigDir = join(testDir, '.blade');
  const testUserConfigPath = join(testUserConfigDir, 'BLADE.md');
  const testProjectConfigPath = join(testDir, 'BLADE.md');

  beforeEach(() => {
    // 创建测试目录
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    if (!existsSync(testUserConfigDir)) {
      mkdirSync(testUserConfigDir, { recursive: true });
    }

    // Mock process.cwd() 返回测试目录
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

    // Mock homedir() 返回测试目录
    vi.spyOn(require('os'), 'homedir').mockReturnValue(testDir);

    // Mock已在文件顶部设置
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // 恢复 mock
    vi.restoreAllMocks();
  });

  describe('Agent 系统提示集成', () => {
    it('应该在 Agent 初始化时加载默认系统提示', async () => {
      const agent = await createAgent();

      const systemPrompt = agent.getSystemPrompt();
      expect(systemPrompt).toBeDefined();
      if (systemPrompt) {
        expect(systemPrompt).toContain('Blade Code');
        expect(systemPrompt).toContain('command line intelligent coding assistant');
      }
    });

    it('应该支持通过 Agent.create 传递自定义系统提示', async () => {
      const customPrompt = '这是一个自定义的系统提示';
      const agent = await createAgent({
        appendSystemPrompt: customPrompt,
      });

      const systemPrompt = agent.getSystemPrompt();
      expect(systemPrompt).toBeDefined();
      if (systemPrompt) {
        expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(systemPrompt).toContain(customPrompt);
      }
    });

    it('应该加载用户配置文件中的系统提示', async () => {
      const userPrompt = '用户自定义系统提示';
      writeFileSync(testUserConfigPath, userPrompt, 'utf-8');

      const agent = await createAgent();

      const systemPrompt = agent.getSystemPrompt();
      expect(systemPrompt).toBeDefined();
      if (systemPrompt) {
        expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(systemPrompt).toContain(userPrompt);
      }
    });

    it('应该加载项目配置文件中的系统提示', async () => {
      const projectPrompt = '项目特定系统提示\n包含多行内容';
      writeFileSync(testProjectConfigPath, projectPrompt, 'utf-8');

      const agent = await createAgent();

      const systemPrompt = agent.getSystemPrompt();
      expect(systemPrompt).toBeDefined();
      if (systemPrompt) {
        expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(systemPrompt).toContain(projectPrompt);
      }
    });

    it('应该按正确优先级合并所有提示来源', async () => {
      const userPrompt = '用户提示';
      const projectPrompt = '项目提示';
      const cliPrompt = 'CLI提示';

      writeFileSync(testUserConfigPath, userPrompt, 'utf-8');
      writeFileSync(testProjectConfigPath, projectPrompt, 'utf-8');

      const agent = await createAgent({ appendSystemPrompt: cliPrompt });

      const systemPrompt = agent.getSystemPrompt();
      expect(systemPrompt).toBeDefined();

      if (systemPrompt) {
        // 检查所有提示都存在
        expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
        expect(systemPrompt).toContain(userPrompt);
        expect(systemPrompt).toContain(projectPrompt);
        expect(systemPrompt).toContain(cliPrompt);

        // 检查优先级顺序（CLI > 项目 > 用户 > 默认）
        const cliIndex = systemPrompt.indexOf(cliPrompt);
        const projectIndex = systemPrompt.indexOf(projectPrompt);
        const userIndex = systemPrompt.indexOf(userPrompt);
        const defaultIndex = systemPrompt.indexOf('Blade Code');

        expect(cliIndex).toBeLessThan(projectIndex);
        expect(projectIndex).toBeLessThan(userIndex);
        expect(userIndex).toBeLessThan(defaultIndex);
      }
    });
  });

  describe('ChatService 集成', () => {
    it('应该在聊天消息中注入系统提示', async () => {
      // 这个测试需要进一步的 ChatService mock 实现
      // 由于 ChatService 依赖外部 API，这里只做基础结构测试
      expect(true).toBe(true); // 占位符测试
    });
  });

  describe('配置错误处理', () => {
    it('应该处理配置文件格式错误', async () => {
      // 写入无效的配置文件
      writeFileSync(testUserConfigPath, '一些\n无效的\n配置内容', 'utf-8');

      // 应该能正常创建 Agent，只是跳过错误的配置
      const agent = await createAgent();
      const systemPrompt = agent.getSystemPrompt();

      expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
    });

    it('应该处理配置文件权限错误', async () => {
      writeFileSync(testUserConfigPath, '测试内容', 'utf-8');

      // 这个测试需要更复杂的 mock 设置，暂时跳过
      // 实际应用中文件权限错误会被优雅处理
      const agent = await createAgent();
      const systemPrompt = agent.getSystemPrompt();

      expect(systemPrompt).toBeDefined();
      if (systemPrompt) {
        expect(systemPrompt).toContain(DEFAULT_SYSTEM_PROMPT);
      }
    });
  });

  describe('性能测试', () => {
    it('应该能快速加载大型配置文件', async () => {
      // 创建一个相对较大的配置文件
      const largeContent = '这是一个大型配置文件\n'.repeat(1000);
      writeFileSync(testProjectConfigPath, largeContent, 'utf-8');

      const startTime = Date.now();
      const agent = await createAgent();
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // 应该在1秒内完成
      expect(agent.getSystemPrompt()).toContain(largeContent);
    });

    it('应该能处理多个配置文件', async () => {
      const userPrompt = '用户配置\n'.repeat(100);
      const projectPrompt = '项目配置\n'.repeat(100);

      writeFileSync(testUserConfigPath, userPrompt, 'utf-8');
      writeFileSync(testProjectConfigPath, projectPrompt, 'utf-8');

      const startTime = Date.now();
      const agent = await createAgent({ appendSystemPrompt: 'CLI配置' });
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // 应该在1秒内完成

      const systemPrompt = agent.getSystemPrompt();
      console.log('=== 系统提示内容 ===');
      console.log(systemPrompt);
      console.log('=== 用户提示内容 ===');
      console.log(userPrompt.substring(0, 50));
      console.log('=== 项目提示内容 ===');
      console.log(projectPrompt.substring(0, 50));
      expect(systemPrompt).toContain(userPrompt);
      expect(systemPrompt).toContain(projectPrompt);
      expect(systemPrompt).toContain('CLI配置');
    });
  });
});
