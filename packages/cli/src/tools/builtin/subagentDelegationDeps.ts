/**
 * Subagent 委派依赖容器
 *
 * Task 与 Team 工具在把工作委派给子 Agent 时，需要同一组 session 级依赖：
 * 子代理注册表、workspace 资源快照（agent/model/lsp）以及当前的模型偏好选择器。
 *
 * 过去这些依赖以 8 个位置参数（Task）或散开的 options 字段（Team）分别传递，
 * 既容易错位，也让 getBuiltinTools 不得不逐字段转发。这里用一个声明式容器统一承载，
 * 让委派入口以命名依赖注入替代样板透传。
 */

import type { SessionAgentResources } from '../../agent/resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../../agent/resources/WorkspaceModelResources.js';
import type { SubagentRegistry } from '../../agent/subagents/SubagentRegistry.js';
import type {
  CommunicationStyleSelection,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import type { SessionLspResources } from '../../lsp/WorkspaceLspResources.js';

/**
 * 委派给子 Agent 所需的 session 级依赖。
 * 全部可选：缺省时各工具回退到进程级 registry 或继承调用方偏好。
 */
export interface SubagentDelegationDeps {
  /** 子代理定义注册表；缺省时回退到进程级单例。 */
  registry?: SubagentRegistry;
  /** 按 source project 隔离的 Agent 资源快照。 */
  agentResources?: SessionAgentResources;
  /** 按 source project 隔离的模型资源快照。 */
  modelResources?: SessionModelResources;
  /** 按 source project 隔离的 LSP 资源快照。 */
  lspResources?: SessionLspResources;
  /** 读取当前 reasoning effort 选择。 */
  getReasoningEffort?: () => ReasoningEffortSelection;
  /** 读取当前 service tier 选择。 */
  getServiceTier?: () => ServiceTierSelection;
  /** 读取当前响应详尽度选择。 */
  getResponseVerbosity?: () => ResponseVerbositySelection;
  /** 读取当前沟通风格选择。 */
  getCommunicationStyle?: () => CommunicationStyleSelection;
}
