# SQLite 读侧投影（CQRS）接入方案

## Context

Blade 已完成 Event Sourcing 改造：append-only JSONL 是唯一真相源，CLI/Web/ACP 都是它的投影。但**读侧仍是全量文件扫描**，三个痛点确定要解决：

1. **会话列表/元数据聚合**：`SessionService.scanStoredSessions`（[SessionService.ts:1213](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/SessionService.ts#L1213)）readdir 每个项目目录、**全量 read+parse 每个 `.jsonl`** 才能拿到元数据，O(所有会话)。
2. **跨会话内容检索**：`TranscriptSearch.searchTranscripts`（[TranscriptSearch.ts:31](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/TranscriptSearch.ts#L31)）逐文件全扫，无索引。
3. **单会话 replay 加速**：`loadSession`/`convertJSONLToMessages` 每次全量 parse + `materializeSessionEvents`。

**架构原则（不可动摇）**：JSONL 仍是唯一真相源；SQLite 是**派生、可删除、可随时从 JSONL 重建**的读模型缓存。这就是 CQRS：写 → JSONL，读 → SQLite。DB 不可用时所有读 API **fail-open 回退**到现有 JSONL 扫描，SQLite 保持可选、非致命。

### 关键约束：投影必须是拉取式，不能依赖 log 订阅

并非所有写都过 `SessionEventLog`。以下路径直接写 JSONL、log 订阅感知不到（[SessionService.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/SessionService.ts)）：`rewindSession`(L452)、`forkSession`(L682)、`createSessionMetadata`(L907)、`updateSessionMetadata`(L946)、`reconcileInterruptedTask`(L1336)；删除（`deleteSession`）不发任何事件。**因此投影必须是拉取式、mtime 门控、自愈的 JSONL 同步**，多进程安全（CLI + web server + subagent 可能同时访问）。

## 目标架构

一个**全局** DB `<root>/index.db`（`getBladeStorageRoot()`，[pathUtils.ts:121](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/context/storage/pathUtils.ts#L121)），跨项目统一列表 + 搜索。`seq`（`SessionEventBase.seq`，单调、旧文件按行号回填）是增量游标。

## 1. 驱动抽象（双运行时）

新增 `packages/cli/src/context/storage/sqlite/driver.ts`。复刻现有 pty 双运行时模式（[terminal.ts:33-82](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/server/routes/terminal.ts#L33-L82) 的 `isBunRuntime()`）：

- Bun → 内置 `bun:sqlite`（`new Database(path)`，`db.query()`）
- Node → `better-sqlite3`（`db.prepare()`）——CI 用 node20，`node:sqlite` 出局
- 一层 adapter 抹平方法名，暴露统一同步 API：`exec / prepare(.run/.get/.all) / transaction / pragma / close`
- `openDb(path): Promise<SqliteDb | null>`，任何失败（模块缺失/加载失败）返回 `null` → 调用方回退
- 打开即设：`PRAGMA journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL; foreign_keys=ON`

**依赖改动**：`packages/cli/package.json` 的 `optionalDependencies` 加 `better-sqlite3`（`bun:sqlite` 内置无需声明）；根 `package.json` 的 `trustedDependencies` 加 `better-sqlite3`（原生编译，与 node-pty 一致）。`scripts/build.ts` 已自动 externalize `optionalDependencies`，无需改。

## 2. Schema 与迁移

新增 `packages/cli/src/context/storage/sqlite/schema.ts`：DDL 常量 + `PRAGMA user_version` 迁移（`CURRENT_VERSION=1`，版本落后按序执行 DDL；无迁移路径则 drop 重建——缓存可弃）。

- `projection_state(project_path, session_id, last_seq, file_size, mtime_ms, PK(project_path,session_id))` — 每文件同步游标
- `sessions(...)` — 列对应 `SessionMetadata`（[SessionService.ts:142](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/SessionService.ts#L142)）核心字段 + 聚合列 `message_count/first_message_time/last_message_time/has_errors`；稀疏 `task*` 字段（isolation/worktree/diffStat/queue*/concurrency）统一存 `task_extra TEXT`(JSON) 列，避免 20+ 列膨胀；`idx_sessions_last ON sessions(last_message_time DESC)`
- `parts(project_path, session_id, message_id, part_id, part_type, role, seq, timestamp, text, PK(project_path,session_id,part_id))` — 回放 + 搜索源
- `parts_fts` FTS5 虚表（`text` + UNINDEXED 元数据列，`tokenize='unicode61'`）— 跨会话搜索
- （可选，痛点3）`session_snapshot(project_path, session_id, last_seq, payload BLOB)` — 物化 `Message[]` 快照

**rewind 处理**：增量同步读到含 `session_rewound` 的事件，或发现 `file_size < 记录值`（文件被重写），**放弃增量、对该单会话全量重物化**：`DELETE ... WHERE session_id=?` 后用 `materializeSessionEvents(parseSessionJSONL(全文))` 重建，`last_seq` 重置。只影响一个会话，天然处理 seq 截断。

## 3. 同步算法（拉取、自愈、mtime 门控）

新增 `packages/cli/src/context/storage/sqlite/projection.ts`：

- `syncSession(db, sessionId, projectPath)`：`fs.stat` JSONL → 对比 `projection_state` 的 `file_size/mtime_ms/last_seq`，全等则跳过（廉价热路径）；否则 `JSONLStore.readFromSeq(last_seq+1)` 增量读；含 `session_rewound` 或文件缩小 → 全量重物化；否则复用 `materializeSessionEvents` 规范化后 upsert `sessions/parts/parts_fts`，更新 `projection_state`。整会话包一个 `transaction`。
- 元数据聚合复用 `scanStoredSessions` 内 `projectMetadataFromEntries` 的等价逻辑（抽出复用），**不在 SQL 里重实现聚合**。
- `syncAll(db)`：`listProjectDirectories()`（[pathUtils.ts:129](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/context/storage/pathUtils.ts#L129)）+ 每项目 `*.jsonl` → 逐个 `syncSession`；再 GC——`projection_state` 中 JSONL 已不存在的行连带删除。
- **触发**：懒同步。列表/搜索入口调 `syncAll()`（内部每文件 mtime 门控，未变近乎零成本），单会话加载调 `syncSession()`。
- **多进程**：upsert 全用 `INSERT ... ON CONFLICT DO UPDATE` 幂等；WAL 允许并发读 + 单写；`busy_timeout` 吸收锁竞争。

## 4. 读 API 接线（fail-open 回退）

- [SessionService.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/SessionService.ts)：`listSessionPage`/`listSessions`/`findSessionMetadata`（无 projectPath 分支）先 `openDb()`+`syncAll()`，成功走 `SELECT ... FROM sessions`；DB 为 `null`/抛错回退 `scanStoredSessions`。**排序**：SQL 只做粗排（`last_message_time DESC`），取回后仍走 `compareSessionCatalogItems`（[sessionCatalog.ts:116](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/sessionCatalog.ts#L116)）保证与旧路径逐条一致。
- [TranscriptSearch.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/TranscriptSearch.ts) `searchTranscripts`：先 `openDb()`+`syncAll()`，走 `parts_fts MATCH ?`（`role IN ('user','assistant')`，按 `timestamp` 倒序 `LIMIT`），映射为 `TranscriptMatch`；DB 不可用回退现有全扫。
- （可选，痛点3）`loadSession`/`convertJSONLToMessages`：以 `last_seq` 为键查 `session_snapshot`，命中且 `last_seq` 未变则反序列化，否则照旧解析并回填。JSONL 仍为准。

## 5. 重建 / 删除钩子

- [doctor.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/commands/doctor.ts)：加 `--rebuild-index` — 删 `index.db`(+`-wal`/`-shm`) 后 `openDb()`+`syncAll()` 全量重建，打印统计。
- 删除钩子：`SessionService.deleteSession` 与 `PersistentStore.deleteSession` 删 JSONL 成功后 best-effort `DELETE FROM sessions/parts/parts_fts/projection_state`（失败仅告警，下次 `syncAll` GC 兜底）。

## 迁移排序（每步独立可测）

1. driver + package.json/trustedDependencies
2. schema/migrate
3. projection sync（含 rewind 重物化、GC）
4. 接线 list + search 读 API + 回退
5. （可选）单会话快照缓存
6. doctor 重建 + 删除钩子

## 验证

- **单元**（`tests/unit/context/sqlite/projection.test.ts`）：`BLADE_STORAGE_ROOT` 指向 tmp（vitest 在 Node 下用 `better-sqlite3`）；构造 JSONL fixture 断言行数、`last_seq` 游标推进、二次 `syncSession` 被 mtime 门控跳过、`session_rewound` 触发单会话重物化、GC 删除孤儿行。
- **平价测试**：同一 fixture 下 `listSessions`/`searchTranscripts` 的 SQLite 结果与旧 JSONL 扫描结果逐条 diff。
- **集成（真实 API）**：跑一次真实会话 → 断言 `sessions`/`parts` 行、FTS 命中、`last_seq` 递增。
- **1900+ 测试风险**：fail-open 回退保证 DB 缺失时保持旧行为，风险低；重点检查依赖 `scanStoredSessions` 调用次数/固定排序的用例（排序已用 `compareSessionCatalogItems` 兜齐）。确认 CI(node20) `bun install` 触发 `better-sqlite3` 原生编译（trustedDependencies）。
- **GUI 回归**：`bun run ready` 全绿 + Web/CLI 冒烟（列表加载、`/search`）。

## 新增/改动文件

- 新增：`packages/cli/src/context/storage/sqlite/{driver,schema,projection}.ts`
- 改动：`packages/cli/package.json`、根 `package.json`（trustedDependencies）、[SessionService.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/SessionService.ts)、[TranscriptSearch.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/services/TranscriptSearch.ts)、[doctor.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/commands/doctor.ts)、[PersistentStore.ts](file:///Users/bytedance/Documents/GitHub/Blade/packages/cli/src/context/storage/PersistentStore.ts)（删除钩子）

## 关键 trade-off

- 引入一个原生可选依赖（`better-sqlite3`）——用 optionalDependencies + fail-open 把风险降到"装不上就退回 JSONL 扫描"，不影响核心功能。
- 全局单 DB 简化跨项目查询，但需 WAL + busy_timeout 处理多进程；投影是纯派生，损坏时 `doctor --rebuild-index` 一键重建。
