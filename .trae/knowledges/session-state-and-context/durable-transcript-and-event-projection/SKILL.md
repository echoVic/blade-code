---
name: knowledge-session-state-and-context-durable-transcript-and-event-projection
description: >
  覆盖共享会话事件组件的 JSONL 权威历史、单写者提交、seq/replay、ephemeral delta、SQLite 读侧和多端投影。
  适用于新增 SessionEvent、修改落盘顺序、修复 SSE 续传、调整目录索引或统一 TUI/Web 折叠语义。
  不含会话分叉/回退业务规则（见 ../session-catalog-fork-rewind-and-export/）和活动轮次恢复（见 ../active-turn-interactions-and-recovery/）。
  关键词：SessionEventLog, JSONLStore, PersistentStore, EphemeralDelta, conversationReducer, SQLite, CQRS, Last-Event-ID。
---

## Module Structure

该组件是 Session 跨运行时、服务和界面的共享事实层：JSONL 保存 committed event，SessionEventLog 在落盘后扇出，SQLite 和 UI reducer 仅构建可丢弃读模型。

### Directory Layout
- `packages/cli/src/context/events/`：单写者事件日志、delta 与 turn 生命周期 reducer
- `packages/cli/src/context/storage/JSONLStore.ts`：crash-safe 逐行存储、seq 分配和 validated 操作
- `packages/cli/src/context/storage/PersistentStore.ts`：领域事件构造与恢复事务
- `packages/cli/src/context/storage/sqlite/`：Bun/Node 双运行时读侧索引及 FTS
- `packages/cli/src/context/types.ts`：committed SessionEvent 联合类型
- `packages/cli/src/server/bus.ts`：committed 与 ephemeral 的进程内扇出通道
- `packages/cli/src/store/slices/sessionSlice.ts`：TUI conversation read model
- `packages/cli/web/src/store/session/handlers/eventHandlers.ts`：Web SSE 事件折叠与 delta 缓冲

### Key Entry Points
- `SessionEventLog.for()` in `packages/cli/src/context/events/SessionEventLog.ts`：获取项目路径与 Session 复合键对应的写入/扇出实例
- `JSONLStore.appendValidatedBatch()` in `packages/cli/src/context/storage/JSONLStore.ts`：在同一文件队列内校验最新状态并提交有序批次
- `projectConversation()` in `packages/cli/src/context/events/reducers/conversationReducer.ts`：从 committed history 构建 UI 消息
- `syncAll()` in `packages/cli/src/context/storage/sqlite/projection.ts`：拉取 JSONL 并同步可重建索引

## API Surface

### SessionEventLog
- `for(sessionId, projectPath)`：返回进程内共享的复合身份日志实例
- `commit(event)` / `commitBatch(events)`：先持久化和分配 seq，再按提交顺序扇出
- `commitValidated(builder)` / `commitValidatedBatch(builder)`：在最新 transcript 的同一文件临界区执行单胜者状态转换
- `emitDelta(delta)`：只向订阅者与 Bus 发布无 seq 的流式增量
- `replay(subscriber, fromSeq)`：从 JSONL 重放 `seq >= fromSeq` 的客户端可见 committed event
- `subscribe(subscriber, options)` / `release()`：管理实时订阅与有界实例缓存

### JSONLStore
- `append()` / `appendBatch()`：修复 crash tail 后，以文件尾 seq 为基准追加并 fsync
- `appendValidated*()`：读取、校验和追加共享同一个 per-file 进程内队列
- `createExclusive()`：以 `wx` 创建完整 transcript，供新会话与 fork 防碰撞
- `readAll()` / `readFromSeq()`：使用统一解析器读取完整历史或断点区间
- `deleteValidated()`：在删除前对最新 committed 状态执行谓词

### Read Models
- `applyCommittedEvent()` / `applyDelta()`：将 durable truth 与临时 overlay 折叠为 TUI 消息
- `materializeSessionEvents()`：在所有读取投影前应用 append-only rewind marker
- `syncSession()` / `syncAll()`：以 mtime/size 门控重物化 SQLite session、part 和 FTS 行
- `searchProjectionText()`：仅产生 FTS 候选，最终 substring 语义由搜索服务裁决

