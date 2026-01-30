/**
 * 测试数据工厂和fixture管理
 * 提供 Blade 项目测试中常用的测试数据和fixture管理功能
 */

// 类型定义
export interface FixtureData {
  id: string;
  name: string;
  data: any;
  type: 'json' | 'text' | 'binary';
  created: string;
  updated?: string;
}

export interface DataFactory<T = any> {
  create: (overrides?: Partial<T>) => T;
  createMany: (count: number, overrides?: Partial<T>) => T[];
}

export interface DataSchema<T = any> {
  defaults: T;
  variations?: Record<string, Partial<T>>;
  sequences?: Record<string, (index: number) => Partial<T>>;
}

// 基础测试数据生成器
export class TestDataFactory {
  private static sequenceCounters: Map<string, number> = new Map();

  static getSequence(key: string): number {
    const current = this.sequenceCounters.get(key) || 0;
    this.sequenceCounters.set(key, current + 1);
    return current;
  }

  static resetSequence(key?: string): void {
    if (key) {
      this.sequenceCounters.delete(key);
    } else {
      this.sequenceCounters.clear();
    }
  }

  static createFactory<T>(schema: DataSchema<T>): DataFactory<T> {
    const factory = {
      create: (overrides?: Partial<T>): T => {
        let base = { ...schema.defaults };

        // 应用变体
        if (schema.variations) {
          const variantKeys = Object.keys(schema.variations);
          if (variantKeys.length > 0) {
            const randomVariant =
              variantKeys[Math.floor(Math.random() * variantKeys.length)];
            base = { ...base, ...schema.variations[randomVariant] };
          }
        }

        // 应用序列
        if (schema.sequences) {
          Object.entries(schema.sequences).forEach(([key, fn]) => {
            const sequenceIndex = TestDataFactory.getSequence(key);
            base = { ...base, ...fn(sequenceIndex) };
          });
        }

        // 应用覆盖
        if (overrides) {
          base = { ...base, ...overrides };
        }

        return base;
      },

      createMany: (count: number, overrides?: Partial<T>): T[] => {
        return Array.from({ length: count }, () => factory.create(overrides));
      },
    };

    return factory;
  }
}

// Blade 项目特定的数据工厂
export class BladeDataFactory {
  // Agent 相关数据
  static Agent = TestDataFactory.createFactory({
    defaults: {
      id: () => `agent-${TestDataFactory.getSequence('agent')}`,
      name: 'Test Agent',
      model: 'gpt-4',
      maxTokens: 4000,
      temperature: 0.7,
      systemPrompt: 'You are a helpful AI assistant',
      createdAt: new Date().toISOString(),
      updatedAt: () => new Date().toISOString(),
      status: 'active',
      config: {
        workspace: '/test/workspace',
        theme: 'default',
        logging: {
          level: 'info',
          format: 'text',
        },
      },
    },
    variations: {
      premium: {
        model: 'gpt-4-turbo',
        maxTokens: 8000,
        temperature: 0.5,
      },
      basic: {
        model: 'gpt-3.5-turbo',
        maxTokens: 2000,
        temperature: 0.9,
      },
    },
    sequences: {
      generatedName: (index) => ({
        name: `Test Agent ${index + 1}`,
      }),
    },
  });

  // 用户相关数据
  static User = TestDataFactory.createFactory({
    defaults: {
      id: () => `user-${TestDataFactory.getSequence('user')}`,
      username: () => `user${TestDataFactory.getSequence('user')}`,
      email: () => `user${TestDataFactory.getSequence('user')}@example.com`,
      name: 'Test User',
      role: 'user',
      avatar: 'https://example.com/avatar.jpg',
      createdAt: new Date().toISOString(),
      updatedAt: () => new Date().toISOString(),
      isActive: true,
      preferences: {
        theme: 'default',
        language: 'en',
        notifications: true,
      },
      stats: {
        logins: 0,
        projects: 0,
        filesCreated: 0,
      },
    },
    variations: {
      admin: {
        role: 'admin',
        name: 'Admin User',
      },
      developer: {
        role: 'developer',
        name: 'Developer User',
      },
      guest: {
        role: 'guest',
        isActive: false,
      },
    },
    sequences: {
      email: (index) => ({
        email: () => `user${index + 1}@example.com`,
      }),
    },
  });

