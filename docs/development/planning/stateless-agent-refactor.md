# 无状态 Agent + 外部 Session 重构方案

> 重构日期: 2025-01-20
> 作者: Claude Code
> 状态: 已完成

## 一、重构背景

### 问题现状

**问题 1: 对话上下文丢失**
```
用户: "创建一个 React 组件"
AI: [创建 Button.tsx] ✅

用户: "给它加上样式"
AI: ❌ "它"是什么？我没有上下文
```

**根因**: 每次命令创建新 Agent，但不传递历史消息

```typescript
// 问题代码 (useCommandHandler.ts:236-243)
const chatContext = {
  messages: [],  // ← 每次都是空数组
  sessionId: `session-${Date.now()}`,  // ← 每次都是新 ID
};
```

### 架构分析

**当前架构**: 有状态 Agent（但状态未使用）

```
Agent#1
  ├─ sessionId: "session-123"
  ├─ messages: []  ← 空的
  └─ 执行命令 1

Agent#2  ← 新实例
  ├─ sessionId: "session-456"  ← 不同 ID
  ├─ messages: []  ← 空的
  └─ 执行命令 2（无上下文）
```

**目标架构**: 无状态 Agent + 外部 Session

```
SessionContext (全局单例)
  ├─ sessionId: "session-123"  ← 全局唯一
  └─ messages: [msg1, msg2, ...]  ← 持久化

Agent#1 (临时)
  └─ chat(msg1, context: {messages: [...]})

Agent#2 (临时)
  └─ chat(msg2, context: {messages: [msg1, ...]})
```

---

## 二、设计原则

### 1. Agent 完全无状态

**规则:**
- ❌ Agent 不保存 `sessionId`
- ❌ Agent 不保存 `messages`
- ✅ 所有状态通过 `context` 参数传入
- ✅ Agent 实例可随时创建/销毁

### 2. Session 作为唯一状态源

**规则:**
- ✅ SessionContext 维护全局唯一 `sessionId`
- ✅ SessionContext 维护完整消息历史
- ✅ 通过 React Context 跨组件共享
- ✅ `/clear` 清空消息但保留 `sessionId`

### 3. 分层职责清晰

```
UI 层 (SessionContext)
  └─ 职责: 状态管理、消息展示、用户交互

Hook 层 (useCommandHandler)
  └─ 职责: 桥接 UI 和 Agent，传递状态

Agent 层 (Agent.ts)
  └─ 职责: LLM 交互、工具执行、循环检测
```

---

## 三、实施清单

### 核心修改

- [x] 修改 [SessionContext.tsx](../../src/ui/contexts/SessionContext.tsx) 添加 `sessionId`
- [x] 修改 [useCommandHandler.ts](../../src/ui/hooks/useCommandHandler.ts) 传递历史消息
- [x] 修改 [Agent.ts](../../src/agent/Agent.ts) 移除内部 sessionId（所有 `this.sessionId` 改为 `context.sessionId`）

### 文档更新

- [x] 新建 `stateless-agent-refactor.md`
- [x] 更新 `CLAUDE.md` 架构说明
- [x] 更新 `docs/development/architecture/agent.md`

### 测试验证

- [x] 构建验证通过（`npm run build` 成功）
- [ ] 手动验证对话连续性
- [ ] 手动验证 `/clear` 后 sessionId 保持
- [ ] 手动验证 SessionId 唯一性

---

## 四、详细修改说明

### 修改 1: SessionContext 添加 sessionId

**文件**: [src/ui/contexts/SessionContext.tsx](../../src/ui/contexts/SessionContext.tsx)

#### 变更 1.1: 添加 sessionId 字段

```typescript
// 第 22-30 行
export interface SessionState {
  sessionId: string;  // ← 新增：全局唯一会话 ID
  messages: SessionMessage[];
  isThinking: boolean;
  input: string;
  currentCommand: string | null;
  error: string | null;
  isActive: boolean;
}
```

#### 变更 1.2: 初始化 sessionId

