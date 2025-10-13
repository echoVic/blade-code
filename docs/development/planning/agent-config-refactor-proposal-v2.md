# Agent 配置重构建议 v2（含单例模式）

## 当前问题

### 1. 类型冗余
- `AgentOptions` 和 `AgentConfig` 有重复字段
- 语义不清晰：Options vs Config

### 2. ConfigManager 不是单例 ❌
```typescript
// 当前代码到处都在创建新实例
const configManager = new ConfigManager();  // Agent.ts:87
const configManager = new ConfigManager();  // useCommandHandler.ts:85
const configManager = new ConfigManager();  // doctor.ts
// ... 共 11 处
```

**严重问题:**
- ❌ 每次 `new ConfigManager()` 都会重新加载配置文件（I/O 操作）
- ❌ 配置不一致：不同实例可能读取到不同的配置
- ❌ 性能问题：重复读取文件系统
- ❌ 无法统一更新配置：修改一个实例不影响其他实例
- ❌ 内存浪费：多个实例占用内存

### 3. 配置管理分散
- Agent 自己实现了配置合并逻辑
- ConfigManager 的功能没有充分利用
- 配置来源不统一

### 4. 依赖关系混乱
```
Agent → buildConfig() → new ConfigManager()  // ← 每次都创建新实例！
                     → 手动合并环境变量
                     → 手动合并默认值
```

## 重构方案：ConfigManager 单例 + 职责分离

### 步骤 1: ConfigManager 改为单例模式

```typescript
// src/config/ConfigManager.ts

export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: BladeConfig | null = null;
  private configLoaded = false;

  /**
   * 私有构造函数，防止外部 new
   */
  private constructor() {}

  /**
   * 获取单例实例
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 重置单例（仅用于测试）
   */
  public static resetInstance(): void {
    ConfigManager.instance = null;
  }

  /**
   * 初始化配置系统
   */
  async initialize(): Promise<BladeConfig> {
    if (this.configLoaded && this.config) {
      return this.config; // 已加载，直接返回
    }

    // ... 现有的加载逻辑 ...

    this.configLoaded = true;
    return this.config;
  }

  /**
   * 为 Agent 构建配置
   * 合并：全局配置 + 环境变量 + 用户选项
   */
  public buildAgentConfig(options: AgentOptions = {}): AgentConfig {
    if (!this.config) {
      throw new Error('ConfigManager not initialized. Call initialize() first.');
    }

    // 1. 从已加载的全局配置开始
    const baseConfig = this.config;

    // 2. 合并 Agent 特定的 options（最高优先级）
    return {
      // LLM 配置
      apiKey: options.apiKey ?? baseConfig.apiKey,
      baseUrl: options.baseUrl ?? baseConfig.baseURL,
      model: options.model ?? baseConfig.model,
      temperature: options.temperature ?? baseConfig.temperature ?? 0.0,
      maxTokens: options.maxTokens ?? baseConfig.maxTokens ?? 32000,

      // Agent 配置
      systemPrompt: options.systemPrompt,
      permissions: options.permissions ?? baseConfig.permissions,

      // 高级配置
      context: options.context ?? {
        enabled: true,
        maxTokens: 100000,
        maxMessages: 50,
        compressionEnabled: true,
      },
      planning: options.planning ?? {
        enabled: false,
        maxSteps: 10,
      },
      subagents: options.subagents ?? {
        enabled: false,
        maxConcurrent: 3,
      },
    };
  }

  /**
   * 验证 Agent 配置的完整性
   */
  public validateAgentConfig(config: AgentConfig): void {
    const errors: string[] = [];

    if (!config.apiKey) {
      errors.push('缺少 API 密钥');
    }
    if (!config.baseUrl) {
      errors.push('缺少 API 基础 URL');
    }
    if (!config.model) {
      errors.push('缺少模型名称');
    }

    if (errors.length > 0) {
      throw new Error(
        `Agent 配置验证失败:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
        `请通过以下方式之一提供配置:\n` +
        `  1. 配置文件: ~/.blade/config.json\n` +
        `  2. 环境变量: BLADE_API_KEY, BLADE_BASE_URL, BLADE_MODEL\n` +
        `  3. 代码参数: Agent.create({ apiKey, baseUrl, model })`
      );
    }
  }

  // ... 现有的其他方法 ...
}
```

### 步骤 2: 统一配置类型

```typescript
// src/agent/types.ts

