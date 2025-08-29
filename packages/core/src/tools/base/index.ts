/**
 * 工具基类模块
 * 提供可确认工具的抽象基类和相关类型定义
 */

export {
  ConfirmableToolBase,
  RiskLevel,
  type CommandExecutionResult,
  type CommandPreCheckResult,
  type ConfirmationOptions,
} from './ConfirmableToolBase.js';

/**
 * 工具基类使用指南:
 *
 * 1. 继承 ConfirmableToolBase 类
 * 2. 实现必需的 buildCommand 方法
 * 3. 根据需要重写可选方法来自定义行为
 * 4. 设置合适的风险级别和确认选项
 *
 * 详细文档请参见 README.md
 */
