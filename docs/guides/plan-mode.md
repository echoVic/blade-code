# 📋 Plan 模式

Plan 模式是一种只读权限模式，用于调研和规划阶段。AI 只能使用只读工具，无法执行任何修改操作。

## 概述

在 Plan 模式下：

- ✅ **允许**：Read、Glob、Grep、WebFetch、WebSearch、TaskCreate/TaskGet/TaskUpdate/TaskList 等只读工具
- ❌ **拒绝**：Write、Edit、Bash 等修改工具
- 🔵 **特殊**：ExitPlanMode 工具用于提交方案

## 启动方式

### CLI 参数

```bash
blade --permission-mode plan
blade -P  # 简写
```

### 运行时切换

在交互界面按 `Shift+Tab` 循环切换权限模式，直到显示 `Plan`。

## 工作流程

```
┌─────────────────────────────────────────────────────────────┐
│                      Plan 模式工作流                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   1. 进入 Plan 模式                                         │
│      blade --permission-mode plan                           │
│                         ↓                                   │
│   2. 描述需求                                               │
│      "帮我设计一个用户认证系统"                              │
│                         ↓                                   │
│   3. AI 调研和规划                                          │
│      - 使用 Read 分析现有代码                               │
│      - 使用 Grep 搜索相关实现                               │
│      - 使用 WebSearch 查询最佳实践                          │
│                         ↓                                   │
│   4. AI 生成实现方案                                        │
│      - 技术选型                                             │
│      - 架构设计                                             │
│      - 实现步骤                                             │
│                         ↓                                   │
│   5. 用户审核方案                                           │
│      - 确认方案可行性                                       │
│      - 提出修改意见                                         │
│                         ↓                                   │
│   6. 退出 Plan 模式                                         │
│      AI 调用 ExitPlanMode 工具                              │
│      用户确认后切换到 Default 模式开始实现                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 使用示例

### 需求分析

```bash
blade --permission-mode plan

# 对话示例：
用户: 帮我分析这个项目的架构，并提出重构建议

AI: 让我先分析项目结构...
    [使用 Glob 列出文件]
    [使用 Read 读取关键文件]
    [使用 Grep 搜索依赖关系]
    
    基于分析，我建议以下重构方案：
    1. 将 utils 拆分为独立模块
    2. 引入依赖注入模式
    3. 添加单元测试
    
    如果你同意这个方案，我可以退出 Plan 模式开始实现。
```

### 技术选型

```bash
blade --permission-mode plan

用户: 我需要为项目添加状态管理，帮我对比几种方案

AI: 让我分析项目需求并对比方案...
    [使用 Read 分析项目结构]
    [使用 WebSearch 查询最新方案]
    
    基于项目特点，推荐以下方案：
    
    | 方案 | 优点 | 缺点 | 推荐度 |
    |------|------|------|--------|
    | Zustand | 轻量、简单 | 生态较小 | ⭐⭐⭐⭐⭐ |
    | Redux Toolkit | 成熟、生态好 | 样板代码多 | ⭐⭐⭐⭐ |
    | Jotai | 原子化、灵活 | 学习曲线 | ⭐⭐⭐ |
    
    推荐使用 Zustand，因为...
```

## ExitPlanMode 工具

当 AI 完成规划后，会调用 ExitPlanMode 工具提交方案：

```json
{
  "name": "ExitPlanMode",
  "arguments": {
    "title": "用户认证系统实现方案",
    "plan": "## 技术选型\n- JWT + bcrypt\n\n## 实现步骤\n1. 创建 User 模型\n2. 实现注册接口\n3. 实现登录接口\n..."
  }
}
```

ExitPlanMode 由运行时按当前权限模式校验。它只允许在 Plan 模式中退出；在 Default、Auto Edit 或 Yolo 模式中调用会收到 `validation_error`，不会重新弹出确认，也不会中断已批准的实现流程。

用户确认后：

1. 方案保存到 `.blade/plans/` 目录
2. 权限模式切换到 Default
3. AI 可以开始执行实现

## 方案文件

方案保存为 Markdown 文件：

```
.blade/plans/
  └─ 用户认证系统实现方案.md
```

文件内容：

```markdown
# 用户认证系统实现方案

## 技术选型
- JWT + bcrypt

## 实现步骤
1. 创建 User 模型
2. 实现注册接口
3. 实现登录接口
...
```

## 最佳实践

### 1. 明确需求

```
帮我设计一个用户认证系统，需要支持：
- 邮箱注册/登录
- OAuth 第三方登录
- 密码重置
- 会话管理
```

### 2. 提供上下文

```
基于 @package.json 和 @src/config.ts 的现有配置，
帮我规划如何添加数据库支持
```

### 3. 迭代优化

```
这个方案不错，但我希望：
1. 使用 Prisma 而不是 TypeORM
2. 添加 Rate Limiting
请更新方案
```

### 4. 确认后再实现

在 AI 调用 ExitPlanMode 时，仔细审核方案：

- 技术选型是否合理
- 实现步骤是否完整
- 是否考虑了边界情况

## 相关资源

- [权限控制](../configuration/permissions.md) - 权限模式详解
- [Subagents](subagents.md) - Plan 子代理