/**
 * Agent 创建选项
 * 用于覆盖全局配置的部分字段
 */
export interface AgentOptions {
  // LLM 配置覆盖
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;

  // Agent 特有配置
  systemPrompt?: string;
  permissions?: PermissionConfig;

  // 可选：高级配置
  context?: ContextConfig;
  planning?: PlanningConfig;
  subagents?: SubagentConfig;
}

/**
 * Agent 内部配置（从 ConfigManager 构建）
 */
export interface AgentConfig {
  // LLM 配置（必需字段）
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;

  // Agent 配置
  systemPrompt?: string;
  permissions: PermissionConfig;

  // 高级配置（带默认值）
  context: ContextConfig;
  planning: PlanningConfig;
  subagents: SubagentConfig;
}
```

### 步骤 3: 简化 Agent 构造

```typescript
// src/agent/Agent.ts

export class Agent extends EventEmitter {
  private config: AgentConfig;

  /**
   * 静态工厂方法：从 AgentOptions 创建
   */
  static async create(options: AgentOptions = {}): Promise<Agent> {
    // 1. 获取 ConfigManager 单例
    const configManager = ConfigManager.getInstance();

    // 2. 确保已初始化（幂等操作）
    await configManager.initialize();

    // 3. 从 ConfigManager 构建配置（统一入口）
    const config = configManager.buildAgentConfig(options);

    // 4. 验证配置
    configManager.validateAgentConfig(config);

    // 5. 创建 Agent
    const agent = new Agent(config);
    await agent.initialize();
    return agent;
  }

  /**
   * 直接从完整配置创建（用于测试或高级用例）
   */
  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.executionPipeline = this.createDefaultPipeline(config);
    // ...
  }

  // 移除 buildConfig 方法 - 职责转移到 ConfigManager
}
```

### 步骤 4: 更新所有使用 ConfigManager 的地方

```typescript
// 之前：每处都 new ConfigManager()
const configManager = new ConfigManager();
await configManager.initialize();

// 之后：使用单例
const configManager = ConfigManager.getInstance();
await configManager.initialize();  // 幂等，多次调用安全
```

**需要修改的文件：**
1. `src/agent/Agent.ts`
2. `src/ui/hooks/useCommandHandler.ts`
3. `src/ui/hooks/useAppInitializer.ts`
4. `src/ui/components/ThemeSelector.tsx`
5. `src/ui/App.tsx`
6. `src/commands/doctor.ts`
7. `src/commands/config.ts`
8. `src/commands/setupToken.ts`
9. 其他所有使用 `new ConfigManager()` 的地方

## 优点

### 1. 单例模式
- ✅ 全局唯一的配置实例
- ✅ 配置文件只读取一次
- ✅ 配置修改全局生效
- ✅ 节省内存和 I/O

### 2. 职责清晰
- ✅ `ConfigManager`: 负责所有配置的加载、合并、验证
- ✅ `Agent`: 只使用配置，不关心配置来源

### 3. 类型明确
- ✅ `AgentOptions`: 用户提供的"选项"（可选字段）
- ✅ `AgentConfig`: Agent 内部的"配置"（必需字段 + 默认值）

### 4. 配置统一
- ✅ 所有配置通过 `ConfigManager.getInstance()` 统一获取
- ✅ 优先级逻辑集中在一个地方
- ✅ 配置更新全局生效

### 5. 易于测试
```typescript
// 测试前���置单例
beforeEach(() => {
  ConfigManager.resetInstance();
});

// 测试时可以直接传入完整配置
const agent = new Agent(mockConfig);

