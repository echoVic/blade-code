/**
 * ACP (Agent Client Protocol) 集成模块
 *
 * 提供 Blade 作为 ACP Agent 的能力，使其可以被 Zed、JetBrains、Neovim 等编辑器调用。
 *
 */

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from './BladeAgent.js';

/**
 * 启动 ACP 集成模式
 *
 * 将 Blade CLI 作为 ACP Agent 运行，通过 stdio 与 IDE 通信。
 * IDE (如 Zed) 作为 ACP Client 启动 Blade 进程并发送请求。
 */
export async function runAcpIntegration(): Promise<void> {
  // 使用 Web Streams API 包装 Node.js streams
  const stdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // 创建 ndJSON 流（换行分隔的 JSON）
  const stream = acp.ndJsonStream(stdout, stdin);

  // 创建 ACP 连接，传入 Agent 工厂函数
  const connection = new acp.AgentSideConnection(
    (conn) => new BladeAgent(conn),
    stream
  );

  // 等待连接关闭
  await connection.closed;
}
