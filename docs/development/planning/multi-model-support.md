# 多模型配置切换功能技术方案

## 📋 概述

实现多模型配置管理和快速切换功能，允许用户保存多组 LLM API 配置并通过 `/model` 斜杠命令进行切换。

**创建时间**: 2025-11-07
**状态**: ✅ 已批准，待实现

---

## 🎯 核心设计决策

1. ✅ **默认配置 `models: []`** - 用户必须主动添加模型配置
2. ✅ **不做配置迁移** - 简化实现，用户重新添加配置即可
3. ✅ **nanoid 自动生成 ID** - 用户无感知，内部流转使用
4. ✅ **切换显示名称，内部用 ID** - UI 显示用户友好的名称
5. ✅ **复用 SetupWizard 组件** - 通过 `mode` 参数区分初始化和添加模型场景

---

## 🏗️ 配置结构设计

### 类型定义变更

**文件**: `src/config/types.ts`

```typescript
// 新增：单个模型配置接口
export interface ModelConfig {
  id: string;              // nanoid 自动生成（如 'k3j9s2a1'）
  name: string;            // 显示名称（如 '千问工作账号'）
  provider: ProviderType;  // API 提供商
  apiKey: string;          // API 密钥（支持环境变量插值）
  baseUrl: string;         // API 端点
  model: string;           // 模型名称

  // 可选：模型特定参数
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;

  description?: string;    // 备注说明
}

// 修改：BladeConfig 接口
export interface BladeConfig {
  // === 删除这些字段 ===
  // provider: ProviderType;  ❌ 移除
  // apiKey: string;          ❌ 移除
  // baseUrl: string;         ❌ 移除
  // model: string;           ❌ 移除

  // === 新增：多模型配置 ===
  currentModelId: string;      // 当前激活的模型 ID
  models: ModelConfig[];       // 所有模型配置（默认空数组）

  // === 保留全局参数（作为未设置时的默认值） ===
  temperature: number;
  maxTokens: number;
  topP: number;
  topK: number;
  stream: boolean;
  timeout: number;

  // === 其他字段保持不变 ===
  theme: string;
  language: string;
  fontSize: number;
  debug: string | boolean;
  telemetry: boolean;
  // ...
}
```

### 默认配置

**文件**: `src/config/defaults.ts`

```typescript
export const defaultConfig: BladeConfig = {
  // 多模型配置（默认为空）
  currentModelId: '',
  models: [],

  // 全局默认参数
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1.0,
  topK: 0,
  stream: true,
  timeout: 60000,

  // ... 其他默认值保持不变
};
```

### 配置读取逻辑

**优先级规则**:
1. 使用 `models` 数组中 `currentModelId` 对应的配置
2. 如果模型配置中某参数未设置，则使用全局默认值
3. 如果 `models` 为空，抛出错误提示用户添加模型

---

## 🛠️ 实现步骤

### Phase 1: 配置层重构

#### 1.1 修改类型定义

**文件**: `src/config/types.ts`

- [ ] 添加 `ModelConfig` 接口
- [ ] 从 `BladeConfig` 删除 `provider`, `apiKey`, `baseUrl`, `model`
- [ ] 添加 `currentModelId: string` 和 `models: ModelConfig[]`

#### 1.2 修改默认配置

**文件**: `src/config/defaults.ts`

- [ ] 设置 `currentModelId: ''`
- [ ] 设置 `models: []`
- [ ] 删除 `provider`, `apiKey`, `baseUrl`, `model` 字段

#### 1.3 扩展 ConfigManager

**文件**: `src/config/ConfigManager.ts`

新增方法：

