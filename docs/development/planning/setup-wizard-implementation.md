# 首次使用 API 设置流程 - 完整实现方案

> 本文档描述首次启动 Blade 时的交互式 API 配置向导实现方案

**状态**: 已批准 ✅
**创建时间**: 2025-10-14
**最后更新**: 2025-10-14

---

## 📋 需求概述

### 目标

首次启动 Blade 时，通过交互式向导引导用户完成 API 配置

### 核心流程

1. 选择 API 提供商（OpenAI Compatible / Anthropic）
2. 填写 baseUrl（根据提供商自动填充默认值）
3. 填写 apiKey（隐藏输入）
4. 填写 model（根据提供商提供推荐选项）
5. 显示配置摘要并确认
6. 保存到 `~/.blade/config.json`

### 设计原则

- ✅ 首次启动自动引导（无需独立 setup 命令）
- ✅ 配置持久化到用户目录
- ✅ 支持多提供商架构（Anthropic 暂时伪实现）
- ✅ 后续修改通过编辑配置文件（暂不支持 CLI 可视化修改）

---

## 🏗️ 架构设计

### 1. 配置系统扩展

#### 添加 provider 字段支持多提供商

```
BladeConfig
├── provider: 'openai-compatible' | 'anthropic'  [新增]
├── apiKey: string
├── baseUrl: string
├── model: string
└── ... 其他字段
```

#### Provider 预设配置

```typescript
PROVIDER_PRESETS = [
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    defaultBaseUrl: 'https://apis.iflow.cn/v1',
    defaultModel: 'qwen3-coder-plus'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-sonnet-20240229'
  }
]
```

### 2. ChatService 重构为多提供商架构

```
IChatService (接口抽象)
├── OpenAIChatService (实现 - 当前逻辑)
└── AnthropicChatService (伪实现 - 抛出友好错误)

createChatService(config) → 工厂函数根据 provider 创建实例
```

### 3. SetupWizard 组件设计

```
SetupWizard (全屏交互式向导)
├── Step 1: ProviderSelector (SelectInput)
├── Step 2: BaseUrlInput (TextInput + 预设快捷选项)
├── Step 3: ApiKeyInput (PasswordInput 隐藏显示)
├── Step 4: ModelInput (TextInput + 推荐选项)
└── Step 5: ConfirmationView (显示摘要 + Y/N 确认)
```

### 4. 首次启动流程

```
启动 Blade
  ↓
useAppInitializer
  ↓
检查 apiKey
  ↓
[无配置] → setShowSetupWizard(true)
  ↓
BladeInterface 渲染 SetupWizard
  ↓
用户完成设置
  ↓
ConfigManager.saveUserConfig()
  ↓
刷新配置 → 隐藏向导 → 正常使用
```

---

## 📝 详细实现清单

### 一、配置系统扩展 (Foundation)

#### 1.1 修改配置类型 `src/config/types.ts`

**修改内容**：
- 在 `BladeConfig` 接口中添加 `provider` 字段
- 位置：`apiKey` 字段之前
- 类型：`'openai-compatible' | 'anthropic'`

```typescript
export interface BladeConfig {
  // 认证
  provider: 'openai-compatible' | 'anthropic';  // 新增
  apiKey: string;
  baseUrl: string;
  // ... 其他字段保持不变
}
```

---

#### 1.2 修改默认配置 `src/config/defaults.ts`

**修改内容**：
1. 添加 `provider` 默认值到 `DEFAULT_CONFIG`
2. 添加 `BLADE_PROVIDER` 环境变量映射

```typescript
export const DEFAULT_CONFIG: BladeConfig = {
  // 认证
  provider: 'openai-compatible',  // 新增默认值
  apiKey: '',
  baseUrl: 'https://apis.iflow.cn/v1',
  // ... 其他字段保持不变
};

export const ENV_VAR_MAPPING: Record<string, keyof BladeConfig> = {
  BLADE_PROVIDER: 'provider',  // 新增环境变量映射
  BLADE_API_KEY: 'apiKey',
  BLADE_BASE_URL: 'baseUrl',
  // ... 其他映射保持不变
};
```

---

#### 1.3 创建 Provider 预设配置 `src/config/providers.ts` (新建)

**文件功能**：
- 定义 Provider 元数据和预设配置
- 提供默认 baseUrl 和 model
- 提供推荐模型列表
- 提供辅助函数供 SetupWizard 使用

