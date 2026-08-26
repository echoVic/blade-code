---
name: knowledge-shared-api-and-runtime-schemas
description: >
  覆盖 Server/Web 共用 TypeBox 请求响应合约、Runtime 解析包装、默认值与未知字段清理、工具 JSON Schema 投影。
  使用时机：新增 API 字段或事件、修改请求校验、修复前后端类型漂移、定义工具参数、处理 schema 默认值或公开数据裁剪。
  不包含：Hono 路由业务流程见 interaction-surfaces/hono-server-api-and-streaming，具体工具注册见 tool-and-automation-platform/tool-contracts-and-registry。
  关键词：TypeBox, Runtime, safeParseSchema, parseSchema, StringEnum, Default, SessionSchema, BrowserActionSchema, schemaToFunctionSchema。
---

## Module Structure

该组件以 TypeBox schema 同时提供 TypeScript 静态类型、运行时输入验证和公开输出投影；Web 构建直接别名到 CLI 的 browser-safe API 源码，避免复制 DTO。

### Directory Layout
- `packages/cli/src/schema/index.ts` — `Runtime`、`Default`、`StringEnum` 和 TypeBox 导出
- `packages/cli/src/schema/validation.ts` — clone、default、validate、clean 和结构化错误
- `packages/cli/src/api/schemas.ts` — Session、Task、消息、权限、模型和设置公共合约
- `packages/cli/src/api/browserSchemas.ts` — Browser 导航与交互的封闭输入 union
- `packages/cli/src/api/teamSchemas.ts` — Team 快照和写请求合约
- `packages/cli/src/api/attachmentLimits.ts` — 多表面共享的消息与附件上限
- `packages/cli/src/api/promptCacheMetrics.ts` — Provider cache 指标的安全派生与展示
- `packages/cli/src/tools/validation/schemaToJson.ts` — Provider function schema 清理
- `packages/cli/web/vite.config.ts` — Web `@api` 到 CLI API 源码的构建别名

### Key Entry Points
- `Runtime(schema)` — 给 TypeBox schema 增加不可枚举的 `parse` / `safeParse`
- `safeParseSchema(schema, value)` — 返回 discriminated result，不抛异常
- `parseSchema(schema, value)` — 校验失败时抛 `SchemaValidationError`
- `schemaToFunctionSchema(schema)` — 生成不含 TypeBox runtime 注解的封闭 JSON Schema
- `SessionSchema` / `CreateTaskRequestSchema` / `PermissionResponseSchema` — 跨 Server/Web 高频公共合约

## API Surface

### Runtime Schema Helpers
- `Runtime(schema)` — 保留标准 JSON Schema 可序列化形状，并附加非枚举解析方法
- `Default(schema, value)` — 输入字段可省略，解析结果应用默认值
- `StringEnum(values, options?)` — 生成所有 pi-ai Provider 都能接受的字符串 enum JSON Schema
- `safeParseSchema(schema, value)` — 适合 HTTP 入口映射 4xx
- `parseSchema(schema, value)` — 适合可信内部边界和输出投影
- `SchemaValidationError.issues` — 提供解码后的字段路径、keyword、消息和原值

### Shared Contracts
- `SessionSchema` — 公开 Session 身份、lineage、任务状态和资源选择，不包含内部 lease 对象
- `CreateTaskRequestSchema` / `CreateTaskResponseSchema` — Task 默认隔离、权限模式和准入状态
- `SendMessageRequestSchema` — 消息、模型、附件与 structured output 输入边界
- `BrowserActionSchema` — Browser 交互 discriminated union，显式禁止额外属性
- `TeamSnapshotSchema` — Team 成员和任务图的跨表面只读投影

## Usage Examples

### Hono 路由验证请求
```typescript
const parsed = safeParseSchema(CreateTaskRequestSchema, body);
if (!parsed.success) {
  throw new BadRequestError('Invalid task request');
}
```

### Web 客户端验证服务端响应
```typescript
const res = await fetch(`${API_BASE}/sessions/catalog?${params.toString()}`);
if (!res.ok) throw new Error('Failed to load session catalog');
return SessionCatalogPageSchema.parse(await res.json());
```