```typescript
// 1. 获取当前激活的模型配置
getCurrentModel(): ModelConfig {
  if (this.config.models.length === 0) {
    throw new Error('❌ 没有可用的模型配置，请使用 /model add 添加');
  }

  const model = this.config.models.find(m => m.id === this.config.currentModelId);
  if (!model) {
    logger.warn('当前模型 ID 无效，自动切换到第一个模型');
    return this.config.models[0];
  }

  return model;
}

// 2. 获取所有模型配置
getAllModels(): ModelConfig[] {
  return this.config.models;
}

// 3. 切换模型（通过 ID）
async switchModel(modelId: string): Promise<void> {
  const model = this.config.models.find(m => m.id === modelId);
  if (!model) {
    throw new Error(`❌ 模型配置不存在: ${modelId}`);
  }

  this.config.currentModelId = modelId;
  await this.saveUserConfig(this.config);
  logger.info(`✅ 已切换到模型: ${model.name} (${model.model})`);
}

// 4. 添加模型配置
async addModel(modelData: Omit<ModelConfig, 'id'>): Promise<ModelConfig> {
  const newModel: ModelConfig = {
    id: nanoid(),
    ...modelData,
  };

  this.config.models.push(newModel);

  // 如果是第一个模型，自动设为当前模型
  if (this.config.models.length === 1) {
    this.config.currentModelId = newModel.id;
  }

  await this.saveUserConfig(this.config);
  logger.info(`✅ 已添加模型配置: ${newModel.name}`);

  return newModel;
}

// 5. 删除模型配置
async removeModel(modelId: string): Promise<void> {
  if (this.config.models.length === 1) {
    throw new Error('❌ 不能删除唯一的模型配置');
  }

  const index = this.config.models.findIndex(m => m.id === modelId);
  if (index === -1) {
    throw new Error(`❌ 模型配置不存在`);
  }

  const name = this.config.models[index].name;
  this.config.models.splice(index, 1);

  // 如果删除的是当前模型，自动切换到第一个
  if (this.config.currentModelId === modelId) {
    this.config.currentModelId = this.config.models[0].id;
    logger.info(`已自动切换到: ${this.config.models[0].name}`);
  }

  await this.saveUserConfig(this.config);
  logger.info(`✅ 已删除模型配置: ${name}`);
}

// 6. 更新模型配置
async updateModel(
  modelId: string,
  updates: Partial<Omit<ModelConfig, 'id'>>
): Promise<void> {
  const index = this.config.models.findIndex(m => m.id === modelId);
  if (index === -1) {
    throw new Error(`❌ 模型配置不存在`);
  }

  this.config.models[index] = {
    ...this.config.models[index],
    ...updates,
  };

  await this.saveUserConfig(this.config);
  logger.info(`✅ 已更新模型配置: ${this.config.models[index].name}`);
}
```

删除方法：
- [ ] `getProvider()` ❌
- [ ] `getApiKey()` ❌
- [ ] `getBaseUrl()` ❌
- [ ] `getModel()` ❌

---

### Phase 2: Agent 适配

**文件**: `src/agent/Agent.ts`

修改 `create()` 静态方法：

```typescript
public static async create(config: RuntimeConfig): Promise<Agent> {
  // 1. 检查是否有模型配置
  if (config.configManager.getAllModels().length === 0) {
    throw new Error(
      '❌ 没有可用的模型配置\n\n' +
      '请先使用以下命令添加模型：\n' +
      '  /model add\n\n' +
      '或运行初始化向导：\n' +
      '  /init'
    );
  }

  // 2. 获取当前模型配置
  const modelConfig = config.configManager.getCurrentModel();

  logger.info(`🚀 使用模型: ${modelConfig.name} (${modelConfig.model})`);

  // 3. 创建 ChatService（使用模型配置）
  const chatService = createChatService({
    provider: modelConfig.provider,
    apiKey: modelConfig.apiKey,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    temperature: modelConfig.temperature ?? config.temperature,
    maxTokens: modelConfig.maxTokens ?? config.maxTokens,
    topP: modelConfig.topP ?? config.topP,
    topK: modelConfig.topK ?? config.topK,
    stream: config.stream,
    timeout: config.timeout,
  });

  // ... 其他初始化逻辑保持不变
}
```

**全局搜索替换**:
- [ ] 搜索所有使用 `config.provider` 的地方
- [ ] 搜索所有使用 `config.apiKey` 的地方
- [ ] 搜索所有使用 `config.baseUrl` 的地方
- [ ] 搜索所有使用 `config.model` 的地方
- [ ] 替换为使用 `configManager.getCurrentModel()` 的对应字段

