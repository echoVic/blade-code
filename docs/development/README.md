# 🔧 Blade 开发者文档

这里是 Blade Code 的内部技术文档，包含架构设计、实现细节和开发指南。

## 🏗️ 架构文档

### 核心架构
- **[架构概览](architecture/index.md)** - 系统整体架构
- **[Agent 架构](architecture/agent.md)** - Agent 核心设计
- **[工具系统](architecture/tool-system.md)** ⭐ - 工具系统完整架构
- **[执行管道](architecture/execution-pipeline.md)** ⭐ - 6 阶段执行管道

### 子系统
- **[配置系统](architecture/context-implementation.md)** - 配置管理实现
- **[上下文集成](architecture/context-integration.md)** - 上下文管理
- **[确认流程](architecture/confirmation-flow.md)** - 用户确认机制

## 💻 实现细节

- **[Store 与 Config 架构统一](implementation/store-config-unification.md)** 🆕 - 消除双轨数据源的重构总结
- **[错误处理](implementation/error-handling.md)** - 错误处理机制
- **[日志系统](implementation/logging-system.md)** - 日志系统实现
- **[Markdown 渲染器](implementation/markdown-renderer.md)** ⭐ - 完整 Markdown 渲染系统
- **[流式工具执行显示](implementation/streaming-tool-execution-display.md)** ⭐ - Claude Code 风格的工具执行流
- **[循环检测系统](implementation/loop-detection-system.md)** - 三层循环检测机制
- **[Subagents 系统](implementation/subagents-system.md)** - 子 Agent 架构
- **[MCP 支持](implementation/mcp-support.md)** - Model Context Protocol 实现

## 📋 技术方案

开发过程中的技术方案和重构提案：

- [Agent 配置重构 v2](planning/agent-config-refactor-proposal-v2.md)
- [Agentic Loop 实现](planning/agentic-loop-implementation-plan.md)
- [配置系统规划](planning/config-system-plan.md)
- [执行管道集成](planning/execution-pipeline-integration-plan.md)
- [UI 确认集成](planning/ui-confirmation-integration-summary.md)

## 🧪 测试文档

- **[测试策略](testing/index.md)** - 测试框架和策略
- **[测试覆盖率](testing/coverage.md)** - 覆盖率报告

## 🔗 快速链接

- [用户文档](../public/README.md) - 面向最终用户
- [贡献指南](../contributing/README.md) - 开源贡献流程
- [项目主页](https://github.com/echoVic/blade-code)

## 📝 文档规范

### 架构文档
- 包含设计决策和理由
- 提供系统图和流程图
- 说明关键接口和数据结构

### 实现文档
- 详细的代码示例
- 边界条件和错误处理
- 性能考虑

### 技术方案
- 明确问题和目标
- 对比多个方案
- 实施计划和时间估算

---

最后更新: 2025-10-26
