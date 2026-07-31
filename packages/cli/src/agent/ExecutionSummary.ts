/**
 * ExecutionSummary — 生成 Agent 执行摘要
 *
 * 在 agent loop 完成后，汇总执行统计信息用于 CLI 输出、日志和可观测性。
 */

import { estimateCostUsd } from '../services/pricing.js';

export interface ExecutionStats {
  turnsCount: number;
  toolCallsCount: number;
  duration: number;
  tokensUsed?: number;
  toolSuccessRate?: number;
  totalToolFailures?: number;
  model?: string;
}

export interface FormattedSummary {
  lines: string[];
  totalCost?: number;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function buildExecutionSummary(
  stats: ExecutionStats,
): FormattedSummary {
  const lines: string[] = [];

  lines.push(`Duration: ${formatDuration(stats.duration)}`);
  lines.push(`Turns: ${stats.turnsCount}`);

  if (stats.toolCallsCount > 0) {
    let toolLine = `Tool calls: ${stats.toolCallsCount}`;
    if (stats.toolSuccessRate !== undefined) {
      toolLine += ` (${Math.round(stats.toolSuccessRate * 100)}% success)`;
    }
    if (stats.totalToolFailures) {
      toolLine += ` [${stats.totalToolFailures} failures]`;
    }
    lines.push(toolLine);
  }

  let totalCost: number | undefined;
  if (stats.tokensUsed) {
    lines.push(`Tokens: ${stats.tokensUsed.toLocaleString()}`);
    if (stats.model) {
      const inputTokens = Math.round(stats.tokensUsed * 0.7);
      const outputTokens = Math.round(stats.tokensUsed * 0.3);
      totalCost = estimateCostUsd(stats.model, inputTokens, outputTokens);
      if (totalCost > 0) {
        lines.push(`Est. cost: $${totalCost.toFixed(4)}`);
      }
    }
  }

  return { lines, totalCost };
}

export function formatExecutionSummary(stats: ExecutionStats): string {
  const { lines } = buildExecutionSummary(stats);
  return lines.join(' | ');
}
