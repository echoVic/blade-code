---
name: knowledge-session-state-and-context-session-catalog-fork-rewind-and-export
description: >
  覆盖 durable Session 的发现分页、归档恢复、稳定加载、分叉、user-turn rewind、历史搜索和安全 Markdown 导出。
  适用于修改 SessionService、catalog cursor、lineage、archive、fork、rewind、TranscriptSearch 或 export 行为。
  不含实时 turn/mailbox 恢复（见 ../active-turn-interactions-and-recovery/）和底层事件写入协议（见 ../durable-transcript-and-event-projection/）。
  关键词：SessionService, sessionCatalog, sessionRewind, forkSession, archiveSession, rewindSession, TranscriptSearch, Markdown export。
---

## Module Structure

该节点负责围绕持久 transcript 构建用户可操作的会话生命周期。所有读取先验证 Session 与 workspace 身份，再从有效事件投影目录、分支、回退结果、搜索命中或导出内容。

### Directory Layout
- `packages/cli/src/services/SessionService.ts`：会话元数据聚合与生命周期总入口
- `packages/cli/src/services/sessionCatalog.ts`：查询规范化、稳定排序和 cursor 编解码
- `packages/cli/src/services/sessionRewind.ts`：append-only rewind materialization 与 checkpoint 规划
- `packages/cli/src/services/TranscriptSearch.ts`：SQLite FTS 快路径和 JSONL 兼容扫描
- `packages/cli/src/services/SessionMarkdownExporter.ts`：可移植 Markdown 安全投影
- `packages/cli/src/services/SessionExportWriter.ts`：本地 no-clobber 文件落盘
- `packages/cli/src/slash-commands/`：resume、fork、archive、rewind、search 与 export 交互入口

### Key Entry Points
- `SessionService.listSessionPage()` / `listSessions()` in `packages/cli/src/services/SessionService.ts`：分页目录与任务过滤
- `SessionService.forkSession()` in `packages/cli/src/services/SessionService.ts`：从稳定有效历史创建独立 child
- `SessionService.rewindSession()` in `packages/cli/src/services/SessionService.ts`：原子提交回退 marker 并可选恢复 snapshot
- `SessionService.archiveSession()` / `unarchiveSession()` in `packages/cli/src/services/SessionService.ts`：可恢复归档生命周期
- `SessionService.exportSessionMarkdown()` in `packages/cli/src/services/SessionService.ts`：从 exact-workspace 稳定快照导出

## Gotchas
- Catalog cursor 绑定 `cwd`、`includeSubagents` 和 `archived` 查询域；把 active cursor 用于 archived 列表或改变 workspace/filter 会明确拒绝，而不是从近似位置继续 (`packages/cli/src/services/sessionCatalog.ts`)
- 排序边界是 `lastMessageTime DESC -> projectPath ASC -> sessionId ASC`，cursor 还使用 UTF-16 code-unit sort key 对齐 SQLite；改一侧排序却不改另一侧会造成跨页重复或遗漏 (`packages/cli/src/services/sessionCatalog.ts`, `packages/cli/src/services/SessionService.ts`)
- 无 workspace 的 ID 查询只在全局唯一时安全；`/resume`、`/fork` 和 archive 命令对同名跨工作区 Session 必须拒绝并要求用户选择 (`packages/cli/src/slash-commands/resume.ts`, `packages/cli/src/slash-commands/fork.ts`, `packages/cli/src/slash-commands/archive.ts`)
- scoped load/delete/fork 不信任转义目录名，必须校验 `session_created.data.sessionId` 和 committed `cwd`；目录碰撞不能让另一个 workspace 的 transcript 被读取或删除 (`packages/cli/src/services/SessionService.ts`, `git:f764f682`)
- fork 必须留在源 workspace，并从最多三次 stat/read/stat 一致的稳定快照创建；源在三次读取中持续变化时不产生 child (`packages/cli/src/services/SessionService.ts`, `git:375287f5`)
- fork 复制 materialized 有效历史和 compaction checkpoint，但剥离 token handoff、inbox acknowledgement、pending interaction、review lifecycle 与 task 运行态；这些是父 Session 的恢复权限，不能继承到 child (`packages/cli/src/services/SessionService.ts`, `git:1cacc9eb`)
- fork 的 prompt artifact 必须按 transcript 实际引用复制且重新校验；artifact 复制失败会删除已创建 child transcript 和 child artifact，不能留下只有预览而缺少完整请求的分支 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`)
- rewind 不截断 JSONL；conversation/both 模式追加 marker 后由 projector 移除目标 user turn 及后续 conversation 生命周期，code-only 模式则保留 conversation (`packages/cli/src/services/sessionRewind.ts`, `packages/cli/src/services/SessionService.ts`)
- code/both rewind 在 append marker 的 validated 临界区内先检查 snapshot 连续性和写后 hash；任一文件被外部修改时整组拒绝且 transcript 不新增 marker (`packages/cli/src/services/SessionService.ts`, `packages/cli/tests/unit/services/session-service-rewind.test.ts`)
- 归档父 Session 只给根追加 `archivedAt`，后代状态由 lineage 投影继承；恢复父节点不会解除后代自己直接设置的归档 (`packages/cli/src/services/SessionService.ts`, `docs/reference/session-archive.md`)
- 归档会先按稳定 ID 顺序获取根及全部 fork/subagent 后代的 lease，任一 queued/running 或被占用成员使整次操作零写入失败 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/agent/runtime/SessionLease.ts`)
- TranscriptSearch 的 SQLite 路径只做 FTS 候选缩减，最终仍执行原 substring/snippet 判断；自定义 `storagePath`、索引不可用或异常时走 JSONL 扫描 (`packages/cli/src/services/TranscriptSearch.ts`)
- SQLite 搜索结果的 `lineNumber` 为 0，而 JSONL 路径保留物理事件行号；调用方不能把该字段作为所有搜索路径都稳定的定位主键 (`packages/cli/src/services/TranscriptSearch.ts`)
- Markdown 导出读取 stable JSONL 并应用 rewind，不从当前 Runtime、Web store 或 SQLite 拼接；否则 archived Session、冷导出和并发 append 会产生不同结果 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/services/SessionMarkdownExporter.ts`)
- 本地导出使用 exclusive create 和 0600 权限，目标已存在时明确失败；ACP 只允许内联 Markdown 且上限 1 MiB，不能让 remote client 指定宿主路径 (`packages/cli/src/services/SessionExportWriter.ts`, `packages/cli/src/slash-commands/export.ts`)
- exact-path 删除损坏 JSONL 仍保留 legacy 清理行为，当前无法从坏记录证明 committed cwd，且存储键注入性与跨进程锁仍是 `storage-v2` 债务 (`packages/cli/src/services/SessionService.ts`)

## Architecture
- `projectMetadataFromEntries()` 先折叠 `session_created/session_updated` durable metadata，再用 materialized history 计算消息数、错误、pending interaction 和 review 派生态；SQLite 复用同一 deriver 保持 parity (`packages/cli/src/services/SessionService.ts`)
- 分页优先使用 SQLite recursive CTE 计算继承归档状态，失败时回退全量 JSONL 扫描并复用同一 comparator/cursor 逻辑 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/context/storage/sqlite/projection.ts`)
- rewind projector 是 catalog、resume、fork、search、export 和 context load 的共享依赖；新增 conversation event 时必须判断它是否属于 rewind 后缀，否则各读面会分叉 (`packages/cli/src/services/sessionRewind.ts`)
- `loadSession()` 返回完整 UI 历史，`loadSessionModelContext()` 额外应用最新 compaction replacement；恢复界面和恢复 Provider 请求必须调用各自入口 (`packages/cli/src/services/SessionService.ts`)
- 归档是 catalog projection，不是物理移动或删除；hard delete 才同步清除 transcript、inbox、goal、prompt artifact、browser artifact 和 SQLite 行 (`packages/cli/src/services/SessionService.ts`)