  // 项目相关数据
  static Project = TestDataFactory.createFactory({
    defaults: {
      id: () => `project-${TestDataFactory.getSequence('project')}`,
      name: 'Test Project',
      description: 'A test project for testing purposes',
      path: '/test/project',
      type: 'javascript',
      version: '1.0.0',
      framework: 'react',
      createdAt: new Date().toISOString(),
      updatedAt: () => new Date().toISOString(),
      status: 'active',
      owner: BladeDataFactory.User.create(),
      collaborators: [],
      settings: {
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        deployCommand: 'npm run deploy',
        environment: 'development',
      },
      stats: {
        builds: 0,
        deployments: 0,
        commits: 0,
        issues: 0,
      },
    },
    variations: {
      react: {
        type: 'javascript',
        framework: 'react',
        name: 'React Test Project',
      },
      node: {
        type: 'nodejs',
        framework: 'express',
        name: 'Node.js Test Project',
      },
      python: {
        type: 'python',
        framework: 'django',
        name: 'Python Test Project',
      },
    },
    sequences: {
      name: (index) => ({
        name: `Test Project ${index + 1}`,
      }),
    },
  });

  // Git 相关数据
  static GitCommit = TestDataFactory.createFactory({
    defaults: {
      hash: () => `commit${TestDataFactory.getSequence('commit')}`,
      message: 'Test commit message',
      author: {
        name: 'Test Author',
        email: 'test@example.com',
      },
      committer: {
        name: 'Test Committer',
        email: 'test@example.com',
      },
      date: new Date().toISOString(),
      filesChanged: ['file1.ts', 'file2.js'],
      stats: {
        additions: 10,
        deletions: 5,
        changes: 15,
      },
      branch: 'main',
      tags: [],
    },
    variations: {
      feature: {
        message: 'feat: Add new feature',
        branch: 'feature/new-feature',
      },
      bugfix: {
        message: 'fix: Fix critical bug',
        branch: 'bugfix/critical-bug',
      },
      docs: {
        message: 'docs: Update documentation',
        filesChanged: ['README.md', 'docs/api.md'],
      },
    },
    sequences: {
      hash: (index) => ({
        hash: () => `a1b2c3d4e5f6${index.toString(16).padStart(8, '0')}`,
      }),
    },
  });

  // 工具相关数据
  static Tool = TestDataFactory.createFactory({
    defaults: {
      id: () => `tool-${TestDataFactory.getSequence('tool')}`,
      name: 'Test Tool',
      description: 'A test tool for testing',
      category: 'development',
      type: 'built-in',
      version: '1.0.0',
      enabled: true,
      config: {
        timeout: 30000,
        retries: 3,
      },
      createdAt: new Date().toISOString(),
      updatedAt: () => new Date().toISOString(),
      usage: {
        calls: 0,
        success: 0,
        errors: 0,
        lastUsed: null,
      },
    },
    variations: {
      git: {
        name: 'Git Tool',
        category: 'version-control',
        type: 'built-in',
      },
      file: {
        name: 'File System Tool',
        category: 'filesystem',
        type: 'built-in',
      },
      network: {
        name: 'Network Tool',
        category: 'network',
        type: 'built-in',
      },
    },
    sequences: {
      name: (index) => ({
        name: `Test Tool ${index + 1}`,
      }),
    },
  });

  // 日志相关数据
  static LogEntry = TestDataFactory.createFactory({
    defaults: {
      id: () => `log-${TestDataFactory.getSequence('log')}`,
      level: 'info',
      message: 'Test log message',
      timestamp: new Date().toISOString(),
      source: 'test',
      metadata: {
        userId: 'test-user',
        sessionId: 'test-session',
        error: undefined as string | undefined,
        stack: undefined as string | undefined,
        debug: undefined as boolean | undefined,
        verbose: undefined as boolean | undefined,
        warning: undefined as string | undefined,
      },
      tags: ['test'],
      context: {},
    },
    variations: {
      error: {
        level: 'error',
        message: 'Test error message',
        metadata: {
          userId: 'test-user',
          sessionId: 'test-session',
          error: 'Test error',
          stack: 'Error: Test error\n    at test.js:1:1',
          debug: undefined,
          verbose: undefined,
          warning: undefined,
        },
      },
      debug: {
        level: 'debug',
        message: 'Test debug message',
        metadata: {
          userId: 'test-user',
          sessionId: 'test-session',
          debug: true,
          verbose: true,
          error: undefined,
          stack: undefined,
          warning: undefined,
        },
      },
      warn: {
        level: 'warn',
        message: 'Test warning message',
        metadata: {
          userId: 'test-user',
          sessionId: 'test-session',
          warning: 'Test warning',
          error: undefined,
          stack: undefined,
          debug: undefined,
          verbose: undefined,
        },
      },
    },
    sequences: {
      message: (index) => ({
        message: `Test log message ${index + 1}`,
      }),
    },
  });