**关键类型和常量**：

```typescript
export type ProviderType = 'openai-compatible' | 'anthropic';

export interface ProviderPreset {
  id: ProviderType;
  name: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  modelOptions: string[];
  supportsStreaming: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    description: '兼容 OpenAI API 协议的服务商（千问、火山引擎等）',
    defaultBaseUrl: 'https://apis.iflow.cn/v1',
    defaultModel: 'qwen3-coder-plus',
    modelOptions: ['qwen3-coder-plus', 'qwen-plus', 'qwen-turbo', 'qwen-max'],
    supportsStreaming: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude API (暂未实现，敬请期待)',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-sonnet-20240229',
    modelOptions: [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ],
    supportsStreaming: true,
  },
];

export function getProviderPreset(providerId: ProviderType): ProviderPreset;
export function getProviderSelectItems();
```

---

#### 1.4 扩展 ConfigManager - 添加持久化方法 `src/config/ConfigManager.ts`

**新增方法**：

```typescript
/**
 * 保存配置到用户配置文件
 * 路径: ~/.blade/config.json
 */
async saveUserConfig(updates: Partial<BladeConfig>): Promise<void>
```

**功能实现**：
1. 创建 `~/.blade` 目录（如不存在）
2. 读取现有 `config.json`（如存在）
3. 合并新配置
4. 只保存基础配置字段（provider, apiKey, baseUrl, model 等）
5. 写入文件，设置权限为 `0600`（仅用户可读写）
6. 更新内存配置

**修改现有方法**：

```typescript
async updateConfig(updates: Partial<BladeConfig>): Promise<void> {
  // 调用 saveUserConfig 实现持久化
  await this.saveUserConfig(updates);
}
```

**修复的 Bug**：
- ✅ `blade config set` 命令现在可以持久化
- ✅ ThemeSelector 保存主题现在可以持久化

---

### 二、ChatService 重构 (Multi-Provider Support)

#### 2.1 创建 ChatService 接口抽象 `src/services/ChatServiceInterface.ts` (新建)

**文件功能**：
- 定义统一的 `IChatService` 接口
- 提供 `createChatService` 工厂函数

**接口定义**：

```typescript
export interface IChatService {
  chat(messages: Message[], tools?: any[]): Promise<ChatResponse>;
  streamChat(messages: Message[], tools?: any[]): AsyncGenerator<StreamChunk>;
}
```

**工厂函数**：

```typescript
export function createChatService(
  config: ChatConfig & { provider: string }
): IChatService {
  switch (config.provider) {
    case 'openai-compatible':
      return new OpenAIChatService(config);
    case 'anthropic':
      throw new Error('❌ Anthropic provider 暂未实现...');
    default:
      console.warn(`未知 provider: ${config.provider}, 回退到 openai-compatible`);
      return new OpenAIChatService(config);
  }
}
```

---

#### 2.2 重构现有 ChatService `src/services/ChatService.ts`

**修改内容**：
1. 添加 `implements IChatService`
2. 导出别名 `OpenAIChatService`
3. 其他代码保持不变

```typescript
import type { IChatService } from './ChatServiceInterface.js';

export class ChatService implements IChatService {
  // ... 现有代码保持不变
}

export { ChatService as OpenAIChatService };
```

---

#### 2.3 创建 Anthropic 伪实现 `src/services/AnthropicChatService.ts` (新建)

**文件功能**：
- 实现 `IChatService` 接口（方法抛出未实现错误）
- 包含详细的 TODO 和未来实现参考代码
- 提供文档链接

**实现策略**：
- 方法抛出 `Error('Not implemented')`
- 注释中提供完整的伪代码参考
- 包含 Anthropic API 文档链接

---

#### 2.4 修改 Agent 使用 ChatService 工厂 `src/agent/Agent.ts`

**修改位置**：`initialize()` 方法中创建 ChatService 的代码

**修改前**：
```typescript
this.chatService = new ChatService({
  apiKey: this.config.apiKey,
  // ...
});
```

**修改后**：
```typescript
import { createChatService } from '../services/ChatServiceInterface.js';

this.chatService = createChatService({
  apiKey: this.config.apiKey,
  model: this.config.model,
  baseUrl: this.config.baseUrl,
  temperature: this.config.temperature,
  maxContextTokens: this.config.maxContextTokens,
  timeout: this.config.timeout,
  provider: this.config.provider, // 新增
});
```