// 或使用工厂方法
const agent = await Agent.create({ apiKey: 'test-key' });
```

## 示例代码对比

### 重构前（问题代码）
```typescript
// useCommandHandler.ts
const configManager = new ConfigManager();  // ← 创建实例 1
await configManager.initialize();           // ← 读取文件

// Agent.ts
const configManager = new ConfigManager();  // ← 创建实例 2
await configManager.initialize();           // ← 再次读取文件！

// ThemeSelector.tsx
const configManager = new ConfigManager();  // ← 创建实例 3
await configManager.initialize();           // ← 又读取一次！

// 问题：
// 1. 配置文件被读取了 3 次
// 2. 三个实例的配置可能不一致
// 3. 修改实例 1 的配置，实例 2 和 3 不知道
```

### 重构后（单例模式）
```typescript
// useCommandHandler.ts
const configManager = ConfigManager.getInstance();  // ← 获取单例
await configManager.initialize();                   // ← 首次加载

// Agent.ts
const configManager = ConfigManager.getInstance();  // ← 同一个实例
await configManager.initialize();                   // ← 已加载，直接返回

// ThemeSelector.tsx
const configManager = ConfigManager.getInstance();  // ← 同一个实例
await configManager.initialize();                   // ← 已加载，直接返回

// 优点：
// 1. 配置文件只读取 1 次
// 2. 所有地方使用同一份配置
// 3. 配置更新全局生效
```

## 迁移计划

### 阶段 1: 实现单例模式（Breaking Change）
1. **修改 ConfigManager**
   - 添加 `private static instance`
   - 构造函数改为 `private`
   - 添加 `public static getInstance()`
   - 添加 `public static resetInstance()`（测试用）

2. **添加 buildAgentConfig()**
   - 实现配置合并逻辑
   - 实现配置验证逻辑

3. **更新测试**
   - 所有测试前调用 `ConfigManager.resetInstance()`
   - 验证单例行为

### 阶段 2: 迁移调用方（Breaking Change）
1. **全局搜索替换**
   ```typescript
   // 查找：new ConfigManager()
   // 替换：ConfigManager.getInstance()
   ```

2. **更新 Agent.create()**
   - 使用 `ConfigManager.getInstance()`
   - 使用 `configManager.buildAgentConfig()`
   - 移除 `Agent.buildConfig()`

3. **更新所有命令和 UI**
   - `src/commands/*.ts`
   - `src/ui/**/*.ts`

### 阶段 3: 清理和文档
1. **移除冗余代码**
   - 删除 `Agent.buildConfig()`
   - 清理重复的配置合并逻辑

2. **更新文档**
   - 更新 API 文档
   - 添加迁移指南
   - 更新示例代码

## 测试策略

### 1. ConfigManager 单例测试
```typescript
describe('ConfigManager Singleton', () => {
  beforeEach(() => {
    ConfigManager.resetInstance();
  });

  it('should return the same instance', () => {
    const instance1 = ConfigManager.getInstance();
    const instance2 = ConfigManager.getInstance();

    expect(instance1).toBe(instance2);
  });

  it('should not allow direct instantiation', () => {
    expect(() => new (ConfigManager as any)()).toThrow();
  });

  it('should initialize only once', async () => {
    const configManager = ConfigManager.getInstance();

    const spy = vi.spyOn(fs, 'readFile');

    await configManager.initialize();
    await configManager.initialize();
    await configManager.initialize();

    // 配置文件只读取一次
    expect(spy).toHaveBeenCalledTimes(2); // config.json + settings.json
  });
});
```

### 2. buildAgentConfig 测试
```typescript
describe('ConfigManager.buildAgentConfig', () => {
  let configManager: ConfigManager;

  beforeEach(async () => {
    ConfigManager.resetInstance();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();
  });

  it('should merge options with global config', () => {
    const config = configManager.buildAgentConfig({
      apiKey: 'override-key',
    });

    expect(config.apiKey).toBe('override-key');
  });

  it('should use global config when options not provided', () => {
    const config = configManager.buildAgentConfig({});
    expect(config.model).toBeDefined();
  });

  it('should throw error when required fields missing', () => {
    // 模拟空配置
    expect(() => {
      const config = configManager.buildAgentConfig({});
      configManager.validateAgentConfig(config);
    }).toThrow('Agent 配置验证失败');
  });
});
```

### 3. Agent.create 测试
```typescript
describe('Agent.create with Singleton ConfigManager', () => {
  beforeEach(() => {
    ConfigManager.resetInstance();
  });

  it('should create agent with custom config', async () => {
    const agent = await Agent.create({
      apiKey: 'test-key',
      baseUrl: 'https://test.api',
      model: 'test-model',
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it('should reuse ConfigManager instance', async () => {
    const configManager = ConfigManager.getInstance();
    const initSpy = vi.spyOn(configManager, 'initialize');

    await Agent.create({ apiKey: 'key1' });
    await Agent.create({ apiKey: 'key2' });

    // initialize() 应该只被调用一次（幂等）
    expect(initSpy).toHaveBeenCalledTimes(2);
    // 但实际加载只发生一次（内部有缓存）
  });
});
```

## Breaking Changes 说明

### 对外部 API 的影响

**Breaking Change 1: ConfigManager 构造函数变为 private**
```typescript
// ❌ 之前可以这样
const configManager = new ConfigManager();

// ✅ 现在必须这样
const configManager = ConfigManager.getInstance();
```

**Breaking Change 2: 配置更新全局生效**
```typescript
// 之前：每个实例独立
const cm1 = new ConfigManager();
const cm2 = new ConfigManager();
cm1.updateConfig({ theme: 'dark' });
// cm2 不受影响

// 现在：单例，全局生效
const cm1 = ConfigManager.getInstance();
const cm2 = ConfigManager.getInstance();
cm1.updateConfig({ theme: 'dark' });
// cm1 === cm2，都受影响
```

### 迁移指南

如果您的代码中有：
```typescript
const configManager = new ConfigManager();
```

请改为：
```typescript
const configManager = ConfigManager.getInstance();
```

测试代码中，如果需要隔离每个测试：
```typescript
beforeEach(() => {
  ConfigManager.resetInstance();
});
```

## 相关文件

需要修改的文件：
- ✅ `src/config/ConfigManager.ts` - 实现单例模式
- ✅ `src/agent/types.ts` - 类型定义
- ✅ `src/agent/Agent.ts` - Agent 实现
- ⚠️ `src/ui/hooks/useCommandHandler.ts` - 使用单例
- ⚠️ `src/ui/hooks/useAppInitializer.ts` - 使用单例
- ⚠️ `src/ui/components/ThemeSelector.tsx` - 使用单例
- ⚠️ `src/ui/App.tsx` - 使用单例
- ⚠️ `src/commands/*.ts` - 所有命令使用单例
- ✅ `tests/unit/config/ConfigManager.test.ts` - 添加单例测试
- ✅ `tests/unit/agent/Agent.test.ts` - 更新测试

## 总结

### 核心改进
1. ✅ **单例模式**: ConfigManager 全局唯一，配置只加载一次
2. ✅ **单一职责**: ConfigManager 负责配置，Agent 负责执行
3. ✅ **消除重复**: 移除 Agent 中的配置合并逻辑
4. ✅ **类型清晰**: Options = 输入，Config = 内部状态
5. ✅ **易于维护**: 配置逻辑集中，容易测试和修改

### 推荐实施顺序
1. **第一步**: 实现 ConfigManager 单例（Breaking Change）
2. **第二步**: 添加 `buildAgentConfig()` 方法
3. **第三步**: 更新所有 `new ConfigManager()` 为 `getInstance()`
4. **第四步**: 更新测试
5. **第五步**: 更新文档

### 风险评估
- ⚠️ **Breaking Change**: 需要更新所有调用方
- ✅ **风险可控**: 编译时即可发现所有需要修改的地方
- ✅ **测试覆盖**: 单例行为易于测试
- ✅ **回滚策略**: 保持 API 向后兼容的过渡期

这个重构会让配��管理更加健壮和高效！
