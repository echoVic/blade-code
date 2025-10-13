# 📦 归档文档

本目录包含项目历史文档，仅作参考，内容可能已过时。

## 📋 归档分类

### 历史技术方案（参考价值）

- **BUILD_MIGRATION.md** - 构建方案迁移文档（tsup → tsc + esbuild）
  - 注意：当前项目已改用 Bun 构建系统

- **TOOL_SYSTEM_COMPLETED.md** - 工具系统重构完成文档（v1.0）
  - 记录了工具系统从旧架构到新架构的完整迁移

- **TOOL_SYSTEM_RENOVATION_PLAN_archived.md** - 工具系统改进规划
  - 调研了 Claude Code 和 Gemini CLI 的工具体系
  - 设计了 6 阶段执行管道

### 安全审计报告（历史参考）

**security-audits/** 目录包含 5 份历史安全审计报告：

- comprehensive-security-audit-report.md - 全面安全审计报告
- security-audit-report.md - 安全审计报告
- configuration.md - 安全配置和最佳实践
- hardening-guide.md - 安全加固指南
- hardening-summary.md - 安全加固总结

**注意事项：**
- 这些报告的日期不准确（显示为 2025-08-29）
- 报告中提到的代码结构与当前项目不完全一致
- 仅供历史参考，不代表当前安全状态
- 当前安全策略参见：[contributing/security-policy.md](../contributing/security-review.md)

### 性能优化（历史方案）

- **performance-optimization.md** - 性能优化实施指南
  - 包含详细的优化方案（React-Ink、内存管理、LLM 请求等）
  - 注意：文档中提到的许多类和文件不存在于当前实现

## ⚠️ 使用说明

1. **归档原因**：这些文档内容已过时或与当前实现不符
2. **参考价值**：可以作为历史决策和技术演进的参考
3. **不建议使用**：不应将这些文档作为当前项目的指导
4. **最新文档**：请参考 `docs/public/`、`docs/development/` 和 `docs/contributing/` 中的文档

## 🗑️ 已删除的文档

以下文档已从归档中删除，因为没有保留价值：

- ❌ CLEANUP_REPORT.md - 文档清理报告（临时报告）
- ❌ REORGANIZATION_COMPLETED.md - 文档重组完成报告（临时报告）
- ❌ REORGANIZATION_PLAN.md - 文档重组计划（临时报告）
- ❌ TOOL_USAGE_GUIDE.md - 工具使用指南（API 完全变化）
- ❌ git-tools.md - Git 工具文档（工具已不存在）
- ❌ smart-tools.md - 智能工具文档（工具已不存在）
- ❌ usage.md - LLM 使用指南（内容完全过时）
- ❌ qwen-function-call.md - Qwen 函数调用指南（类已不存在）

---

**最后更新**: 2025-10-13
