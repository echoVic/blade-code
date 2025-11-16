/**
 * Slash 命令消息到 UI Action 的映射器
 * 使用策略模式替代 if-else 判断
 */

import type { SessionMetadata } from '../services/SessionService.js';
import type { AppAction } from '../ui/contexts/AppContext.js';

/**
 * Action Creator 类型约束
 * 使用 AppAction 确保类型安全
 */
export interface ActionCreators {
  showThemeSelector: () => AppAction;
  showModelSelector: () => AppAction;
  showModelAddWizard: () => AppAction;
  showPermissionsManager: () => AppAction;
  showAgentsManager: () => AppAction;
  showAgentCreationWizard: () => AppAction;
  showSessionSelector: (sessions?: SessionMetadata[]) => AppAction;
}

/**
 * UI Action 映射器
 * 将 slash 命令的返回消息映射为对应的 UI Action
 *
 * @template T - Action Creators 类型（默认为 ActionCreators）
 */
export class UIActionMapper<T extends ActionCreators = ActionCreators> {
  private strategies = new Map<string, (data?: unknown) => AppAction>();

  constructor(private actionCreators: T) {
    this.registerStrategies();
  }

  /**
   * 注册所有映射策略
   */
  private registerStrategies(): void {
    this.strategies.set('show_theme_selector', () =>
      this.actionCreators.showThemeSelector()
    );

    this.strategies.set('show_model_selector', () =>
      this.actionCreators.showModelSelector()
    );

    this.strategies.set('show_model_add_wizard', () =>
      this.actionCreators.showModelAddWizard()
    );

    this.strategies.set('show_permissions_manager', () =>
      this.actionCreators.showPermissionsManager()
    );

    this.strategies.set('show_agents_manager', () =>
      this.actionCreators.showAgentsManager()
    );

    this.strategies.set('show_agent_creation_wizard', () =>
      this.actionCreators.showAgentCreationWizard()
    );

    this.strategies.set('show_session_selector', (data?: unknown) => {
      const sessions = (data as { sessions?: SessionMetadata[] } | undefined)?.sessions;
      return this.actionCreators.showSessionSelector(sessions);
    });
  }

  /**
   * 将消息映射为 UI Action
   * @param message - slash 命令返回的消息
   * @param data - 可选的数据参数
   * @returns AppAction 或 null（未找到映射）
   */
  mapToAction(message: string, data?: unknown): AppAction | null {
    const strategy = this.strategies.get(message);
    if (!strategy) {
      return null;
    }
    return strategy(data);
  }

  /**
   * 检查消息是否有对应的映射
   */
  hasMapping(message: string): boolean {
    return this.strategies.has(message);
  }
}