## Usage Examples

### PersistentStore 原子提交一条消息
```typescript
await this.log(sessionId).commitBatch([
  messageEntry,
  ...reasoningEntries,
  ...partEntries,
]);
```

### TUI 折叠 committed event
```typescript
applyCommittedEvent(conversationProjection, event);
set((state) => ({
  session: { ...state.session, messages: [...conversationProjection.messages] },
}));
```

### 从 cursor 订阅重放
```typescript
const log = SessionEventLog.for(sessionId, projectPath);
const replayed: number[] = [];
log.subscribe(
  {
    onCommitted: (event) => {
      replayed.push(event.seq ?? 0);
    },
  },
  { fromSeq: 2 }
);
```

## Gotchas
- JSONL 只容忍最后一条“未换行且无法解析”的 crash tail；任何已换行坏记录或中间损坏都会 fail closed，不能沿用 `readStream()` 的逐行跳过语义恢复权威历史 (`packages/cli/src/context/storage/JSONLStore.ts`, `git:e2aad46f`)
- 一个合法 JSON 对象若只缺末尾换行会被保留并在下次 append 前补换行；无法解析的尾片段才截回上一个提交边界 (`packages/cli/src/context/storage/JSONLStore.ts`)
- legacy event 缺少 seq 时按解析顺序从 1 回填；新 append 读取尾部 seq，只有 legacy 尾部或超大末记录才全量解析，因此修改尾部扫描不能假设所有旧行已有显式 seq (`packages/cli/src/context/storage/JSONLStore.ts`, `git:12a13749`)
- `JSONLStore.appendQueues` 只序列化同一进程内的同路径操作，跨进程独占依赖上层 `SessionLease`；绕过 lease 的新写入口会重新引入多写者风险 (`packages/cli/src/context/storage/JSONLStore.ts`, `packages/cli/src/agent/runtime/SessionLease.ts`)
- ephemeral delta 从不落盘、没有 seq、不会 replay，也不得推进 EventSource cursor；turn 结束必须有完整 `part_updated` 才能让重连客户端得到最终文本 (`packages/cli/src/context/events/EphemeralDelta.ts`, `packages/cli/src/context/events/SessionEventLog.ts`)
- token-budget handoff 占用 durable seq，但被 live、Bus 和 replay 主动过滤，因此客户端看到 seq 间隙是合法行为，不能把间隙误判为丢事件 (`packages/cli/src/context/events/SessionEventLog.ts`, `git:16885631`)
- `SessionEventLog.subscribe({fromSeq})` 先挂 live subscriber 再异步 replay，本身不提供 replay/live 原子切换；Web 必须继续使用先订阅、缓冲、串行 replay、去重和拒绝 seq 回退的 OrderedSseEgress 协议 (`packages/cli/src/context/events/SessionEventLog.ts`, `packages/cli/src/server/routes/session.ts`)
- committed subscriber 返回的 Promise 不阻塞 `commit()` 完成；需要传输背压和 FIFO 的 surface 必须在自己的 egress 队列中串行化，不能依赖日志回调自然排队 (`packages/cli/src/context/events/SessionEventLog.ts`, `docs/reference/surface-egress.md`)
- SQLite 不订阅 SessionEventLog，因为 fork、metadata 和维护路径可直接写 JSONL；若改成纯 push 同步，会漏掉这些写入以及 rewind 文件重写 (`packages/cli/src/context/storage/sqlite/projection.ts`)
- SQLite 打开、驱动加载、迁移或同步任一失败都应回退 JSONL；把索引错误升级为会话不可用会违反“派生缓存可删除”的契约 (`packages/cli/src/context/storage/sqlite/driver.ts`, `packages/cli/src/services/SessionService.ts`)