## Decisions
- Session catalog 从宽松目录扫描演进为 scope-bound cursor、严格 ID/workspace 验证和跨目录去重，优先防止错误恢复而不是猜测用户想要哪个同名会话 (`packages/cli/src/services/sessionCatalog.ts`, `git:be64af77`, `git:aaa50c79`)
- fork 采用完整 transcript exclusive create 而非共享父日志或 copy-on-write，使 child 可独立追加，同时通过 `rootId/parentId/relationType` 保留 lineage (`packages/cli/src/services/SessionService.ts`, `git:a141169b`)
- rewind 采用审计 marker 和纯 materializer，而不是破坏性删行，使后续 fork、搜索、导出和 SQLite rebuild 都能重现当时选择 (`packages/cli/src/services/sessionRewind.ts`, `git:6bd75ab1`)
- 导出正文 hash 刻意不覆盖可变化 metadata header；相同有效历史和 visibility 选项可得到稳定正文摘要 (`packages/cli/src/services/SessionMarkdownExporter.ts`)

## Security Considerations
- 导出器对普通文本清理 ANSI、控制/隐藏 Unicode、私钥、Bearer/key 模式；tool activity 还递归清理敏感键、data URL、host path 和 URL 凭证 (`packages/cli/src/services/SessionMarkdownExporter.ts`)
- 单项 activity 最多 64 KiB、完整导出最多 16 MiB；超出完整上限时整体失败而不是生成看似完整的静默截断文件 (`packages/cli/src/services/SessionMarkdownExporter.ts`)
- rewind 文件路径由 SnapshotManager 的 workspace/session 分区和 PathSecurity 边界约束，同名 Session 的不同 workspace 不得共享 snapshot (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/slash-commands/rewind.ts`)

## Compatibility
- Cursor 接受带时区的非规范 ISO 时间并在解码后规范 workspace，但要求 canonical unpadded base64url 重编码一致，以兼容旧 cursor 又拒绝歧义编码 (`packages/cli/src/services/sessionCatalog.ts`, `git:2cd3c93d`)
- TranscriptSearch 仍识别没有 `session_created` 的 legacy `message` JSONL；当前事件格式则先 materialize rewind，再只聚合 user/assistant text part (`packages/cli/src/services/TranscriptSearch.ts`)
- 缺少 task metadata 的 legacy transcript 默认投影为 completed，避免历史普通会话被误当失败任务 (`packages/cli/src/services/SessionService.ts`)
