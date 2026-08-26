---
name: knowledge-model-and-provider-runtime-model-catalog-configuration-and-credentials
description: >
  覆盖 pi-ai 模型目录、自定义 Provider 通道、模型配置解析、fallback channel、可读 ID
  迁移和凭据存储。Navigate when: 添加或编辑模型/Provider、处理未知模型元数据、排查
  endpoint 或 API key 选择、配置 fallback、修复模型 ID 迁移。Excludes: 消息与 wire
  protocol 负载转换（见 ../provider-transport-and-context-adaptation/），重试、熔断和
  准入（见 ../provider-resilience-admission-and-observability/）。Keywords:
  PiModelCatalog, FileCredentialStore, resolveModelConfig, modelProviders, auth.json,
  fallbackModels, configId, createReadableModelId.
---

## Module Structure

该节点负责从 pi-ai 与 Blade 配置构建模型/Provider 目录，将每条模型配置解析成
Session 使用的模型能力和独立通道参数，并把敏感凭据保存在配置之外。

### Directory Layout
- `packages/cli/src/services/pi/PiModelCatalog.ts` — 内置、兼容和自定义 Provider 的可变目录
- `packages/cli/src/services/pi/catalogTypes.ts` — 对 UI/API 暴露的非敏感目录投影
- `packages/cli/src/services/pi/modelRuntime.ts` — 主模型与 fallback 模型实例化
- `packages/cli/src/services/pi/resolveModelConfig.ts` — 模型能力、选择项、凭据和 fallback channel 解析
- `packages/cli/src/services/pi/FileCredentialStore.ts` — `auth.json` 的原子安全存储
- `packages/cli/src/services/pi/endpoint.ts` — wire API 感知的 endpoint 规范化
- `packages/cli/src/config/modelIds.ts` — 模型配置 ID 生成和旧随机 ID 迁移
- `packages/cli/src/config/modelProviders.ts` — 自定义 Provider ID、协议和环境变量验证
- `packages/cli/src/services/modelAlias.ts` — CLI 模型简称解析

### Key Entry Points
- `PiModelCatalog.configureModelProviders()` in `packages/cli/src/services/pi/PiModelCatalog.ts` — 以当前配置整体重建自定义 Provider
- `PiModelCatalog.getModel()` in `packages/cli/src/services/pi/PiModelCatalog.ts` — 获取模型并按需注册兼容/自定义模型
- `resolveModelConfig()` in `packages/cli/src/services/pi/resolveModelConfig.ts` — 生成模型、显示名、能力选择和 `ChatConfig`
- `FileCredentialStore.modify()` in `packages/cli/src/services/pi/FileCredentialStore.ts` — 串行、原子更新 Provider 凭据

## Gotchas
- 自定义 Provider ID 必须匹配小写 ID 规则且不能覆盖任何启动时已注册的 pi-ai Provider；即使 wire API 相同，也必须为每个网关分配独立 ID 才能隔离 endpoint 与凭据 (`packages/cli/src/config/modelProviders.ts`, `packages/cli/src/services/pi/PiModelCatalog.ts`)
- API key 放入 `modelProviders` 会被显式拒绝；凭据键是具体 Provider channel ID，模型配置只保存非敏感路由信息 (`packages/cli/src/config/modelProviders.ts`, `packages/cli/src/services/pi/FileCredentialStore.ts`)
- fallback 只写 `provider + model` 时，只有目录中恰好存在一条匹配配置才会吸收该配置的 channel；重复匹配必须提供 `configId`，且 `configId` 指向不同 provider/model 会直接失败 (`packages/cli/src/services/pi/resolveModelConfig.ts`)
- 跨 Provider fallback 必须通过独立配置或凭据来源解析 channel；它不会沿用 primary 的 `BLADE_API_KEY`、base URL、headers、service tier 或 response verbosity (`packages/cli/src/services/pi/resolveModelConfig.ts`, `packages/cli/src/services/PiAIChatService.ts`)
- Anthropic Messages SDK 会自行追加版本路径，因此仅该 wire API 会剥离 base URL 末尾的 `/v1`；OpenAI-compatible 地址只去除尾部斜杠，不能共用同一规范化假设 (`packages/cli/src/services/pi/endpoint.ts`, `packages/cli/tests/unit/services/pi-model-runtime.test.ts`)
- 任意兼容模型可按需注册，但完全未知的模型会落到文本输入、关闭 reasoning、128K context、32K 输出和零价格；它可运行不代表能力与费用元数据准确 (`packages/cli/src/services/pi/PiModelCatalog.ts`)
- `openai-compatible` 和 `anthropic-compatible` 是兼容渠道创建入口，目录投影故意不把它们报告为已配置；多渠道场景应使用 `modelProviders`，而不是依赖这两个共享凭据键 (`packages/cli/src/services/pi/PiModelCatalog.ts`, `docs/configuration/config-system.md`)

