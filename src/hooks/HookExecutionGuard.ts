/**
 * Hook Execution Guard
 *
 * 保证单次工具调用只触发一次 Hook
 */

export class HookExecutionGuard {
  // toolUseId -> Set<hookEventName>
  private executedHooks = new Map<string, Set<string>>();

  /**
   * 检查是否可以执行
   */
  canExecute(toolUseId: string, eventName: string): boolean {
    if (!this.executedHooks.has(toolUseId)) {
      this.executedHooks.set(toolUseId, new Set());
    }

    const executed = this.executedHooks.get(toolUseId)!;
    if (executed.has(eventName)) {
      console.warn(
        `[HookGuard] Hook ${eventName} for tool ${toolUseId} already executed, skipping`
      );
      return false;
    }

    return true;
  }

  /**
   * 标记已执行
   */
  markExecuted(toolUseId: string, eventName: string): void {
    const executed = this.executedHooks.get(toolUseId);
    if (executed) {
      executed.add(eventName);
    }
  }

  /**
   * 清理已完成的工具
   */
  cleanup(toolUseId: string): void {
    this.executedHooks.delete(toolUseId);
  }

  /**
   * 清理所有
   */
  cleanupAll(): void {
    this.executedHooks.clear();
  }
}
