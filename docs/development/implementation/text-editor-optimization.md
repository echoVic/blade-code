# Blade 文本编辑工具优化报告

## 变更摘要（2025-01-27）

Blade 文本编辑工具已完全对齐 Claude Code 官方标准，主要改动：

1. ✅ **Edit 工具多重匹配时直接失败**（而非警告后继续）
2. ✅ **Read-Before-Write 强制验证**（Edit/Write 前必须先 Read）
3. ✅ **Prompt 描述完全对齐官方**（使用官方英文描述）
4. ✅ **移除 MultiEdit 工具**（LLM 可自行批量调用 Edit）

---

## 技术分析与实施记录

## 一、核心架构对比

### 1. 工具定义统一性

#### Claude Code 官方实现

```javascript
// cli.js 中的工具定义
const fileEditTool = {
  name: "file_edit",
  description: "Edit files using old_string/new_string replacement",
  isConcurrencySafe: () => false,  // 🔒 禁止并发编辑
  isReadOnly: () => false,
  strict: true  // 🔒 严格模式验证
}
```

#### Blade 实现 (edit.ts:13-32)

```typescript
export const editTool = createTool({
  name: 'Edit',
  kind: ToolKind.Edit,
  schema: z.object({
    file_path: ToolSchemas.filePath(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().default(false)
  })
})
```

#### 关键差异

- ✅ Blade 使用 Zod 提供类型安全，Claude Code 使用运行时验证
- ⚠️ Blade 缺少 isConcurrencySafe 标记（可能导致并发编辑冲突）
- ✅ Blade 的 replace_all 参数与 Claude Code 一致
## 二、字符串替换算法深度对比

### 1. Claude Code 的智能替换 (hW2 函数)

```javascript
function hW2(A, B, Q, Z = false) {
  // 🎯 核心策略:使用函数回调避免 $ 特殊字符问题
  let G = Z
    ? (W, I, J) => W.replaceAll(I, () => J)  // 全部替换
    : (W, I, J) => W.replace(I, () => J);    // 单次替换
  
  if (Q !== "") return G(A, B, Q);
  
  // 🔥 特殊处理:智能换行符处理
  return !B.endsWith(`\n`) && A.includes(B + `\n`)
    ? G(A, B + `\n`, Q)
    : G(A, B, Q);
}
```

#### 设计亮点

- **函数回调替换**: 使用 () => J 避免 $ 字符被 replace() 解释为特殊语法
- **智能换行符处理**: 自动处理行尾换行符边界情况
- **统一接口**: 单次/全部替换使用同一函数签名

### 2. Blade 的简单替换 (edit.ts:146-158)

```typescript
if (replace_all) {
  // 使用 split().join() 而非 replaceAll
  newContent = content.split(old_string).join(new_string);
  replacedCount = matches.length;
} else {
  // 手动计算索引替换
  const firstMatchIndex = content.indexOf(old_string);
  newContent = content.substring(0, firstMatchIndex) +
               new_string +
               content.substring(firstMatchIndex + old_string.length);
  replacedCount = 1;
}
```

### 对比分析

| 特性 | Claude Code | Blade | 建议 |
|------|-------------|-------|------|
| 特殊字符安全 | ✅ 函数回调 | ❌ 直接拼接 | 🔧 Blade 应采用函数回调 |
| 换行符智能处理 | ✅ 自动检测 | ❌ 无 | 🔧 Blade 应添加边界检测 |
| split().join() | ❌ 不使用 | ✅ 使用 | ✅ Blade 方法更安全(避免正则) |
## 三、智能匹配算法 (ac 函数)

### Claude Code 的容错匹配

```javascript
function ac(A, B) {
  // 🎯 第一步:直接匹配
  if (A.includes(B)) return B;
  
  // 🎯 第二步:标准化引号后匹配
  let Q = fW2(B),  // 将智能引号转为普通引号
      G = fW2(A).indexOf(Q);
  
  if (G !== -1) return A.substring(G, G + B.length);
  return null;
}

// 智能引号标准化
function fW2(A) {
  return A.replaceAll(PE4, "'")	// ' → '
    .replaceAll(jE4, "'")		// ' → '
    .replaceAll(SE4, '"')		// " → "
    .replaceAll(yE4, '"');		// " → "
}
```