---

### Phase 3: 斜杠命令实现

#### 3.1 新建 `/model` 命令

**文件**: `src/slash-commands/model.ts`

```typescript
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types';

const modelCommand: SlashCommand = {
  name: 'model',
  description: '管理和切换模型配置',
  usage: '/model [子命令] [参数]',
  fullDescription: `
管理和切换模型配置

子命令：
  (无参数)        显示模型选择器（交互式切换）
  current        显示当前模型详情
  add            添加新模型配置（交互式向导）
  remove <名称>  删除指定模型配置（按名称匹配）

示例：
  /model              # 显示模型选择器
  /model add          # 添加新模型
  /model remove 千问  # 删除名称包含"千问"的模型
  `,

  async handler(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
    const subcommand = args[0];

    // 无参数：显示模型选择器
    if (!subcommand) {
      const models = context.configManager.getAllModels();
      if (models.length === 0) {
        return {
          success: false,
          message: '❌ 没有可用的模型配置\n\n使用 /model add 添加模型',
        };
      }

      return {
        success: true,
        message: 'show_model_selector',
        data: { action: 'show_model_selector' },
      };
    }

    switch (subcommand) {
      case 'list': {
        const models = context.configManager.getAllModels();
        if (models.length === 0) {
          return {
            success: false,
            message: '❌ 没有可用的模型配置\n\n使用 /model add 添加模型',
          };
        }

        const currentId = context.configManager.getConfig().currentModelId;

        let output = '\n📋 可用模型配置：\n\n';
        for (const model of models) {
          const isCurrent = model.id === currentId;
          const marker = isCurrent ? '● ' : '○ ';
          output += `${marker}${model.name}\n`;
          output += `   Provider: ${model.provider}\n`;
          output += `   Model: ${model.model}\n`;
          output += `   Base URL: ${model.baseUrl}\n`;
          if (model.description) {
            output += `   描述: ${model.description}\n`;
          }
          output += '\n';
        }

        return { success: true, message: output };
      }

      case 'current': {
        try {
          const current = context.configManager.getCurrentModel();
          const output = `
📌 当前模型配置：

名称: ${current.name}
Provider: ${current.provider}
Model: ${current.model}
Base URL: ${current.baseUrl}
${current.description ? `描述: ${current.description}` : ''}
          `;
          return { success: true, message: output };
        } catch (error) {
          return { success: false, message: error.message };
        }
      }

      case 'add': {
        return {
          success: true,
          message: 'show_model_add_wizard',
          data: { action: 'show_model_add_wizard', mode: 'add' },
        };
      }

      case 'remove': {
        const nameQuery = args.slice(1).join(' ');
        if (!nameQuery) {
          return {
            success: false,
            message: '❌ 请指定要删除的模型名称\n用法: /model remove <名称>',
          };
        }

        const models = context.configManager.getAllModels();
        const matchedModel = models.find(m =>
          m.name.toLowerCase().includes(nameQuery.toLowerCase())
        );

        if (!matchedModel) {
          return {
            success: false,
            message: `❌ 未找到匹配的模型配置: ${nameQuery}`,
          };
        }

        try {
          await context.configManager.removeModel(matchedModel.id);
          return {
            success: true,
            message: `✅ 已删除模型配置: ${matchedModel.name}`,
          };
        } catch (error) {
          return { success: false, message: `❌ ${error.message}` };
        }
      }

      default:
        return {
          success: false,
          message: `❌ 未知的子命令: ${subcommand}\n使用 /model 查看帮助`,
        };
    }
  },
};

export default modelCommand;
```

#### 3.2 注册命令

**文件**: `src/slash-commands/index.ts`

```typescript
import modelCommand from './model';

const slashCommands: SlashCommandRegistry = {
  ...builtinCommands,
  init: initCommand,
  theme: themeCommand,
  permissions: permissionsCommand,
  model: modelCommand,  // 新增
};
```

---

### Phase 4: UI 组件开发

#### 4.1 新建 ModelSelector 组件

**文件**: `src/ui/components/ModelSelector.tsx`