## Architecture
- committed 写入在 JSONLStore 的 per-file 队列中分配 seq 和 fsync，SessionEventLog 只在成功后更新 `lastSeq` 并向本地订阅者及 Bus 扇出 (`packages/cli/src/context/events/SessionEventLog.ts`, `packages/cli/src/context/storage/JSONLStore.ts`)
- `PersistentStore` 是主要领域消费者，它把 message、tool、turn、interaction、review 和 compaction 转成事件，并用 validated batch 把 acknowledgement 与终态绑定为一个提交边界 (`packages/cli/src/context/storage/PersistentStore.ts`)
- conversation reducer 把 ephemeral content delta 存为按 `partId` 索引的 overlay；对应 committed text part 到达时删除 overlay 并以完整 payload 覆盖 (`packages/cli/src/context/events/reducers/conversationReducer.ts`)
- SQLite 对发生变化的 transcript 总是先 `materializeSessionEvents()` 再整条重建 parts，因而自然处理 rewind 的逻辑截断和文件重写，不需要增量撤销算法 (`packages/cli/src/context/storage/sqlite/projection.ts`, `packages/cli/src/services/sessionRewind.ts`)
- schema 版本不做逐版数据迁移，版本不符直接 drop/rebuild；完整 `metadata_json` 由 SessionService 的同一聚合器生成以维持 JSONL 路径逐字段一致 (`packages/cli/src/context/storage/sqlite/schema.ts`, `packages/cli/src/services/SessionService.ts`)

## Decisions
- 统一事件溯源改造明确采用“两层事件”：有 seq 的 committed event 是恢复真相，无 seq 的 delta 只优化流式渲染，从根源上避免三套 surface 状态各自演进 (`packages/cli/src/context/events/SessionEventLog.ts`, `git:c776d496`)
- append 的 seq 基准从全量解析改成 64 KiB 尾扫描，避免长会话累计写入退化为 O(N²)，同时保留一次性 legacy fallback (`packages/cli/src/context/storage/JSONLStore.ts`, `git:12a13749`)
- SQLite 选择 Bun 内置驱动与 Node `better-sqlite3` 的薄适配，并统一启用 WAL、busy timeout 与同步事务，以支持开发/发布双运行时而不改变上层查询 (`packages/cli/src/context/storage/sqlite/driver.ts`)

## Performance Characteristics
- `syncAll()` 先以最多 128 个并发 stat 找出 stale transcript，再以最多 32 个并发重物化；未变化文件通过 mtime/size 近零成本跳过 (`packages/cli/src/context/storage/sqlite/projection.ts`)
- SessionEventLog 缓存最多保留 256 个实例，按最近访问顺序淘汰无订阅者实例；有订阅者的日志会被固定，全部固定时允许暂时超过上限 (`packages/cli/src/context/events/SessionEventLog.ts`, `git:6b82f891`)
- FTS 只索引 user/assistant 的 text part，并先取 `maxResults * 4` 候选再执行原 substring/snippet 逻辑，性能优化不能改变搜索大小写和片段语义 (`packages/cli/src/context/storage/sqlite/projection.ts`, `packages/cli/src/services/TranscriptSearch.ts`)

## Consumer Analysis
- `PersistentStore` 是最高频写入方：普通写用 commit/batch，turn、interaction、handoff 和恢复使用 validated 变体保证单胜者 (`packages/cli/src/context/storage/PersistentStore.ts`)
- `SessionService` 直接读取稳定 JSONL 快照完成目录聚合、fork、rewind、archive、export，并把同一 metadata deriver 注入 SQLite (`packages/cli/src/services/SessionService.ts`)
- Session HTTP 路由通过 Bus 接 live event、通过 SessionEventLog 接 cursor replay，再交给有界 OrderedSseEgress 完成 replay/live 切换 (`packages/cli/src/server/routes/session.ts`)
- TUI Zustand slice 直接复用 conversation reducer；切换或清空会话时还必须同步重置模块级 projection，避免前一 Session 消息泄漏 (`packages/cli/src/store/slices/sessionSlice.ts`)
- Web store 消费服务端投影协议并对高频 content/thinking/subagent delta 分通道缓冲，终态前先 drain；它不应自行成为 durable event writer (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`)