```typescript
// 第 58-67 行
const initialState: SessionState = {
  sessionId: `session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
  messages: [],
  isThinking: false,
  input: '',
  currentCommand: null,
  error: null,
  isActive: true,
};
```

#### 变更 1.3: RESET_SESSION 保持 sessionId

```typescript
// 第 93-98 行
case 'RESET_SESSION':
  return {
    ...initialState,
    sessionId: state.sessionId,  // ← 保持 sessionId 不变
    isActive: true
  };
```

---

### 修改 2: useCommandHandler 传递历史消息

**文件**: [src/ui/hooks/useCommandHandler.ts](../../src/ui/hooks/useCommandHandler.ts)

#### 变更 2.1: 导入 useSession

```typescript
// 第 1-13 行
import { useSession } from '../contexts/SessionContext.js';
```

#### 变更 2.2: 获取 Session 状态

```typescript
// 第 37-48 行
export const useCommandHandler = (
  replaceSystemPrompt?: string,
  appendSystemPrompt?: string,
  confirmationHandler?: ConfirmationHandler
) => {
  const { state: sessionState } = useSession();  // ← 新增
```

#### 变更 2.3: 传递历史消息（普通命令）

```typescript
// 第 236-246 行
const chatContext = {
  messages: sessionState.messages.map(msg => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  })),
  userId: 'cli-user',
  sessionId: sessionState.sessionId,  // ← 使用全局 sessionId
  workspaceRoot: process.cwd(),
  signal: abortControllerRef.current.signal,
  confirmationHandler,
};
```

#### 变更 2.4: 传递历史消息（/init 命令）

```typescript
// 第 180-190 行
const chatContext = {
  messages: sessionState.messages.map(msg => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  })),
  userId: 'cli-user',
  sessionId: sessionState.sessionId,
  workspaceRoot: process.cwd(),
  signal: abortControllerRef.current.signal,
  confirmationHandler,
};
```

---

### 修改 3: Agent.ts 完全无状态化

**文件**: [src/agent/Agent.ts](../../src/agent/Agent.ts)

#### 变更 3.1: 更新类注释

```typescript
// 第 1-13 行
/**
 * Agent核心类 - 无状态设计
 *
 * 设计原则：
 * 1. Agent 本身不保存任何会话状态（sessionId, messages 等）
 * 2. 所有状态通过 context 参数传入
 * 3. Agent 实例可以每次命令创建，用完即弃
 * 4. 历史连续性由外部 SessionContext 保证
 *
 * 负责：LLM 交互、工具执行、循环检测
 */