#### 设计理念

- **渐进式匹配**: 先直接匹配，失败后再标准化
- **引号容错**: 处理从富文本复制的智能引号
- **原文保留**: 返回原文件中的实际字符串，而非标准化后的

#### Blade 当前缺失

- ❌ 没有智能引号处理
- ❌ 没有渐进式匹配
- ❌ 匹配失败时仅返回简单错误
## 四、多层安全验证机制

### Claude Code 的 7 层验证

从您提供的源码分析，Claude Code 实现了严格的验证链：

```javascript
// 验证层 1: 文件存在性
if (!W.existsSync(Y)) {
  return { errorCode: 4, message: "File does not exist." };
}

// 验证层 2: 文件已读取状态
if (!I) {
  return { errorCode: 6, message: "Read it first before writing" };
}

// 验证层 3: 文件修改时间检查 (防止并发编辑)
if (wK(Y) > I.timestamp) {
  return { errorCode: 7, message: "File modified since read" };
}

// 验证层 4: 字符串匹配存在性
let F = ac(X, B);
if (!F) {
  return { errorCode: 8, message: "String not found" };
}

// 验证层 5: 多重匹配检查
let V = X.split(F).length - 1;
if (V > 1 && !Z) {
  return { errorCode: 9, message: `Found ${V} matches, use replace_all` };
}
```

### Blade 的验证机制

#### 当前实现

- ✅ 层 1: 文件存在性 (edit.ts:94-108)
- ✅ 层 4: 字符串匹配 (edit.ts:126-138)
- ✅ 层 5: 新旧字符串相同检查 (edit.ts:113-123)

#### 缺失的关键验证

- ❌ 层 2: 无 "Read-Before-Write" 强制验证
- ❌ 层 3: 无文件修改时间检查
- ❌ 层 5: 无多重匹配警告（只在 replace_all=false 时替换第一个）
## 五、文件历史管理系统（Claude Code 集中式快照方案）

### 快照存储目录结构

#### 基础目录
- **Claude Code 路径**：`~/.claude/file-history/`
- **Blade 适配路径**：`~/.blade/file-history/`
- **环境变量**：可通过 `CLAUDE_CONFIG_DIR` 自定义根目录

#### 目录层级示例

```
~/.blade/file-history/
├── 83d4b6f9-bc1c-4277-82b6-a5b04e62b1cb/    # 会话 ID（nanoid 生成）
│   ├── 0e524d000ce5f33d@v1                  # 文件快照 v1
│   ├── 0e524d000ce5f33d@v2                  # 文件快照 v2
│   └── a7f3c8e91d42b5a6@v1                  # 另一个文件快照
└── f2a9b8c7-e3d4-5a6b-c1f2-3e4d5a6b7c8d/
    └── 1f2e3d4c5b6a7890@v1
```

#### 快照命名规则

| 组成部分 | 生成方式 | 示例 |
|---------|---------|------|
| **会话 ID** | nanoid (21 字符) | `83d4b6f9-bc1c-4277-82b6-a5b04e62b1cb` |
| **文件哈希** | SK6(filePath, version) | `0e524d000ce5f33d` |
| **版本号** | 递增 (v1, v2, ...) | `v1` |
| **完整格式** | `{fileHash}@v{version}` | `0e524d000ce5f33d@v1` |

#### 路径构建逻辑

```typescript
// Claude Code 源码
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const snapshotPath = join(configDir, "file-history", sessionId, `${fileHash}@v${version}`);

// Blade 适配
const bladeRoot = join(homedir(), ".blade");
const snapshotPath = join(bladeRoot, "file-history", sessionId, `${fileHash}@v${version}`);
```

### Claude Code 快照机制实现

#### 1. 创建快照 (P21 函数)

```typescript
async function P21(filePath, messageId, version) {
  if (!qG()) return;  // 检查是否启用检查点

  let snapshot = eq0(filePath, version);  // 生成快照
  F.trackedFileBackups[filePath] = snapshot;
}
```

**功能**：
- 每次文件编辑前自动调用
- 检查检查点开关（配置项控制）
- 将快照元数据存储到 `trackedFileBackups` 映射

#### 2. 快照生成 (eq0 函数)

