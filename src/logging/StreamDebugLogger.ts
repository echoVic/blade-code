/**
 * 临时流式调试日志
 *
 * 专门用于调试流式响应问题，写入独立文件便于分析
 * 调试完成后删除此文件
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = path.join(os.homedir(), '.blade', 'logs', 'stream-debug.log');

let initialized = false;

function ensureLogFile(): void {
  if (initialized) return;
  const logDir = path.dirname(LOG_FILE);
  mkdirSync(logDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    LOG_FILE,
    `=== Stream Debug Log Started: ${new Date().toISOString()} ===\n`
  );
  initialized = true;
}

export function streamDebug(
  source: string,
  message: string,
  data?: Record<string, unknown>
): void {
  ensureLogFile();
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  const line = `[${timestamp}] [${source}] ${message}${dataStr}\n`;
  appendFileSync(LOG_FILE, line);
}


