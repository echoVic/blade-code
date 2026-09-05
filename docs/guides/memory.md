# 🧠 Auto Memory

Auto Memory 让 Agent 在工作中自动记录项目知识，跨会话持久化。新会话启动时自动加载历史记忆，Agent 不再"失忆"。

## 工作原理

1. **启动时加载** — 会话开始时，MEMORY.md 前 200 行自动注入 system prompt
2. **工作中记录** — Agent 发现有价值的知识时，通过 MemoryWrite 工具保存
3. **压缩时巩固** — full compaction 会从被移出上下文的消息中提取明确标记的可复用知识
4. **按需检索** — Agent 需要特定主题的详细信息时，通过 MemoryRead 工具读取

## Full compaction 记忆巩固

预测式阈值压缩、上下文超限恢复、轮次上限续跑和手动 `/compact` 都遵循同一流程：

1. 先生成有界的 compaction replacement 和项目记忆计划；
2. 先原子提交 replacement checkpoint；
3. checkpoint 成功后，才以 best-effort 方式写入项目记忆；
4. 最后替换当前模型上下文并继续任务。

如果 checkpoint 失败，不会写入记忆或替换上下文。如果记忆写入失败，已提交的
compaction 仍然有效，任务可以继续。该过程复用 compaction 已经读取的历史，**不会额外
发起一次 Provider 请求**。仅执行 snip/micro compaction 时不会生成项目记忆。

自动巩固只读取被 full compaction 丢弃的可见文本：

- 用户明确写出的 `记住:` / `remember:` 进入 `preferences.md`；
- `约定:` / `规范:` / `convention:` 进入 `conventions.md`；
- `教训:` / `踩坑:` / `lesson:` 进入 `lessons.md`；
- 助手明确写出的 `修复:` / `解决:` / `fixed:` / `resolved:` 进入
  `debugging.md`。

工具输出、工具参数、reasoning、metadata 和图片 URL 不参与提取。单次计划最多 20 条，
单条最多 500 个 Unicode code point，总计最多 8,000 个 code point。写入时会对规范化后的
完整条目精确去重，并通过进程内锁、文件锁和原子替换避免并发丢失；topic 与索引文件使用
`0600` 权限。自动管理的主题链接只会更新 `MEMORY.md` 的受管区块，不覆盖用户维护的其它内容。

## 存储结构

记忆文件存储在项目专属目录下：

```
~/.blade/projects/{escaped-path}/memory/
├── MEMORY.md          # 入口索引（启动时加载前 200 行）
├── patterns.md        # 项目模式（构建命令、代码风格）
├── debugging.md       # 调试洞察
├── architecture.md    # 架构笔记
└── ...                # Agent 按需创建的主题文件
```

每个项目有独立的记忆空间，互不干扰。

## Agent 会记住什么

- 项目的构建、测试、lint 命令
- 代码模式和约定
- 调试过程中发现的解决方案
- 架构决策和关键文件关系
- 用户偏好和工作流习惯

## 安全机制

- **敏感数据过滤** — 自动拒绝包含 password、token、secret、api_key、private_key 的内容
- **封闭凭据分类** — Bearer token、`sk-*`、AWS access key ID 和 PEM 私钥头同样被拒绝；
  错误与客户端投影不会返回命中内容或正则细节
- **路径遍历防护** — 主题名不允许包含 `..` 或 `/`，防止写入任意路径
- **索引行数限制** — MEMORY.md 加载上限 200 行，避免 system prompt 膨胀
- **工作区隔离** — 记忆只写入当前本地 workspace；remote ACP workspace 返回
  `disabled`，不会写到宿主机项目目录
- **内容无关投影** — TUI、Web、ACP 与 Headless 只接收 outcome、条目数和 topic 名称，
  不接收记忆正文、路径、存储错误或凭据

## /memory 命令

在会话中使用 `/memory` 管理记忆文件：

| 命令 | 说明 |
|------|------|
| `/memory` | 列出所有记忆文件（等同于 `/memory list`） |
| `/memory list` | 列出所有记忆文件及大小 |
| `/memory show` | 显示 MEMORY.md 索引内容 |
| `/memory show <topic>` | 显示指定主题文件内容 |
| `/memory edit` | 用 `$EDITOR` 编辑 MEMORY.md |
| `/memory edit <topic>` | 用 `$EDITOR` 编辑指定主题文件 |
| `/memory clear` | 清空所有记忆文件 |

## 工具

### MemoryRead

读取记忆文件，Agent 在需要时自动调用。

```
topic: "debugging"     → 读取 debugging.md
topic: "MEMORY"        → 读取 MEMORY.md 索引
topic: "_list"         → 列出所有记忆文件
```

### MemoryWrite

保存记忆内容，支持追加和覆盖模式。

```
topic: "patterns"
content: "## Build\nbun run build"
mode: "append"         → 追加到 patterns.md
mode: "overwrite"      → 覆盖 patterns.md
```

## 配置

### 环境变量

```bash
# 禁用 Auto Memory
BLADE_AUTO_MEMORY=0

# 启用（默认）
BLADE_AUTO_MEMORY=1
```

## 最佳实践

- **MEMORY.md 是索引** — 保持简洁，详细内容放到主题文件
- **让 Agent 自己学** — 不需要手动写记忆，Agent 会在工作中自动发现和记录
- **定期检查** — 用 `/memory show` 看看 Agent 记了什么，用 `/memory edit` 修正不准确的内容
- **项目初始化后** — 第一次在新项目中使用时，Agent 会逐步积累知识，几次会话后效果最佳

## 相关资源

- [Slash 命令](slash-commands.md) — 所有内置命令
- [工具列表](../reference/tool-list.md) — MemoryRead / MemoryWrite 参数详情
- [配置系统](../configuration/config-system.md) — 全局和项目级配置