```typescript
function eq0(filePath, version) {
  let fileHash = SK6(filePath, version);  // 生成文件哈希

  if (filePath && fileHash) {
    // 构建快照路径: ~/.blade/file-history/{sessionId}/{fileHash}@v{version}
    let snapshotPath = T21(fileHash, version);

    // 读取并保存文件内容
    let content = fs.readFileSync(filePath, { encoding: "utf-8" });
    fs.writeFileSync(snapshotPath, content, { encoding: "utf-8", flush: true });
  }

  return {
    backupFileName: fileHash,
    version: version,
    backupTime: new Date()
  };
}
```

**关键点**：
- **文件哈希**：基于文件路径生成唯一标识（16 位十六进制）
- **版本递增**：每次编辑递增版本号（v1 → v2 → v3）
- **内容存储**：直接保存文件原始内容（UTF-8 编码）
- **同步刷新**：使用 `flush: true` 确保立即写入磁盘

#### 3. 回滚操作 (Sr2 函数)

```typescript
async function Sr2(sessionId, messageId) {
  // 从快照数组中查找最后匹配的快照
  let snapshot = Z.snapshots.findLast((s) => s.messageId === messageId);
  if (!snapshot) throw Error("Snapshot not found");

  // 执行恢复操作
  return kr2(sessionId, snapshot, false);
}
```

**回滚逻辑**：
- 按 **messageId** 查找快照（关联到对话消息）
- 使用 `findLast` 获取最近的匹配快照
- 调用 `kr2` 执行文件恢复

#### 4. 元数据结构

```typescript
// 已追踪文件备份映射
trackedFileBackups: {
  [filePath: string]: {
    backupFileName: string;  // 如 "0e524d000ce5f33d"
    version: number;         // 当前版本号
    backupTime: Date;        // 备份时间
  }
}

// 快照历史数组
snapshots: [
  {
    messageId: string;       // 对应的对话消息 ID
    backupFileName: string;  // 快照文件哈希
    timestamp: Date;         // 创建时间
  }
]
```

### Blade 适配方案

#### 集成点

| 集成位置 | 说明 |
|---------|------|
| **SnapshotManager** | 新建快照管理器类 |
| **EditTool.execute()** | 编辑前调用 `createSnapshot()` |
| **WriteTool.execute()** | 覆盖前调用 `createSnapshot()` |
| **ContextManager** | 传递 sessionId 给工具 |
| **PersistentStore** | 可选：将快照元数据记录到 JSONL |

#### 核心特性对比

| 特性 | Claude Code | Blade 目标方案 |
|-----|-------------|---------------|
| **存储路径** | `~/.claude/file-history/{sessionId}/` | `~/.blade/file-history/{sessionId}/` |
| **命名格式** | `{fileHash}@v{version}` | `{fileHash}@v{version}` |
| **自动快照** | ✅ 每次编辑前 | ✅ 每次编辑前 |
| **版本管理** | ✅ 递增版本号 | ✅ 递增版本号 |
| **回滚功能** | ✅ 按 messageId | ✅ 按 messageId |
| **会话隔离** | ✅ 按 sessionId 分目录 | ✅ 按 sessionId 分目录 |
| **哈希去重** | ✅ 基于文件路径 | ✅ 基于文件路径 |

#### 实现要点

1. **复用现有基础设施**：
   - 使用 `getBladeStorageRoot()` 获取 `~/.blade/`
   - 使用 `nanoid()` 生成会话 ID（已集成）
   - 与 ContextManager 共享 sessionId

2. **快照管理器设计**：
   ```typescript
   class SnapshotManager {
     private sessionId: string;
     private trackedFiles: Map<string, SnapshotMetadata>;

     async createSnapshot(filePath: string, messageId: string): Promise<void>;
     async restoreSnapshot(filePath: string, messageId: string): Promise<void>;
     async listSnapshots(filePath: string): Promise<Snapshot[]>;
     async cleanup(keepCount: number): Promise<void>;
   }
   ```

3. **不考虑向后兼容**：
   - 直接移除 Write 工具的分散式备份（`.backup.{timestamp}`）
   - 统一采用集中式快照管理
   - 旧备份文件不自动迁移
## 六、差异可视化

### Claude Code 的 Patch 生成

