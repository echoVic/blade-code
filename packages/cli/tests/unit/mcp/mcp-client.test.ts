/**
 * McpClient 错误处理测试
 *
 * 主要测试 ErrorType 枚举和基本的 Client 结构，
 * 因为 McpClient 核心逻辑严重依赖外部 SDK 和网络，
 * 这里主要做基本的单元测试覆盖。
 */

import { describe, expect, it } from 'vitest';
import { ErrorType } from '../../../src/mcp/McpClient.js';

describe('McpClient', () => {
  describe('ErrorType', () => {
    it('should have correct error types', () => {
      expect(ErrorType.NETWORK_TEMPORARY).toBe('network_temporary');
      expect(ErrorType.NETWORK_PERMANENT).toBe('network_permanent');
      expect(ErrorType.CONFIG_ERROR).toBe('config_error');
      expect(ErrorType.AUTH_ERROR).toBe('auth_error');
      expect(ErrorType.UNKNOWN).toBe('unknown');
    });
  });

  // 更多复杂的测试需要 mock @modelcontextprotocol/sdk，
  // 目前先保证文件被 import 和基础定义被覆盖。
});
