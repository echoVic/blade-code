/**
 * drainLoop — 消费 generator 事件流，返回最终 LoopResult
 *
 * 用于不需要逐事件处理的场景（如 subagent、slash commands）。
 * 可选传入 onEvent 回调来处理特定事件。
 */

import type { LoopResult } from '../types.js';
import type { LoopEvent } from './types.js';

export async function drainLoop(
  generator: AsyncGenerator<LoopEvent, LoopResult, void>,
  onEvent?: (event: LoopEvent) => void | Promise<void>
): Promise<LoopResult> {
  let iterResult: IteratorResult<LoopEvent, LoopResult>;

  // eslint-disable-next-line no-cond-assign
  while (!(iterResult = await generator.next()).done) {
    if (onEvent) {
      await onEvent(iterResult.value);
    }
  }

  return iterResult.value;
}