```javascript
// 代码片段展示
function gW2(A, B, Q, Z = 4) {
  let Y = (A.split(B)[0] ?? "").split(/\r?\n/).length - 1,
      W = hW2(A, B, Q).split(/\r?\n/),
      I = Math.max(0, Y - Z),
      J = Y + Z + Q.split(/\r?\n/).length;
  
  return {
    snippet: W.slice(I, J).join(`\n`),
    startLine: I + 1
  };
}
```

#### 功能

- 展示替换前后 ±4 行的上下文
- 生成 unified diff 格式
- 语法高亮显示变更

#### Blade 缺失

- ❌ 无差异可视化
- ❌ 无代码片段展示
- ✅ 仅显示替换次数和文件大小变化
## 七、改进建议 (Plan Mode)

基于以上深度对比，我为 Blade 项目总结了以下改进方向：

### 🔴 高优先级 (安全性与核心功能)

#### [1] 实现集中式快照管理（Claude Code 标准）
- **新建**：`src/tools/builtin/file/SnapshotManager.ts` 快照管理器类
- **存储路径**：`~/.blade/file-history/{sessionId}/{fileHash}@v{version}`
- **快照生成**：基于文件路径生成哈希（SK6 算法），版本号递增
- **自动快照**：每次 Edit/Write 前自动创建
- **元数据管理**：维护 `trackedFileBackups` 和 `snapshots` 数组
- **会话隔离**：按 sessionId 分目录存储
- **清理策略**：会话结束后可选清理旧快照
- **集成点**：
  - EditTool.execute() 编辑前调用 createSnapshot()
  - WriteTool.execute() 覆盖前调用 createSnapshot()
  - ContextManager 传递 sessionId
- **不考虑向后兼容**：直接移除 Write 工具的分散式备份（`.backup.{timestamp}`）

#### [2] 添加 Read-Before-Write 验证
- **新建**：`src/tools/builtin/file/FileAccessTracker.ts`
- **功能**：
  - 维护已读文件的时间戳映射 `Map<filePath, timestamp>`
  - 编辑前检查文件是否已通过 ReadTool 读取
  - 检查文件修改时间是否晚于读取时间
- **配置项**（添加到 `src/config/defaults.ts`）：
  ```typescript
  editSafety: {
    strictReadBeforeWrite: false,   // 默认宽松模式
    checkFileModification: true,    // 检查文件修改时间
    requireConfirmation: true       // 覆盖文件需要确认
  }
  ```

#### [3] 实现智能引号标准化
- **修改位置**：`src/tools/builtin/file/edit.ts`
- **新增函数**：`normalizeQuotes()` 在 findMatches 前调用
- **支持的引号转换**：
  - `'` `'` → `'` (单引号)
  - `"` `"` → `"` (双引号)
- **匹配策略**：先直接匹配，失败后标准化匹配
- **保留原文**：返回文件中原始字符串（不改变格式）

#### [4] 添加并发安全标记
- **修改位置**：`src/tools/execution/ExecutionPipeline.ts`
- **工具定义**：在 editTool 和 writeTool 中添加 `isConcurrencySafe: false`
- **文件锁机制**：
  - 维护文件锁映射 `Map<filePath, Promise>`
  - 同一文件的编辑操作排队执行
  - 不同文件可并发编辑
- **集成位置**：Pipeline 的 Permission 阶段检查文件锁

### 🟡 中优先级 (用户体验)

#### [5] 增强多重匹配警告
- **修改位置**：`src/tools/builtin/file/edit.ts`
- **功能**：
  - 当 `replace_all=false` 且发现多个匹配时
  - 显示所有匹配位置的行号
  - 明确提示使用 `replace_all=true` 或提供更多上下文

#### [6] 实现差异可视化
- **修改位置**：`src/tools/builtin/file/edit.ts`
- **功能**：
  - 集成 `diff` 或 `jsdiff` 库
  - 显示替换前后 ±4 行的上下文
  - 复用 CodeHighlighter 组件高亮差异
  - 仅在 displayContent 中展示（不影响 LLM）

### 🟢 低优先级 (扩展性)

#### [7] 添加空白字符标准化
- **功能**：
  - 实现 `normalizeWhitespace()` 处理行尾空白
  - 支持 CRLF/LF 自动转换
  - 可选配置（默认关闭）

