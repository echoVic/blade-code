/**
 * Spec-Driven Development Tools
 *
 * 提供 Spec 模式的核心工具集：
 * - EnterSpecMode: 进入 Spec 模式
 * - UpdateSpec: 更新 Spec 文件
 * - GetSpecContext: 获取 Spec 上下文
 * - TransitionSpecPhase: 转换工作流阶段
 * - ValidateSpec: 验证 Spec 完整性
 * - ExitSpecMode: 退出 Spec 模式
 * - AddTask: 添加任务
 * - UpdateTaskStatus: 更新任务状态
 */

import { addTaskTool } from './AddTaskTool.js';
import { enterSpecModeTool } from './EnterSpecModeTool.js';
import { exitSpecModeTool } from './ExitSpecModeTool.js';
import { getSpecContextTool } from './GetSpecContextTool.js';
import { transitionSpecPhaseTool } from './TransitionSpecPhaseTool.js';
import { updateSpecTool } from './UpdateSpecTool.js';
import { updateTaskStatusTool } from './UpdateTaskStatusTool.js';
import { validateSpecTool } from './ValidateSpecTool.js';

export const specTools = [
  enterSpecModeTool,
  updateSpecTool,
  getSpecContextTool,
  transitionSpecPhaseTool,
  addTaskTool,
  updateTaskStatusTool,
  validateSpecTool,
  exitSpecModeTool,
];
