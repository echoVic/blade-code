# 🧠 Auto Memory

Auto Memory 让 Agent 在工作中自动记录项目知识，跨会话持久化。新会话启动时自动加载历史记忆，Agent 不再"失忆"。

## 工作原理

1. **启动时加载** — 会话开始时，MEMORY.md 前 200 行自动注入 system prompt
2. **工作中记录** — Agent 发现有价值的知识时，通过 MemoryWrite 工具保存
3. **按需检索** — Agent 需要特定主题的详细信息时，通过 MemoryRead 工具读取

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
- **路径遍历防护** — 主题名不允许包含 `..` 或 `/`，防止写入任意路径
- **索引行数限制** — MEMORY.md 加载上限 200 行，避免 system prompt 膨胀

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
content: "## Build\npnpm build"
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