#### [8] 实现回滚功能
- **新建**：`src/tools/builtin/file/undoEdit.ts`
- **功能**：
  - 新增 UndoEdit 工具
  - 支持按 messageId 回滚
  - 列出可回滚的历史版本
  - 集成到 UI 显示编辑历史

#### [9] 智能换行符处理
- **功能**：
  - 参考 Claude Code 的边界检测逻辑
  - 自动处理 `old_string` 末尾的换行符
  - 减少用户的认知负担
## 八、实现优先级矩阵

```
  影响范围
    大  │  [1] 集中式快照管理 ⭐   [6] 差异可视化
        │  [2] Read-Before-Write    [8] 回滚功能
        │  [3] 智能引号标准化
   小   │  [4] 并发安全标记         [7] 空白字符标准化
        │  [5] 多重匹配警告         [9] 智能换行符
        └────────────────────────────────────────
           低                        高
                   实现难度
```

**建议实施顺序**：

### 第一批：核心安全功能（高优先级 🔴）
1. **[1] 集中式快照管理** ⭐ - 最重要！
   - 理由：Claude Code 的核心机制，影响范围最大
   - 前置依赖：无
   - 预计工作量：2-3 天

2. **[4] 并发安全标记**
   - 理由：防止并发编辑冲突
   - 前置依赖：无
   - 预计工作量：1 天

3. **[2] Read-Before-Write 验证**
   - 理由：防止误编辑和数据丢失
   - 前置依赖：无
   - 预计工作量：1-2 天

4. **[3] 智能引号标准化**
   - 理由：提升用户体验，减少匹配失败
   - 前置依赖：无
   - 预计工作量：0.5 天

### 第二批：用户体验优化（中优先级 🟡）
5. **[5] 多重匹配警告**
   - 理由：帮助用户避免误操作
   - 前置依赖：无
   - 预计工作量：0.5 天

6. **[6] 差异可视化**
   - 理由：直观展示变更内容
   - 前置依赖：无
   - 预计工作量：1-2 天

### 第三批：扩展功能（低优先级 🟢）
7. **[7] 空白字符标准化**
   - 理由：可选功能
   - 前置依赖：无
   - 预计工作量：0.5 天

8. **[8] 回滚功能**
   - 理由：依赖快照系统
   - 前置依赖：[1] 集中式快照管理
   - 预计工作量：1-2 天

9. **[9] 智能换行符处理**
   - 理由：边缘优化
   - 前置依赖：无
   - 预计工作量：0.5 天

**总预计工作量**：7-13 天（按批次实施）

## 九、总结

### Blade 的优势
✅ **类型安全**：使用 Zod Schema 提供编译时和运行时类型检查
✅ **元数据追踪**：丰富的执行元数据（文件大小变化、替换次数等）
✅ **错误消息**：清晰的错误提示和用户友好的显示内容
✅ **中止信号支持**：完善的 AbortSignal 集成，支持取消操作

### Claude Code 的优势
✅ **完善的安全验证体系**：7 层验证（文件存在、已读检查、修改时间、字符串匹配等）
✅ **智能容错匹配**：支持智能引号标准化、换行符边界检测
✅ **自动快照和回滚**：集中式快照管理，按 messageId 回滚
✅ **差异可视化**：显示替换前后代码片段（±4 行上下文）
✅ **并发冲突检测**：`isConcurrencySafe: false` 标记防止并发编辑

### 关键差距与改进方向

#### 🔴 最关键：集中式快照管理
- **现状**：Blade 使用分散式备份（`.backup.{timestamp}`），仅 Write 工具可选
- **目标**：采用 Claude Code 的 `~/.blade/file-history/{sessionId}/{fileHash}@v{version}` 方案
- **优势**：会话隔离、版本管理、自动快照、按消息回滚
- **实施策略**：**不考虑向后兼容**，直接移除旧备份机制

#### 🔴 安全性差距
- **Read-Before-Write 验证**：Blade 未强制要求编辑前先读取文件
- **文件修改检测**：Blade 未检查文件是否在读取后被外部修改
- **并发控制**：Blade 未防止同时编辑同一文件的冲突

#### 🟡 容错性差距
- **智能引号处理**：Blade 不支持富文本复制的智能引号（`'` `"` 等）
- **换行符边界检测**：Blade 未处理 `old_string` 末尾换行符的特殊情况

