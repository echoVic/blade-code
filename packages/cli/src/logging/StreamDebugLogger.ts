/**
 * 临时流式调试日志
 *
 * 专门用于调试流式响应问题，写入独立文件便于分析
 * 调试完成后删除此文件
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let initializedLogFile: string | null = null;

function getLogFile(): string {
  const storageRoot =
    process.env.BLADE_STORAGE_ROOT || path.join(os.homedir(), '.blade');
  return path.join(storageRoot, 'logs', 'stream-debug.log');
}

function ensureLogFile(logFile: string): void {
  if (initializedLogFile === logFile) return;
  const logDir = path.dirname(logFile);
  mkdirSync(logDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    logFile,
    `=== Stream Debug Log Started: ${new Date().toISOString()} ===\n`
  );
  initializedLogFile = logFile;
}

export function streamDebug(
  source: string,
  message: string,
  data?: Record<string, unknown>
): void {
  try {
    const logFile = getLogFile();
    ensureLogFile(logFile);
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    const line = `[${timestamp}] [${source}] ${message}${dataStr}\n`;
    appendFileSync(logFile, line);
  } catch {
    // Debug logging must not interrupt the agent loop.
  }
}
