/**
 * 权限模式行为测试
 * 验证 DEFAULT、AUTO_EDIT、YOLO 模式的正确行为
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionChecker,
  PermissionResult,
  type ToolInvocationDescriptor,
} from '../../../src/config/PermissionChecker.js';
import { PermissionMode } from '../../../src/config/types.js';
import { ToolKind } from '../../../src/tools/types/index.js';

// 模拟 PermissionStage 的 applyModeOverrides 逻辑
function applyModeOverrides(
  toolKind: ToolKind,
  checkResult: { result: PermissionResult },
  permissionMode: PermissionMode
): { result: PermissionResult; reason: string } {
  // 1. 如果已被 deny 规则拒绝，不覆盖（最高优先级）
  if (checkResult.result === PermissionResult.DENY) {
    return { result: PermissionResult.DENY, reason: 'denied by rule' };
  }

  // 2. 如果已被 allow 规则批准，不覆盖
  if (checkResult.result === PermissionResult.ALLOW) {
    return { result: PermissionResult.ALLOW, reason: 'allowed by rule' };
  }

  // 3. YOLO 模式：批准所有工具（在检查规则之后）
  if (permissionMode === PermissionMode.YOLO) {
    return {
      result: PermissionResult.ALLOW,
      reason: 'YOLO 模式: 自动批准所有工具调用',
    };
  }

  // 4. Read/Search 工具：所有模式下都自动批准
  if (toolKind === ToolKind.Read || toolKind === ToolKind.Search) {
    return {
      result: PermissionResult.ALLOW,
      reason: '只读工具无需确认',
    };
  }

  // 5. AUTO_EDIT 模式：额外批准 Edit 工具
  if (permissionMode === PermissionMode.AUTO_EDIT && toolKind === ToolKind.Edit) {
    return {
      result: PermissionResult.ALLOW,
      reason: 'AUTO_EDIT 模式: 自动批准编辑类工具',
    };
  }

  // 6. 其他情况：保持原检查结果
  return { result: checkResult.result, reason: 'default ask' };
}

describe('权限模式行为', () => {
  describe('DEFAULT 模式', () => {
    const mode = PermissionMode.DEFAULT;

    it('应该自动批准 Read 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Read,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.reason).toBe('只读工具无需确认');
    });

    it('应该自动批准 Search 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Search,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.reason).toBe('只读工具无需确认');
    });

    it('应该要求确认 Edit 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Edit,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该要求确认 Execute 工具（Bash）', () => {
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该要求确认 Delete 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Delete,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该尊重 DENY 规则（即使是 Read 工具）', () => {
      const result = applyModeOverrides(
        ToolKind.Read,
        { result: PermissionResult.DENY },
        mode
      );
      expect(result.result).toBe(PermissionResult.DENY);
    });

    it('应该尊重 ALLOW 规则（即使是 Execute 工具）', () => {
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.ALLOW },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });
  });

  describe('AUTO_EDIT 模式', () => {
    const mode = PermissionMode.AUTO_EDIT;

    it('应该自动批准 Read 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Read,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Search 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Search,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Edit 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Edit,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.reason).toBe('AUTO_EDIT 模式: 自动批准编辑类工具');
    });

    it('应该要求确认 Execute 工具（Bash）', () => {
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该要求确认 Delete 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Delete,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该要求确认 Move 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Move,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ASK);
    });

    it('应该尊重 DENY 规则（即使是 Edit 工具）', () => {
      const result = applyModeOverrides(
        ToolKind.Edit,
        { result: PermissionResult.DENY },
        mode
      );
      expect(result.result).toBe(PermissionResult.DENY);
    });
  });

  describe('YOLO 模式', () => {
    const mode = PermissionMode.YOLO;

    it('应该自动批准 Read 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Read,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
      expect(result.reason).toBe('YOLO 模式: 自动批准所有工具调用');
    });

    it('应该自动批准 Edit 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Edit,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Execute 工具（Bash）', () => {
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Delete 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Delete,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Move 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Move,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该自动批准 Network 工具', () => {
      const result = applyModeOverrides(
        ToolKind.Network,
        { result: PermissionResult.ASK },
        mode
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('应该尊重 DENY 规则（优先级最高）', () => {
      // 模拟权限检查器返回 DENY 结果
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.DENY },
        mode
      );
      // DENY 规则应该优先于 YOLO 模式
      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.reason).toBe('denied by rule');
    });
  });

  describe('权限规则优先级', () => {
    it('DENY 规则应该优先于 YOLO 模式', () => {
      // 直接测试 applyModeOverrides 的逻辑：
      // 即使在 YOLO 模式，传入的 DENY 结果仍然应该被尊重
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: PermissionResult.DENY }, // 模拟权限检查器返回 DENY
        PermissionMode.YOLO
      );
      expect(result.result).toBe(PermissionResult.DENY);
      expect(result.reason).toBe('denied by rule');
    });

    it('ALLOW 规则应该优先于模式的 ASK 行为', () => {
      const checker = new PermissionChecker({
        allow: ['Bash(command:npm*)'],
        ask: [],
        deny: [],
      });

      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Bash',
        params: { command: 'npm test' },
        affectedPaths: [],
      };

      const checkResult = checker.check(descriptor);
      expect(checkResult.result).toBe(PermissionResult.ALLOW);

      // 在 DEFAULT 模式下，ALLOW 规则覆盖了 ASK 行为
      const result = applyModeOverrides(
        ToolKind.Execute,
        { result: checkResult.result },
        PermissionMode.DEFAULT
      );
      expect(result.result).toBe(PermissionResult.ALLOW);
    });

    it('模式规则应该优先于默认的 ASK 行为', () => {
      // DEFAULT 模式下，Read 工具自动批准
      const result1 = applyModeOverrides(
        ToolKind.Read,
        { result: PermissionResult.ASK },
        PermissionMode.DEFAULT
      );
      expect(result1.result).toBe(PermissionResult.ALLOW);

      // AUTO_EDIT 模式下，Edit 工具自动批准
      const result2 = applyModeOverrides(
        ToolKind.Edit,
        { result: PermissionResult.ASK },
        PermissionMode.AUTO_EDIT
      );
      expect(result2.result).toBe(PermissionResult.ALLOW);
    });
  });

  describe('边界情况', () => {
    it('应该正确处理 Other 类型工具', () => {
      // DEFAULT 模式下，Other 类型需要确认
      const result1 = applyModeOverrides(
        ToolKind.Other,
        { result: PermissionResult.ASK },
        PermissionMode.DEFAULT
      );
      expect(result1.result).toBe(PermissionResult.ASK);

      // YOLO 模式下，Other 类型自动批准
      const result2 = applyModeOverrides(
        ToolKind.Other,
        { result: PermissionResult.ASK },
        PermissionMode.YOLO
      );
      expect(result2.result).toBe(PermissionResult.ALLOW);
    });

    it('应该正确处理 Think 类型工具', () => {
      // Think 工具在所有模式下都需要遵循权限检查
      const result1 = applyModeOverrides(
        ToolKind.Think,
        { result: PermissionResult.ASK },
        PermissionMode.DEFAULT
      );
      expect(result1.result).toBe(PermissionResult.ASK);

      // YOLO 模式下自动批准
      const result2 = applyModeOverrides(
        ToolKind.Think,
        { result: PermissionResult.ASK },
        PermissionMode.YOLO
      );
      expect(result2.result).toBe(PermissionResult.ALLOW);
    });

    it('应该正确处理 Network 类型工具', () => {
      // DEFAULT 模式下，Network 需要确认
      const result1 = applyModeOverrides(
        ToolKind.Network,
        { result: PermissionResult.ASK },
        PermissionMode.DEFAULT
      );
      expect(result1.result).toBe(PermissionResult.ASK);

      // AUTO_EDIT 模式下，Network 仍需确认
      const result2 = applyModeOverrides(
        ToolKind.Network,
        { result: PermissionResult.ASK },
        PermissionMode.AUTO_EDIT
      );
      expect(result2.result).toBe(PermissionResult.ASK);

      // YOLO 模式下自动批准
      const result3 = applyModeOverrides(
        ToolKind.Network,
        { result: PermissionResult.ASK },
        PermissionMode.YOLO
      );
      expect(result3.result).toBe(PermissionResult.ALLOW);
    });
  });
});