功能：
- 左侧：模型列表（使用 `ink-select-input`）
- 右侧：选中模型的详细信息
- 操作：Enter 切换、D 删除、ESC 取消

关键特性：
- 焦点管理：`useFocus({ id: 'model-selector' })`
- 当前模型标记：显示 `(当前)` 后缀
- 删除保护：不能删除当前使用的模型
- 主题集成：使用 `themeManager.getTheme()`

#### 4.2 扩展 SetupWizard 组件

**文件**: `src/ui/components/SetupWizard.tsx`

新增 `mode` 参数：
- `mode='init'`：初始化模式（现有流程）
- `mode='add'`：添加模型模式（新增流程）

流程差异：

| 步骤 | init 模式 | add 模式 |
|-----|----------|---------|
| 1 | Provider 选择 | **配置名称输入** |
| 2 | Base URL | Provider 选择 |
| 3 | API Key | Base URL |
| 4 | Model | API Key |
| 5 | 确认 | Model |
| 6 | - | **描述（可选）** |
| 7 | - | 确认 |

保存逻辑差异：
- `init` 模式：保存到顶层配置（兼容老版本）+ 调用 `addModel()` 创建第一个模型
- `add` 模式：仅调用 `addModel()` 添加新模型

#### 4.3 集成到 AppContext

**文件**: `src/ui/contexts/AppContext.tsx`

新增 actions：
```typescript
showModelSelector: () => void;
showModelAddWizard: () => void;
```

修改 state：
```typescript
modalType: 'theme' | 'model' | 'model-add' | 'session' | 'permissions' | null;
```

#### 4.4 处理命令消息

**文件**: `src/ui/hooks/useCommandHandler.ts`

新增消息处理：
```typescript
if (slashResult.message === 'show_model_selector') {
  appDispatch(appActions.showModelSelector());
  return { success: true };
}

if (slashResult.message === 'show_model_add_wizard') {
  appDispatch(appActions.showModelAddWizard());
  return { success: true };
}
```

#### 4.5 渲染组件

**文件**: `src/ui/components/BladeInterface.tsx`

条件渲染：
```tsx
{showModelSelector && <ModelSelector onClose={handleCloseModal} />}
{showModelAddWizard && <SetupWizard mode="add" onComplete={handleModelAdded} onCancel={handleCloseModal} />}
```

---

### Phase 5: 初始化向导集成

修改 `/init` 命令的完成逻辑，在保存配置后同时创建第一个模型配置。

**逻辑**:
1. 用户完成 `/init` 向导
2. 保存配置到 `~/.blade/config.json`（保持向后兼容）
3. **新增**：调用 `configManager.addModel()` 创建默认模型配置
4. 设置模型名称为"默认配置"或从向导中获取

---

### Phase 6: 测试

#### 6.1 单元测试

**文件**: `tests/unit/config/ConfigManager.test.ts`

测试用例：
- [ ] `addModel()` - 添加第一个模型时自动设为当前模型
- [ ] `addModel()` - 使用 nanoid 生成唯一 ID
- [ ] `switchModel()` - 切换到存在的模型
- [ ] `switchModel()` - 切换到不存在的模型时抛出错误
- [ ] `removeModel()` - 删除非当前模型
- [ ] `removeModel()` - 删除当前模型时自动切换到第一个
- [ ] `removeModel()` - 不能删除唯一的模型
- [ ] `getCurrentModel()` - 没有模型时抛出错误
- [ ] `getCurrentModel()` - currentModelId 无效时返回第一个模型

#### 6.2 集成测试

**文件**: `tests/integration/model-switching.test.ts`

测试场景：
- [ ] 完整流程：添加模型 → 切换模型 → Agent 使用正确配置
- [ ] `/model current` 显示当前模型
- [ ] `/model remove` 删除指定模型

---

## 📦 文件清单

### 新建文件 (2 个)

- `src/slash-commands/model.ts` - `/model` 命令实现
- `src/ui/components/ModelSelector.tsx` - 模型选择器 UI 组件

### 修改文件 (9 个)