#### 🟢 可视化差距
- **差异展示**：Blade 仅显示替换次数，Claude Code 展示代码片段和上下文

### 实施路线图

#### ✅ 阶段 1：核心快照系统（已完成）
1. ✅ 创建 `SnapshotManager` 类
2. ✅ 实现 `~/.blade/file-history/{sessionId}/` 目录结构
3. ✅ 集成到 Edit 和 Write 工具
4. ✅ 移除旧的 `.backup.*` 机制

**完成时间**：2025-01-26

#### ✅ 阶段 2：安全加固（已完成）
1. ✅ 实现 `FileAccessTracker` 跟踪已读文件
2. ✅ 添加 Read-Before-Write 验证（宽松模式，仅警告）
3. ✅ 实现文件锁和并发控制（`FileLockManager`）
4. ✅ 添加智能引号标准化

**完成时间**：2025-01-26

#### ✅ 阶段 3：用户体验优化（已完成）
1. ✅ 增强多重匹配警告（显示所有匹配位置的行号和列号）
2. ✅ 实现差异可视化
   - 后端：使用 `diff` 库生成 unified diff 格式
   - 前端：创建 `DiffRenderer` 组件，语法高亮显示差异
   - 显示 ±4 行上下文
3. ✅ 添加回滚工具（`UndoEdit`）
   - 支持按 `message_id` 回滚文件
   - 支持列出文件的所有历史版本

**完成时间**：2025-01-26

**总工作量**：3 天（已全部完成）

---

## 实施总结

### ✅ 已完成功能（2025-01-27 更新）

1. **集中式快照管理**
   - 路径：`~/.blade/file-history/{sessionId}/`
   - 文件命名：`{fileHash}@v{version}`
   - 自动清理旧快照（保留最近 10 个）

2. **安全验证体系**（对齐 Claude Code 官方）
   - ✅ Read-Before-Write 验证（**强制模式** - 未 Read 直接失败）
   - ✅ 多重匹配强制失败（**强制唯一性** - 找到多个匹配直接失败）
   - ✅ 文件修改时间检查
   - ✅ 智能引号标准化（支持富文本引号）
   - ✅ 文件锁机制（防止并发编辑冲突）

3. **用户体验优化**
   - ✅ 多重匹配详细错误提示（显示所有匹配位置行:列）
   - ✅ Diff 可视化（unified diff 格式 + 语法高亮）
   - ✅ 回滚工具（UndoEdit）

4. **工具简化**
   - ❌ 移除 MultiEdit 工具（不必要，LLM 可批量调用 Edit）

### 文件变更清单（2025-01-27 更新）

**新增文件**（历史记录）：
- `src/tools/builtin/file/SnapshotManager.ts` - 快照管理器
- `src/tools/builtin/file/FileAccessTracker.ts` - 文件访问追踪器
- `src/tools/builtin/file/FileLockManager.ts` - 文件锁管理器
- `src/tools/builtin/file/undoEdit.ts` - 回滚工具
- `src/ui/components/DiffRenderer.tsx` - Diff 渲染组件

**本次修改文件**（对齐官方）：

- ✅ `src/tools/builtin/file/edit.ts` - 多重匹配强制失败、Read-Before-Write 强制验证、Prompt 对齐
- ✅ `src/tools/builtin/file/write.ts` - Read-Before-Write 强制验证、Prompt 对齐
- ✅ `src/tools/builtin/file/read.ts` - Prompt 对齐官方描述
- ✅ `src/tools/builtin/index.ts` - 移除 MultiEdit 工具注册
- ✅ `src/tools/builtin/file/index.ts` - 移除 MultiEdit 工具导出

**删除文件**：

- ❌ `src/tools/builtin/file/multiEdit.ts` - 移除 MultiEdit 工具

**依赖更新**：

- 保留：`diff@8.0.2` - 用于生成 unified diff

### 下一步建议

所有核心功能已完成！后续可以考虑：

1. **文档完善**：为用户编写 UndoEdit 工具的使用指南
2. **测试覆盖**：为新增功能编写单元测试和集成测试
3. **性能优化**：监控大文件编辑时的快照性能
4. **用户反馈**：收集用户对 Diff 可视化的反馈并优化显示效果