## Architecture
- catalog 启动时注册全部 pi-ai 内置 Provider，再安装 OpenAI/Anthropic 两个兼容工厂；自定义 Provider 则把“channel ID”和“wire API”拆开，使多个同协议网关拥有独立运行时身份 (`packages/cli/src/services/pi/PiModelCatalog.ts`)
- 自定义模型若能在其他内置 Provider 找到同 ID，会按固定 Provider 优先级复用名称、reasoning、输入和 token 上限，但始终把价格清零，避免把官方价格错误套到代理渠道 (`packages/cli/src/services/pi/PiModelCatalog.ts`)
- SessionRuntime 为每个工作区复制 catalog 定义但共享安全 CredentialStore；活动 Session 因而保持创建时的 endpoint/模型快照，同时仍读取同一凭据存储 (`packages/cli/src/agent/resources/WorkspaceModelResources.ts`, `docs/reference/workspace-model-resources.md`)
- 模型配置 ID 的 SHA-256 派生环境变量优先于全局 `BLADE_API_KEY`；fallback 的 `configId` 也通过自己的派生变量解析凭据，实现同模型多通道隔离 (`packages/cli/src/services/pi/resolveModelConfig.ts`)

## Decisions
- 模型元数据不再由用户配置重复声明，而以 pi-ai catalog 为权威；`baseUrl`、temperature、输出上限、timeout 等仅作为运行时覆盖，避免静态能力字段随 Provider 更新而漂移 (`packages/cli/src/services/pi/PiModelCatalog.ts`, `packages/cli/src/services/pi/modelRuntime.ts`, `git:311ba368`)
- 旧 21 字符随机模型 ID 只在命中精确格式时迁移为可读 ID，并同步 `currentModelId`；显式可读 ID 保持不动，冲突依次增加 provider 前缀和数字后缀 (`packages/cli/src/config/modelIds.ts`, `git:847c4f08`)
- fallback 从同 Provider 隐式继承通道的旧行为只保留给没有独立 channel 的兼容情况；跨 Provider 配置在 2026-08-22 后必须保持渠道隔离 (`packages/cli/src/services/pi/resolveModelConfig.ts`, `packages/cli/src/services/PiAIChatService.ts`, `git:4dffa088`)

## Patterns
- `configureModelProviders()` 先删除旧自定义 Provider 再依据完整配置重建，调用者在配置持久化失败时必须用快照重放目录，而不是只撤销最后一次注册 (`packages/cli/src/services/pi/PiModelCatalog.ts`, `packages/cli/src/store/vanilla.ts`)
- Web/TUI 创建或编辑自定义 Provider 时先暂存目录和凭据，再提交配置；失败路径同时恢复 catalog 与旧凭据，避免出现“界面失败但密钥或 Provider 已生效”的半状态 (`packages/cli/src/server/routes/models.ts`, `packages/cli/src/server/routes/provider.ts`, `packages/cli/src/ui/components/model-config/index.tsx`)
- `resolveModelAlias()` 仅对已知简称做大小写无关替换，未知输入保持原字符串；不要把它当作目录存在性校验 (`packages/cli/src/services/modelAlias.ts`)

## Security Considerations
- `FileCredentialStore` 将目录强制为 `0700`、文件强制为 `0600`，并在进程内用 mutex 串行 read-modify-write、通过原子替换落盘；`list()` 只返回 Provider ID 与凭据类型 (`packages/cli/src/services/pi/FileCredentialStore.ts`)
- Provider 和模型 API 只投影认证能力、是否已配置及 `apiKeyEnv` 名称，不返回环境变量值或密钥；新增目录字段时必须保持这一非敏感边界 (`packages/cli/src/services/pi/catalogTypes.ts`, `packages/cli/src/server/routes/provider.ts`)