  // 配置相关数据
  static Config = TestDataFactory.createFactory({
    defaults: {
      // BladeConfig 的必需字段
      currentModelId: 'test-model-1',
      models: [
        {
          id: 'test-model-1',
          name: 'Test Model',
          provider: 'openai-compatible' as const,
          apiKey: 'test-key',
          baseUrl: 'https://api.test.com',
          model: 'gpt-4',
        },
      ],
      temperature: 0.7,
      maxContextTokens: 8000,
      maxOutputTokens: 4000,
      stream: true,
      topP: 1,
      topK: 0,
      timeout: 30000,
      theme: 'default',
      language: 'en',
      fontSize: 14,
      debug: false,
      mcpEnabled: false,
      mcpServers: {},
      permissions: {
        allow: [],
        ask: [],
        deny: [],
      },
      permissionMode: 'default',
      hooks: {},
      env: {},
      disableAllHooks: false,
      maxTurns: 10,
    },
    variations: {
      production: {
        currentModelId: 'prod-model-1',
        models: [
          {
            id: 'prod-model-1',
            name: 'Production Model',
            provider: 'openai-compatible' as const,
            apiKey: 'prod-key',
            baseUrl: 'https://api.prod.com',
            model: 'gpt-4-turbo',
          },
        ],
        temperature: 0.5,
      },
      development: {
        currentModelId: 'dev-model-1',
        models: [
          {
            id: 'dev-model-1',
            name: 'Development Model',
            provider: 'openai-compatible' as const,
            apiKey: 'dev-key',
            baseUrl: 'https://api.dev.com',
            model: 'gpt-3.5-turbo',
          },
        ],
        temperature: 0.9,
      },
    },
    sequences: {
      name: (index) => ({
        currentModelId: `test-model-${index + 1}`,
        models: [
          {
            id: `test-model-${index + 1}`,
            name: `Test Model ${index + 1}`,
            provider: 'openai-compatible' as const,
            apiKey: 'test-key',
            baseUrl: 'https://api.test.com',
            model: 'gpt-4',
          },
        ],
      }),
    },
  });

  // 重置所有序列计数器
  static reset(): void {
    TestDataFactory.resetSequence();
  }
}

// Fixture管理器
export class FixtureManager {
  private fixtures: Map<string, FixtureData> = new Map();

  constructor(private basePath: string = './tests/fixtures') {}

  async loadFixture(name: string): Promise<FixtureData> {
    if (this.fixtures.has(name)) {
      return this.fixtures.get(name)!;
    }

    try {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const data = readFileSync(join(this.basePath, `${name}.json`), 'utf-8');
      const fixture: FixtureData = JSON.parse(data);

      this.fixtures.set(name, fixture);
      return fixture;
    } catch (error) {
      throw new Error(`Failed to load fixture '${name}': ${error}`);
    }
  }

  async saveFixture(
    name: string,
    data: any,
    type: 'json' | 'text' | 'binary' = 'json'
  ): Promise<FixtureData> {
    const fixture: FixtureData = {
      id: TestDataFactory.getSequence('fixture').toString(),
      name,
      data,
      type,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    this.fixtures.set(name, fixture);

    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { mkdirSync } = await import('fs');

      // 确保目录存在
      mkdirSync(this.basePath, { recursive: true });

      // 保存到文件
      const content = type === 'json' ? JSON.stringify(fixture, null, 2) : data;
      writeFileSync(join(this.basePath, `${name}.${type}`), content);

      return fixture;
    } catch (error) {
      throw new Error(`Failed to save fixture '${name}': ${error}`);
    }
  }

  async updateFixture(name: string, updates: Partial<any>): Promise<FixtureData> {
    const existing = await this.loadFixture(name);
    const updated = {
      ...existing,
      data: { ...existing.data, ...updates },
      updated: new Date().toISOString(),
    };

    this.fixtures.set(name, updated);
    await this.saveFixture(name, updated.data, updated.type);

    return updated;
  }