---

### 三、SetupWizard 组件实现 (Interactive UI)

#### 3.1 创建 SetupWizard 组件 `src/ui/components/SetupWizard.tsx` (新建)

**组件功能**：
- 5 步交互式设置流程
- 自动填充默认值
- 实时输入验证
- 密码遮罩输入
- 配置摘要预览
- ESC 返回上一步
- 友好的错误提示

**组件结构**：

```typescript
interface SetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

type SetupStep = 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'confirm';

export const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete, onCancel }) => {
  const [currentStep, setCurrentStep] = useState<SetupStep>('provider');
  const [config, setConfig] = useState<Partial<SetupConfig>>({});
  const [inputValue, setInputValue] = useState('');
  // ...
}
```

**步骤实现**：

1. **Step 1: Provider 选择**
   - 使用 `SelectInput` 组件
   - 选项来自 `getProviderSelectItems()`
   - 选择后自动填充默认 baseUrl 和 model

2. **Step 2: Base URL 输入**
   - 使用 `TextInput` 组件
   - 预填充 provider 的默认值
   - URL 格式验证

3. **Step 3: API Key 输入**
   - 使用 `TextInput` 组件，`mask="*"` 隐藏输入
   - 非空验证

4. **Step 4: Model 输入**
   - 使用 `TextInput` 组件
   - 显示推荐模型列表
   - 预填充默认值

5. **Step 5: 确认配置**
   - 显示配置摘要（API Key 只显示前 8 位）
   - Y 确认，N 返回修改
   - 调用 `ConfigManager.saveUserConfig()` 保存

**按键处理**：
- `ESC`: 返回上一步或退出
- `Enter`: 确认当前步骤
- `Y/N`: 确认步骤中的选择

---

### 四、集成到应用初始化流程 (Integration)

#### 4.1 修改 useAppInitializer Hook `src/ui/hooks/useAppInitializer.ts`

**新增状态**：
```typescript
const [showSetupWizard, setShowSetupWizard] = useState(false);
```

**修改逻辑**：
```typescript
if (!config.apiKey || config.apiKey.trim() === '') {
  setHasApiKey(false);
  setShowSetupWizard(true);  // 显示设置向导
  setIsInitialized(true);
  return;  // 不再显示错误消息
}
```

**新增返回值**：
```typescript
return {
  // ...
  showSetupWizard,  // 新增
};
```

---

#### 4.2 修改 BladeInterface 组件 `src/ui/components/BladeInterface.tsx`

**获取状态**：
```typescript
const { isInitialized, hasApiKey, showSetupWizard } = useAppInitializer(
  addAssistantMessage,
  debug
);
```

**条件渲染**：
```typescript
// 如果显示设置向导，渲染 SetupWizard 组件
if (showSetupWizard) {
  return (
    <SetupWizard
      onComplete={handleSetupComplete}
      onCancel={handleSetupCancel}
    />
  );
}

// ... 现有的主界面渲染代码
```

**回调实现**：
```typescript
const handleSetupComplete = async () => {
  const configManager = ConfigManager.getInstance();
  await configManager.initialize();
  // 重新加载应用或刷新页面
  window.location.reload();
};

const handleSetupCancel = () => {
  addAssistantMessage('❌ 设置已取消');
  process.exit(0);
};
```

---

### 五、类型定义更新 (TypeScript Support)

#### 5.1 更新 ChatConfig 类型 `src/services/ChatService.ts`

**修改内容**：
```typescript
export type ChatConfig = Pick<
  BladeConfig,
  'apiKey' | 'model' | 'baseUrl' | 'temperature' | 'maxContextTokens' | 'timeout' | 'provider'  // 新增 provider
>;
```

---

## 📦 依赖检查

**现有依赖**：
```json
{
  "dependencies": {
    "ink-select-input": "^5.0.0",  // ✅ 已安装
    "ink-text-input": "^5.0.1"     // ✅ 已安装
  }
}
```

**结论**: 无需安装新依赖 ✅

---

## 🧪 测试计划

### 手动测试流程

#### 1. 首次启动测试

```bash
# 删除现有配置
rm -rf ~/.blade/config.json

# 启动 Blade
npm run build && npm run start

# 预期: 显示 SetupWizard
```

