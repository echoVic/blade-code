# Spec Mode 用户指南

Spec Mode（规格驱动开发模式）是 Blade Code 的高级功能，帮助你在编码前先定义清晰的规格说明，提高 AI 辅助编码的质量和效率。

## 什么是 Spec-Driven Development？

Spec-Driven Development (SDD) 是一种结构化的开发方法论，核心理念是：

1. **先规划后编码** - 在编写代码前，先记录项目目标、架构和需求
2. **单一信息源** - 通过 spec 文件作为项目的权威参考
3. **结构化工作流** - 遵循 Requirements → Design → Tasks → Implementation 的流程

研究表明，使用结构化规格的 LLM 输出质量显著提高：

> "1 iteration with structure was of similar accuracy to 8 iterations with unstructured prompts"

## 快速开始

### 进入 Spec 模式

有两种方式进入 Spec 模式：

**方式一：Shift+Tab 切换**

按 `Shift+Tab` 循环切换模式：

```
DEFAULT → AUTO_EDIT → PLAN → SPEC → DEFAULT
```

状态栏会显示当前模式和进度：

```
📋 spec: tasks 3/5 (shift+tab to cycle)
```

**方式二：/spec 命令**

直接使用 `/spec` 命令创建或加载 Spec。

### 创建新的 Spec

```bash
/spec proposal my-feature "实现用户认证功能"
```

这会在 `.blade/changes/my-feature/` 下创建：
- `proposal.md` - 提案描述（为什么做）
- `.meta.json` - 元数据（状态、进度等）

### 查看 Spec 状态

```bash
/spec status
```

显示当前 Spec 的阶段、任务进度等信息。

### 列出所有 Specs

```bash
/spec list
```

查看所有活跃和归档的 Specs。

## 四阶段工作流

Spec Mode 遵循四个主要阶段：

```
┌─────────────┐    ┌──────────┐    ┌───────┐    ┌──────────────┐
│ REQUIREMENTS│ → │  DESIGN  │ → │ TASKS │ → │IMPLEMENTATION│
│   需求定义   │    │ 架构设计  │    │任务分解│    │    实现中     │
└─────────────┘    └──────────┘    └───────┘    └──────────────┘
```

### 1. Requirements（需求定义）

使用 EARS 格式定义需求：

```bash
/spec plan
```

生成 `requirements.md`，包含：
- **Ubiquitous** - "系统应..."
- **Event-driven** - "当 [触发条件] 时，系统应..."
- **Unwanted** - "如果 [条件]，则系统应..."
- **State-driven** - "当处于 [状态] 时，系统应..."

### 2. Design（架构设计）

可选阶段，创建技术架构：

```bash
/spec plan
```

生成 `design.md`，包含：
- 组件图（Mermaid）
- 数据流图
- API 契约
- 数据库 Schema 变更

### 3. Tasks（任务分解）

将设计拆分为原子任务：

```bash
/spec tasks
```

生成 `tasks.md`，每个任务包含：
- 标题和描述
- 复杂度（low/medium/high）
- 依赖关系
- 影响的文件

### 4. Implementation（实现）

逐个执行任务：

```bash
/spec apply [task-id]
```

或让 AI 自动选择下一个可执行的任务：

```bash
/spec apply
```

### 5. 完成与归档

当所有任务完成后，归档 Spec：

```bash
/spec archive
```

**自动退出**：Spec 完成（进入 `done` 阶段）后，系统会自动退出 Spec 模式，切换回 DEFAULT 模式。这让你可以无缝继续其他工作。

## 命令参考

### 核心命令

| 命令 | 说明 |
|------|------|
| `/spec proposal <name> [desc]` | 创建新的变更提案 |
| `/spec plan` | 生成当前阶段的文档（需求/设计） |
| `/spec tasks` | 分解任务 |
| `/spec apply [task-id]` | 执行任务 |
| `/spec archive` | 归档已完成的 Spec |

### 辅助命令

| 命令 | 说明 |
|------|------|
| `/spec status` | 查看当前 Spec 状态 |
| `/spec list` | 列出所有 Specs |
| `/spec show <name>` | 显示指定 Spec 详情 |
| `/spec validate` | 验证 Spec 完整性 |
| `/spec constitution` | 编辑项目治理原则 |

## 目录结构

Spec Mode 在项目根目录创建以下结构：

```
.blade/
├── specs/              # 权威规格（单一信息源）
│   └── [domain]/
│       └── spec.md
├── changes/            # 活跃的变更提案
│   └── <feature>/
│       ├── proposal.md    # 提案描述
│       ├── spec.md        # 规格文件
│       ├── requirements.md # 需求文档
│       ├── design.md      # 设计文档
│       ├── tasks.md       # 任务分解
│       └── .meta.json     # 元数据
├── archive/            # 已完成的变更
└── steering/           # 全局治理文档
    ├── constitution.md # 项目治理原则
    ├── product.md      # 产品愿景
    ├── tech.md         # 技术栈约束
    └── structure.md    # 代码组织模式
```

## Steering Documents

Steering Documents 是项目级的全局治理文档，为 AI 提供上下文：

### constitution.md

定义项目的核心原则和约束，例如：
- 代码风格要求
- 安全准则
- 性能目标

### product.md

描述产品愿景和目标：
- 目标用户
- 核心功能
- 成功指标

### tech.md

记录技术栈和约束：
- 使用的框架和库
- 兼容性要求
- 部署环境

### structure.md

描述代码组织模式：
- 目录结构
- 命名约定
- 模块划分

## 最佳实践

### 1. 从小开始

对于简单任务，使用 Plan Mode 即可。Spec Mode 更适合：
- 需要多个文件变更的功能
- 涉及架构决策的任务
- 需要团队协作的特性

### 2. 保持 Spec 小而聚焦

每个 Spec 应该解决一个明确的问题。如果 Spec 太大，考虑拆分为多个独立的 Specs。

### 3. 定期验证

使用 `/spec validate` 检查 Spec 的完整性，确保所有必要的文档都已填写。

### 4. 利用 Steering Documents

在开始任何 Spec 之前，先设置好 Steering Documents，让 AI 了解项目的全局上下文。

### 5. 及时归档

完成 Spec 后，使用 `/spec archive` 归档，保持 changes/ 目录整洁。

## 与 Plan Mode 的区别

| 特性 | Plan Mode | Spec Mode |
|------|-----------|-----------|
| 复杂度 | 简单任务 | 复杂功能 |
| 文档 | 单个计划文件 | 多个结构化文档 |
| 阶段 | 单阶段 | 四阶段工作流 |
| 持久化 | 临时 | 永久归档 |
| 适用场景 | Bug 修复、小改动 | 新功能、重构 |
| 模式切换 | Shift+Tab | Shift+Tab |
| 状态栏 | `‖ plan mode on` | `📋 spec: tasks 3/5` |

## 故障排除

### Spec 创建失败

确保 Spec 名称只包含字母、数字和连字符，例如：
- ✅ `user-auth`
- ✅ `feature-123`
- ❌ `user auth`（包含空格）
- ❌ `feature/new`（包含斜杠）

### 阶段转换失败

检查当前阶段是否允许目标转换。例如，不能直接从 `init` 跳到 `implementation`。

### 任务依赖未满足

使用 `/spec status` 查看哪些依赖任务尚未完成，先完成依赖任务。

## 参考资源

- [GitHub Spec Kit](https://github.com/github/spec-kit) - GitHub 官方 SDD 工具包
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) - 轻量级规格工作流
- [Anthropic Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