  getFixture(name: string): FixtureData | undefined {
    return this.fixtures.get(name);
  }

  listFixtures(): string[] {
    return Array.from(this.fixtures.keys());
  }

  clear(): void {
    this.fixtures.clear();
  }

  static create(basePath?: string): FixtureManager {
    return new FixtureManager(basePath);
  }
}

// 预定义的测试数据集
export class TestDataSet {
  static agentData = {
    basic: BladeDataFactory.Agent.create(),
    premium: BladeDataFactory.Agent.create({ model: 'gpt-4-turbo', maxTokens: 8000 }),
    basic2: BladeDataFactory.Agent.create({ model: 'gpt-3.5-turbo', maxTokens: 2000 }),
  };

  static userData = {
    admin: BladeDataFactory.User.create({ role: 'admin' }),
    developer: BladeDataFactory.User.create({ role: 'developer' }),
    guest: BladeDataFactory.User.create({ role: 'guest' }),
  };

  static projectData = {
    react: BladeDataFactory.Project.create({ type: 'javascript', framework: 'react' }),
    node: BladeDataFactory.Project.create({ type: 'nodejs', framework: 'express' }),
    python: BladeDataFactory.Project.create({ type: 'python', framework: 'django' }),
  };

  static gitData = {
    feature: BladeDataFactory.GitCommit.create({ message: 'feat: Add new feature' }),
    bugfix: BladeDataFactory.GitCommit.create({ message: 'fix: Fix critical bug' }),
    docs: BladeDataFactory.GitCommit.create({ message: 'docs: Update documentation' }),
  };

  static toolData = {
    git: BladeDataFactory.Tool.create({
      name: 'Git Tool',
      category: 'version-control',
    }),
    file: BladeDataFactory.Tool.create({
      name: 'File System Tool',
      category: 'filesystem',
    }),
    network: BladeDataFactory.Tool.create({
      name: 'Network Tool',
      category: 'network',
    }),
  };

  static logData = {
    info: BladeDataFactory.LogEntry.create({ level: 'info' }),
    error: BladeDataFactory.LogEntry.create({ level: 'error' }),
    debug: BladeDataFactory.LogEntry.create({ level: 'debug' }),
    warn: BladeDataFactory.LogEntry.create({ level: 'warn' }),
  };

  static configData = {
    production: BladeDataFactory.Config.create(),
    development: BladeDataFactory.Config.create(),
  };

  // 批量生成数据
  static users = BladeDataFactory.User.createMany(10);
  static projects = BladeDataFactory.Project.createMany(5);
  static commits = BladeDataFactory.GitCommit.createMany(20);
  static tools = BladeDataFactory.Tool.createMany(8);
  static logs = BladeDataFactory.LogEntry.createMany(30);
  static configs = BladeDataFactory.Config.createMany(3);
}

// 测试数据验证器
export class TestDataValidator {
  static validateAgent(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.name === 'string' &&
      typeof data.model === 'string' &&
      typeof data.maxTokens === 'number' &&
      typeof data.temperature === 'number' &&
      typeof data.status === 'string'
    );
  }

  static validateUser(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.username === 'string' &&
      typeof data.email === 'string' &&
      typeof data.role === 'string' &&
      typeof data.isActive === 'boolean'
    );
  }

  static validateProject(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.name === 'string' &&
      typeof data.type === 'string' &&
      typeof data.version === 'string' &&
      typeof data.status === 'string'
    );
  }

  static validateGitCommit(data: any): boolean {
    return (
      data &&
      typeof data.hash === 'string' &&
      typeof data.message === 'string' &&
      data.author &&
      typeof data.author.name === 'string' &&
      typeof data.author.email === 'string' &&
      typeof data.date === 'string'
    );
  }

  static validateTool(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.name === 'string' &&
      typeof data.category === 'string' &&
      typeof data.type === 'string' &&
      typeof data.enabled === 'boolean'
    );
  }

  static validateLogEntry(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.level === 'string' &&
      typeof data.message === 'string' &&
      typeof data.timestamp === 'string' &&
      typeof data.source === 'string'
    );
  }

  static validateConfig(data: any): boolean {
    return (
      data &&
      typeof data.id === 'string' &&
      typeof data.name === 'string' &&
      typeof data.version === 'string' &&
      data.data &&
      typeof data.data === 'object'
    );
  }
}