#### 2. 完整设置流程

- 选择 "OpenAI Compatible"
- 输入 baseUrl (使用默认值)
- 输入 API Key
- 输入 model (使用默认值)
- 确认配置
- 预期: 保存成功，进入正常使用

#### 3. 配置文件验证

```bash
cat ~/.blade/config.json
# 预期: 包含 provider, apiKey, baseUrl, model 字段

ls -l ~/.blade/config.json
# 预期: 权限为 -rw------- (600)
```

#### 4. 后续启动测试

```bash
npm run start
# 预期: 直接进入正常使用，不显示向导
```

#### 5. Anthropic 选择测试

- 删除配置文件
- 重新启动
- 选择 "Anthropic"
- 完成设置
- 发送消息
- 预期: 抛出友好错误提示 "Anthropic provider 暂未实现"

---

## 📂 文件清单总结

### 新建文件 (4 个)

1. ✅ `src/config/providers.ts` - Provider 预设配置
2. ✅ `src/services/ChatServiceInterface.ts` - ChatService 接口抽象
3. ✅ `src/services/AnthropicChatService.ts` - Anthropic 伪实现
4. ✅ `src/ui/components/SetupWizard.tsx` - 设置向导组件

### 修改文件 (7 个)

1. ✅ `src/config/types.ts` - 添加 provider 字段
2. ✅ `src/config/defaults.ts` - 添加默认 provider 和环境变量映射
3. ✅ `src/config/ConfigManager.ts` - 添加 saveUserConfig() 方法
4. ✅ `src/services/ChatService.ts` - 实现 IChatService 接口
5. ✅ `src/agent/Agent.ts` - 使用工厂函数创建 ChatService
6. ✅ `src/ui/hooks/useAppInitializer.ts` - 添加 showSetupWizard 状态
7. ✅ `src/ui/components/BladeInterface.tsx` - 集成 SetupWizard

---

## 🎯 核心特性总结

### ✅ 已实现功能

1. **配置持久化** - ConfigManager.saveUserConfig()
2. **多提供商架构** - Provider 预设 + 工厂模式
3. **交互式向导** - 5 步设置流程
4. **首次启动检测** - 自动显示向导
5. **安全存储** - 配置文件权限 600
6. **向后兼容** - 默认 openai-compatible
7. **友好错误** - Anthropic 暂未实现提示

### ⏳ 待实现功能（不在本次范围）

1. ❌ CLI 可视化配置修改（后期考虑）
2. ❌ Anthropic API 实际实现（等待需求）
3. ❌ 配置迁移向导（未来优化）

---

## 🚀 实现顺序

建议按以下顺序实现（自底向上）：

1. **配置层** (Foundation)
   - types.ts
   - defaults.ts
   - providers.ts (新建)
   - ConfigManager.ts (扩展)

2. **服务层** (Service)
   - ChatServiceInterface.ts (新建)
   - ChatService.ts (重构)
   - AnthropicChatService.ts (新建)
   - Agent.ts (修改)

3. **UI 层** (View)
   - SetupWizard.tsx (新建)
   - useAppInitializer.ts (修改)
   - BladeInterface.tsx (修改)

4. **测试验证** (Test)
   - 手动测试完整流程
   - 验证配置文件
   - 验证权限设置

---

## 📝 注意事项

1. **配置文件权限** - 必须设置为 0600
2. **API Key 安全** - 使用 mask 输入，不显示明文
3. **错误处理** - 每个步骤都有验证和错误提示
4. **向后兼容** - 默认 provider 确保旧配置正常工作
5. **友好提示** - Anthropic 选择后有清晰的未实现提示

---

## ✅ 方案优势

1. **用户体验优先** - 首次启动自动引导
2. **架构清晰** - 多提供商架构为未来扩展铺路
3. **安全可靠** - 配置文件权限保护
4. **简洁高效** - 不添加冗余命令
5. **易于维护** - 代码结构清晰，职责分明

---

## 🔗 相关文档

- [配置系统文档](../../public/configuration/config-system.md)
- [架构设计文档](../architecture/tool-system.md)
- [开发指南](../../contributing/README.md)

---

## 📅 版本历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|---------|
| 1.0 | 2025-10-14 | AI Assistant | 初始版本 |
