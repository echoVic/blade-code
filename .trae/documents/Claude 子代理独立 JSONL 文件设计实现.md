## 目标

将子代理（Task/Subagent）的对话流写到独立 JSONL 文件 `agent_<id>.jsonl`，主会话 JSONL 只保留"调用记录 + 关联信息 + 摘要"。

---

## 一、类型定义扩展

### 1.1 扩展 `BladeJSONLEntry`（src/context/types.ts）

```typescript
export interface BladeJSONLEntry {
  // ... 现有字段 ...

  // === 子代理关联字段（新增） ===
  /** 父会话 ID（子代理 JSONL 必带，用于回链主会话） */
  parentSessionId?: string;
  /** 是否为侧链/子代理会话（Claude 概念兼容） */
  isSidechain?: boolean;

  // === 主会话中的子代理引用字段（新增） ===
  /** 关联的子代理会话 ID */
  subagentSessionId?: string;
  /** 子代理类型 */
  subagentType?: string;
  /** 子代理状态 */
  subagentStatus?: 'running' | 'completed' | 'failed' | 'cancelled';
  /** 子代理结果摘要（避免重复全文） */
  subagentSummary?: string;
}
```

---

## 二、存储层改造

### 2.1 新增 `SubagentPersistentStore`（src/context/storage/SubagentPersistentStore.ts）

专门处理子代理 JSONL 文件的写入，复用现有 `JSONLStore` 和 `pathUtils`。

**核心功能：**
- `getSubagentFilePath(projectPath, agentId)` → `~/.blade/projects/{escaped-path}/agent_<id>.jsonl`
- `saveMessage(agentId, ...)` - 追加消息到子代理 JSONL
- `saveToolUse(agentId, ...)` - 追加工具调用
- `saveToolResult(agentId, ...)` - 追加工具结果
- `readAll(agentId)` - 读取子代理完整对话流

**关键设计：**
- 每条 entry 必带 `sessionId = agent_<id>`、`parentSessionId`、`isSidechain = true`
- 复用 `BladeJSONLEntry` 结构，保持与主会话格式一致

### 2.2 扩展 `pathUtils.ts`

新增函数：
```typescript
export function getSubagentFilePath(projectPath: string, agentId: string): string {
  const storagePath = getProjectStoragePath(projectPath);
  const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(storagePath, `${safeId}.jsonl`);
}
```

---

## 三、子代理执行器改造

### 3.1 修改 `SubagentExecutor`（src/agent/subagents/SubagentExecutor.ts）

**改动点：**
1. 构造函数接收 `projectPath` 参数
2. 创建 `SubagentPersistentStore` 实例
3. 在 `execute()` 中：
   - 生成 `agent_<id>` 作为 sessionId
   - 通过 `runAgenticLoop` 的回调或后处理，将消息写入独立 JSONL
   - 返回结果时包含 `agentId` 供主会话引用

### 3.2 修改 `BackgroundAgentManager`（src/agent/subagents/BackgroundAgentManager.ts）

**改动点：**
1. `executeAgent()` 中使用 `SubagentPersistentStore` 写入 JSONL
2. 保留 `AgentSessionStore` 的 JSON 存储作为元数据索引（状态、统计信息）
3. 消息历史从 JSON 迁移到 JSONL（JSON 只存 metadata，不存 messages）

---

## 四、主会话引用节点

### 4.1 修改 Task 工具（src/tools/builtin/task/task.ts）

在返回结果时，添加子代理关联信息到 metadata：

```typescript
return {
  success: true,
  llmContent: result.message,
  metadata: {
    subagentSessionId: agentId,      // 新增
    subagentType: subagent_type,
    subagentStatus: 'completed',      // 新增
    subagentSummary: result.message.slice(0, 500), // 新增
    // ... 其他字段
  },
};
```

### 4.2 修改 `PersistentStore.saveToolResult()`

支持写入子代理关联字段：

```typescript
async saveToolResult(
  sessionId: string,
  toolId: string,
  toolOutput: JsonValue,
  parentUuid: string | null = null,
  error?: string,
  subagentInfo?: {  // 新增参数
    subagentSessionId: string;
    subagentType: string;
    subagentStatus: string;
    subagentSummary?: string;
  }
): Promise<string>
```

---

## 五、文件结构变更

```
src/
├── context/
│   ├── types.ts                          # 扩展 BladeJSONLEntry
│   └── storage/
│       ├── pathUtils.ts                  # 新增 getSubagentFilePath
│       ├── PersistentStore.ts            # 扩展 saveToolResult
│       └── SubagentPersistentStore.ts    # 【新建】子代理 JSONL 存储
├── agent/subagents/
│   ├── SubagentExecutor.ts               # 集成 SubagentPersistentStore
│   ├── BackgroundAgentManager.ts         # 集成 SubagentPersistentStore
│   └── AgentSessionStore.ts              # 简化：只存 metadata，不存 messages
└── tools/builtin/task/
    └── task.ts                           # 返回子代理关联信息
```

---

## 六、实现步骤

| 步骤 | 文件 | 改动内容 |
|------|------|----------|
| 1 | `src/context/types.ts` | 扩展 `BladeJSONLEntry` 添加子代理字段 |
| 2 | `src/context/storage/pathUtils.ts` | 新增 `getSubagentFilePath` 函数 |
| 3 | `src/context/storage/SubagentPersistentStore.ts` | 【新建】子代理 JSONL 存储类 |
| 4 | `src/agent/subagents/SubagentExecutor.ts` | 集成 JSONL 写入 |
| 5 | `src/agent/subagents/BackgroundAgentManager.ts` | 集成 JSONL 写入 |
| 6 | `src/agent/subagents/AgentSessionStore.ts` | 移除 messages 字段，只保留 metadata |
| 7 | `src/context/storage/PersistentStore.ts` | 扩展 `saveToolResult` 支持子代理字段 |
| 8 | `src/tools/builtin/task/task.ts` | 返回结果时添加子代理关联信息 |

---

## 七、数据流示意

```
用户请求 → 主会话 JSONL
              ↓
         Task Tool 调用
              ↓
    ┌─────────────────────┐
    │ SubagentExecutor    │
    │ 或 BackgroundAgent  │
    └─────────────────────┘
              ↓
    子代理 JSONL (agent_<id>.jsonl)
    - sessionId: agent_<id>
    - parentSessionId: 主会话 ID
    - isSidechain: true
    - 完整对话流（user/assistant/tool_use/tool_result）
              ↓
    主会话 JSONL 写入引用节点
    - type: tool_result
    - subagentSessionId: agent_<id>
    - subagentType: Explore
    - subagentStatus: completed
    - subagentSummary: "..."
```

---

## 八、预估改动量

- **新建文件**：1 个（`SubagentPersistentStore.ts`，约 150 行）
- **修改文件**：7 个
- **总代码变更**：约 300-400 行