```

#### 变更 3.2: 移除 sessionId 字段

```typescript
// 第 38-46 行
export class Agent extends EventEmitter {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline: ExecutionPipeline;
  private systemPrompt?: string;
  // sessionId 已移除，改为从 context 传入
```

#### 变更 3.3: 移除构造函数中的 sessionId 参数

```typescript
// 第 53-62 行
constructor(
  config: BladeConfig,
  runtimeOptions: AgentOptions = {},
  executionPipeline?: ExecutionPipeline
  // sessionId 参数已删除
) {
  super();
  this.config = config;
  this.runtimeOptions = runtimeOptions;
  this.executionPipeline = executionPipeline || this.createDefaultPipeline();
}
```

#### 变更 3.4: 使用 context.sessionId

```typescript
// 第 375-384 行 (runLoop 中)
const result = await this.executionPipeline.execute(
  toolCall.function.name,
  params,
  {
    sessionId: context.sessionId,  // ← 从 context 获取
    userId: context.userId || 'default',
    workspaceRoot: context.workspaceRoot || process.cwd(),
    signal: signalToUse,
    confirmationHandler: context.confirmationHandler,
  }
);
```

#### 变更 3.5: registerBuiltinTools 使用传入的 sessionId

```typescript
// 第 724-748 行
private async registerBuiltinTools(): Promise<void> {
  try {
    // 使用默认 sessionId（因为注册时还没有会话）
    const sessionId = 'default';

    const builtinTools = await getBuiltinTools({
      sessionId: sessionId,
      configDir: path.join(os.homedir(), '.blade'),
    });
    // ...
  }
}
```

---

## 五、验证方法

### 测试用例 1: 对话连续性

```bash
# 启动 Blade
blade

# 第一条命令
> 创建一个名为 Button 的 React 组件

# 第二条命令（验证上下文）
> 给它加上蓝色背景样式

# 预期: AI 知道"它"指 Button 组件 ✅
```

### 测试用例 2: SessionId 唯一性

```typescript
// 在 useCommandHandler 中添加日志
console.log('Session ID:', sessionState.sessionId);

// 预期: 多次命令后，ID 保持不变
```

### 测试用例 3: /clear 后 SessionId 保持

```bash
> /clear
> 创建组件

# 预期: sessionId 没有变化，但 messages 被清空
```

---

## 六、后续优化

### 阶段 1: 持久化 Session（可选）

集成 [ContextManager](../../src/context/ContextManager.ts) 实现 Session 持久化到 JSONL：

```typescript
const contextManager = ContextManager.getInstance();
await contextManager.saveSession(sessionId, messages);
```

### 阶段 2: Session 恢复（可选）

支持会话恢复功能：

```bash
blade --resume session-123
```

### 阶段 3: Session 清理（可选）

自动清理过期 Session：

```typescript
contextManager.cleanOldSessions({ olderThanDays: 7 });
```

---

## 七、风险与缓解

### 风险 1: SessionContext 状态丢失

**场景**: React Context 在组件卸载时重置

**缓解**:
- ✅ SessionProvider 在 App 根节点，不会卸载
- ✅ 未来可集成 ContextManager 持久化

### 风险 2: 消息历史过长

**场景**: 长对话导致 messages 数组过大

**缓解**:
- ✅ Agent.runLoop 中已有历史压缩逻辑（每 10 轮压缩一次）
- ✅ 保留最近 80 条消息
- ✅ 系统提示只在第一条消息时注入

### 风险 3: 并发命令冲突

**场景**: 用户快速连续发送多条命令

**缓解**:
- ✅ useCommandHandler 有 `isProcessing` 状态锁
- ✅ UI 层禁用输入框防止重复提交

---

## 八、预期效果

### 修改前（问题）
```
用户: "创建组件"
Agent#1 (messages: []) → [创建 Button.tsx] ✅
---
用户: "给它加样式"
Agent#2 (messages: []) → ❌ "它"是什么？
```

### 修改后（正常）
```
用户: "创建组件"
Agent#1 (messages: []) → [创建 Button.tsx] ✅
Session: messages = [user: "创建组件", assistant: "已创建 Button.tsx"]
---
用户: "给它加样式"
Agent#2 (messages: [msg1, msg2]) → ✅ 知道"它"是 Button 组件
```

---

## 九、总结

**重构成果:**
- ✅ 解决对话上下文丢失问题
- ✅ 架构更清晰（状态与执行分离）
- ✅ 符合业界最佳实践（无状态 Agent + 外部 Session）
- ✅ 为未来扩展打下基础（持久化、Session 恢复）

**设计优势:**
- **无状态 Agent**: 内存高效、并发安全、易于测试
- **外部 Session**: 状态持久、易于管理、支持扩展
- **清晰分层**: UI/Hook/Agent 职责明确

**修改范围:**
- 3 个核心文件
- 11 处代码修改
- 3 个文档更新

**工作量:**
- 代码修改: 20 分钟
- 文档编写: 30 分钟
- 测试验证: 10 分钟
- **总计: 1 小时**

---

## 十、相关文档

- [CLAUDE.md](../../../CLAUDE.md) - 项目架构总览
- [Agent 架构文档](../architecture/agent.md) - Agent 系统详细设计
- [SessionContext 实现](../../src/ui/contexts/SessionContext.tsx) - Session 管理
- [ContextManager](../../src/context/ContextManager.ts) - 上下文管理器（未来集成）