## Gotchas
- `Runtime()` 的 `parse` 和 `safeParse` 必须保持不可枚举；若直接把方法赋到 schema，对 Provider 序列化工具声明时会泄漏非 JSON Schema 字段 (`packages/cli/src/schema/index.ts`, `packages/cli/src/tools/validation/schemaToJson.ts`)
- 解析顺序是 clone → 应用 default → 首次校验 → `Value.Clean` 删除未知字段 → 再校验；因此 schema 既会补默认值，也会把内部字段从公开响应中裁掉 (`packages/cli/src/schema/validation.ts`)
- `Default()` 刻意把输入标记为 optional、把解析后的静态类型保持为 required；改成普通 `Type.Optional` 会迫使所有下游重新处理本应已默认化的 `undefined` (`packages/cli/src/schema/index.ts`)
- `StringEnum()` 使用标准 `type: string + enum` 而不是 TypeBox 特有 union 注解，避免不同 pi-ai Provider 对函数 schema 的兼容差异 (`packages/cli/src/schema/index.ts`)
- Server 不能只校验请求而直接返回领域对象；`SessionSchema.parse()` 等输出投影负责移除 `taskWorktree`、宿主路径和其他私有字段 (`packages/cli/src/api/schemas.ts`, `packages/cli/tests/unit/integrations/api/schemas.test.ts`)
- `SessionSchema` 会为缺失的 `taskStatus` 默认 `completed`；读取旧会话时不能用字段缺失推断“未知”或“仍运行” (`packages/cli/src/api/schemas.ts`)
- `SendMessageRequestSchema` 的 1,000,000 字符上限不是内联阈值；超过 32 KiB 但未超过 4 MiB 的文本仍合法，后续由 prompt artifact 边界卸载 (`packages/cli/src/api/attachmentLimits.ts`, `packages/cli/tests/unit/integrations/api/schemas.test.ts`)
- TypeBox 只限制单附件 content，Task 路由还会累计所有附件字节并执行共享 5 MiB 上限；新增入口时必须复用同一聚合检查 (`packages/cli/src/api/schemas.ts`, `packages/cli/src/server/routes/task.ts`)
- Browser action 对象显式 `additionalProperties: false`，用于防止模型或客户端把未审阅字段带入浏览器副作用；扩展 action 必须同步修改 union，而不是旁路读取原始 body (`packages/cli/src/api/browserSchemas.ts`)
- Web 通过 `@api` 直接打包 `packages/cli/src/api`；该目录新增 Node-only 顶层依赖会破坏浏览器 bundle，即使服务端类型检查仍通过 (`packages/cli/web/vite.config.ts`)
- `schemaToFunctionSchema()` 会剥离所有 `~` runtime 注解，并递归为对象补 `additionalProperties: false`；把 Runtime schema 直接发给 Provider 会丢失这层闭合保证 (`packages/cli/src/tools/validation/schemaToJson.ts`)
- 公共 API schema 持续高频跨 Server、Web、ACP 和持久化层共改；字段重命名属于多表面迁移，不能只在 `schemas.ts` 做局部修复 (`packages/cli/src/api/schemas.ts`, `git:e7ae302d`)

## Architecture
- `packages/cli/src/schema/` 是通用运行时 schema 层，`packages/cli/src/api/` 只放跨表面安全契约；领域内部对象先投影后才能进入 HTTP、SSE 或 Web Store (`packages/cli/src/schema/index.ts`, `packages/cli/src/api/schemas.ts`)
- Hono 路由通常以 `safeParseSchema()` 把不可信输入映射为 `BadRequestError`，而 Web service 以 `.parse()` 验证成功响应，形成双向契约检查 (`packages/cli/src/server/routes/task.ts`, `packages/cli/web/src/services/sessionService.ts`)
- 大型领域合约从主文件拆到 `browserSchemas.ts` 和 `teamSchemas.ts`，但继续复用同一 Runtime helper 和 Web alias (`packages/cli/src/api/browserSchemas.ts`, `packages/cli/src/api/teamSchemas.ts`)

## Decisions
- 项目从 Zod 迁移到 TypeBox，以单份 schema 原生生成 JSON Schema 并服务工具协议，同时保留类似 `parse` 的调用体验 (`packages/cli/src/schema/index.ts`, `git:311ba368`)
- Session 公共 schema只保存稳定复合身份和可恢复 metadata，不公开内部 worktree lease、Provider 错误正文或资源句柄 (`packages/cli/src/api/schemas.ts`)
- session title 与 prompt-cache 指标放在共享 API 目录中是为了让 CLI、Web 和 ACP 使用确定性算法，而不是由各表面独立格式化 (`packages/cli/src/api/sessionTitle.ts`, `packages/cli/src/api/promptCacheMetrics.ts`)

## Consumer Analysis
- Server 路由是最大运行时校验消费者，请求使用 safe parse，领域结果使用 parse 做安全投影 (`packages/cli/src/server/routes/`)
- Web services 对 Session、Task、Team 和 Browser 响应再次解析，阻止后端漂移进入 Store (`packages/cli/web/src/services/`)
- 内置工具和工具构造器使用 TypeBox 定义参数，再转为 Provider function schema (`packages/cli/src/tools/builtin/`, `packages/cli/src/tools/core/`)
- Commands 与 CLI 复用 Runtime helper 校验 Headless 选项、JSONL 事件和配置输入 (`packages/cli/src/commands/`, `packages/cli/src/cli/`)
- MCP 与插件系统用同一解析器校验协议 payload、凭据账本和插件 manifest (`packages/cli/src/mcp/`, `packages/cli/src/plugins/`)