1. `src/config/types.ts` - 添加 `ModelConfig`，修改 `BladeConfig`
2. `src/config/defaults.ts` - 修改默认配置结构
3. `src/config/ConfigManager.ts` - 添加模型管理方法
4. `src/agent/Agent.ts` - 使用 `getCurrentModel()` 获取配置
5. `src/ui/components/SetupWizard.tsx` - 扩展支持 `mode='add'`
6. `src/slash-commands/index.ts` - 注册 `model` 命令
7. `src/ui/contexts/AppContext.tsx` - 添加模型相关 actions
8. `src/ui/hooks/useCommandHandler.ts` - 处理模型相关消息
9. `src/ui/components/BladeInterface.tsx` - 渲染 ModelSelector

### 测试文件 (2 个)

- `tests/unit/config/ConfigManager.test.ts` - 单元测试
- `tests/integration/model-switching.test.ts` - 集成测试

---

## ⏱️ 预估时间

- Phase 1: 配置层重构 (2-3 小时)
- Phase 2: Agent 适配 (1-2 小时)
- Phase 3: 斜杠命令 (1 小时)
- Phase 4: UI 组件 (3-4 小时)
- Phase 5: 初始化向导集成 (1 小时)
- Phase 6: 测试 (2 小时)

**总计**: 10-13 小时

---

## 🔒 向后兼容性

### 破坏性变更

1. ❌ **配置文件结构变化**：删除了 `provider`, `apiKey`, `baseUrl`, `model` 顶层字段
2. ❌ **API 变化**：`ConfigManager` 删除了 `getProvider()` 等方法

### 迁移指南

老用户需要：
1. 运行 `/init` 重新配置（会自动创建第一个模型配置）
2. 或手动使用 `/model add` 添加模型配置

### 未来改进（可选）

- 提供自动迁移脚本：将老配置转换为第一个模型配置
- 在首次启动时检测老配置并提示迁移

---

## 📝 用户体验流程

### 场景 1: 首次使用

```bash
$ blade
❌ 没有可用的模型配置

请先使用以下命令添加模型：
  /model add

或运行初始化向导：
  /init
```

### 场景 2: 添加第一个模型

```bash
$ /init
# 运行向导，完成后自动创建第一个模型配置
✅ 配置已保存到 ~/.blade/config.json
✅ 已添加模型配置: 默认配置
```

### 场景 3: 添加更多模型

```bash
$ /model add
# 进入向导
Step 1: 配置名称
> 千问工作账号

Step 2: Provider
> OpenAI Compatible

# ... 其他步骤

✅ 已添加模型配置: 千问工作账号
```

### 场景 4: 切换模型

```bash
$ /model
# 显示交互式选择器
┌─────────────────────────────────────┐
│ 选择模型配置                         │
├──────────────────┬──────────────────┤
│ ● 千问工作账号   │ 名称: 千问工作账号│
│ ○ DeepSeek 个人  │ Provider: ...    │
│                  │ Model: qwen-max  │
└──────────────────┴──────────────────┘

# Enter 切换，显示确认
✅ 已切换到模型: DeepSeek 个人 (deepseek-chat)
```

## 🚀 未来扩展

### 短期扩展（v1.1）

1. **模型分组** - 按 provider 或用途分组
2. **快捷切换** - `/model switch <名称关键词>` 快速切换
3. **模型收藏** - 标记常用模型

### 中期扩展（v1.2）

1. **模型模板** - 内置常用模型配置模板
2. **批量导入** - 从 JSON 文件导入多个模型
3. **模型验证** - 添加时测试 API 连接是否正常

### 长期扩展（v2.0）

1. **模型性能统计** - 记录每个模型的响应时间、token 使用量
2. **智能推荐** - 根据任务类型推荐合适的模型
3. **成本追踪** - 按模型统计 API 调用成本

---

## 📚 相关文档

- [配置系统架构](../architecture/config-system.md)
- [SetupWizard 组件设计](../implementation/setup-wizard.md)
- [斜杠命令系统](../architecture/slash-commands.md)

---

**文档版本**: 1.0
**最后更新**: 2025-11-07
**作者**: Claude (AI Assistant)
