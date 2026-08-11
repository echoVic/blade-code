import { describe, expect, it } from 'vitest';
import { PermissionMode } from '../../../../../src/config/types.js';
import { Type } from '../../../../../src/schema/index.js';
import { createTool } from '../../../../../src/tools/core/createTool.js';
import {
  PermissionResolver,
  resolvePermissionDecision,
} from '../../../../../src/tools/execution/PermissionResolver.js';
import { InMemorySessionApprovalStore } from '../../../../../src/tools/execution/SessionApprovalStore.js';
import {
  type PermissionDecision,
  type Tool,
  type ToolInvocation,
  ToolKind,
} from '../../../../../src/tools/types/index.js';

function rule(
  behavior: 'allow' | 'ask' | 'deny',
  reason = 'from-rule'
): PermissionDecision {
  return { behavior, source: 'rule', reason };
}

function hook(
  behavior: 'allow' | 'ask' | 'deny',
  reason = 'from-hook'
): PermissionDecision {
  return { behavior, source: 'hook', reason };
}

const resolve = resolvePermissionDecision;

describe('resolvePermissionDecision — 决策矩阵', () => {
  describe('硬不变量: Hook 不能放宽规则库', () => {
    it('rule=deny + hook=allow → deny (来源保留 rule)', () => {
      const r = resolve(rule('deny'), hook('allow'));
      expect(r.behavior).toBe('deny');
      expect(r.source).toBe('rule');
    });

    it('rule=ask + hook=allow → ask (Hook allow 被忽略;保留 rule 的 reason)', () => {
      const r = resolve(rule('ask', 'rule says ask'), hook('allow'));
      expect(r.behavior).toBe('ask');
      expect(r.source).toBe('rule');
      expect(r.reason).toBe('rule says ask');
    });

    it('rule=ask + hook=deny → deny (Hook 可以加严)', () => {
      const r = resolve(rule('ask'), hook('deny'));
      expect(r.behavior).toBe('deny');
      expect(r.source).toBe('hook');
    });
  });

  describe('Hook reason 透传: 两侧均为 ask 时优先显示 Hook 的场景化原因', () => {
    it('rule=ask + hook=ask → 返回 hook (展示场景化上下文)', () => {
      const r = resolve(
        rule('ask', 'generic: requires confirmation'),
        hook('ask', 'modifying production config')
      );
      expect(r.behavior).toBe('ask');
      expect(r.source).toBe('hook');
      expect(r.reason).toBe('modifying production config');
    });

    it('rule=allow + hook=ask → 返回 hook', () => {
      const r = resolve(
        rule('allow', 'allowed by rule'),
        hook('ask', 'hook wants confirm')
      );
      expect(r.behavior).toBe('ask');
      expect(r.source).toBe('hook');
      expect(r.reason).toBe('hook wants confirm');
    });
  });

  describe('rule=deny 行', () => {
    it.each([
      ['deny', 'deny'],
      ['ask', 'deny'],
      ['allow', 'deny'],
    ] as const)('rule=deny + hook=%s → %s', (hookBehavior, expected) => {
      const r = resolve(rule('deny'), hook(hookBehavior));
      expect(r.behavior).toBe(expected);
      expect(r.source).toBe('rule');
    });

    it('rule=deny + hook=undefined → deny', () => {
      expect(resolve(rule('deny'), undefined).behavior).toBe('deny');
    });
  });

  describe('rule=ask 行', () => {
    it.each([
      ['ask', 'ask', 'hook'], // 两侧 ask 时优先 hook (场景化 reason)
      ['allow', 'ask', 'rule'], // hook=allow 不能放宽 rule 的 ask
      ['deny', 'deny', 'hook'],
    ] as const)('rule=ask + hook=%s → %s (source=%s)', (hookBehavior, expectedBehavior, expectedSource) => {
      const r = resolve(rule('ask'), hook(hookBehavior));
      expect(r.behavior).toBe(expectedBehavior);
      expect(r.source).toBe(expectedSource);
    });

    it('rule=ask + hook=undefined → ask', () => {
      expect(resolve(rule('ask'), undefined).behavior).toBe('ask');
    });
  });

  describe('rule=allow 行', () => {
    it.each([
      ['allow', 'allow', 'rule'],
      ['ask', 'ask', 'hook'],
      ['deny', 'deny', 'hook'],
    ] as const)('rule=allow + hook=%s → %s (source=%s)', (hookBehavior, expectedBehavior, expectedSource) => {
      const r = resolve(rule('allow'), hook(hookBehavior));
      expect(r.behavior).toBe(expectedBehavior);
      expect(r.source).toBe(expectedSource);
    });

    it('rule=allow + hook=undefined → allow', () => {
      const r = resolve(rule('allow'), undefined);
      expect(r.behavior).toBe('allow');
      expect(r.source).toBe('rule');
    });
  });

  describe('rule=undefined 行 (规则库未表态)', () => {
    it('rule=undefined + hook=allow → allow', () => {
      const r = resolve(undefined, hook('allow'));
      expect(r.behavior).toBe('allow');
      expect(r.source).toBe('hook');
    });

    it('rule=undefined + hook=ask → ask', () => {
      expect(resolve(undefined, hook('ask')).behavior).toBe('ask');
    });

    it('rule=undefined + hook=deny → deny', () => {
      expect(resolve(undefined, hook('deny')).behavior).toBe('deny');
    });

    it('rule=undefined + hook=undefined → default ask (兜底)', () => {
      const r = resolve(undefined, undefined);
      expect(r.behavior).toBe('ask');
      expect(r.source).toBe('default');
      expect(r.reason).toMatch(/defaulting to ask/);
    });
  });

  describe('reason/matchedRule 透传', () => {
    it('最终决策保留原始 reason', () => {
      const r = resolve(
        { behavior: 'deny', source: 'rule', reason: 'blocked by policy' },
        undefined
      );
      expect(r.reason).toBe('blocked by policy');
    });
  });
});

describe('verification agent permission boundary', () => {
  const resolver = new PermissionResolver(
    { allow: [], ask: [], deny: [] },
    new InMemorySessionApprovalStore(),
    PermissionMode.YOLO
  );
  const bash = createTool({
    name: 'Bash',
    displayName: 'Bash',
    kind: ToolKind.Execute,
    schema: Type.Object({ command: Type.String() }),
    description: { short: 'Run command' },
    execute: async () => ({ success: true, llmContent: 'ok' }),
  });
  const write = createTool({
    name: 'Write',
    displayName: 'Write',
    kind: ToolKind.Write,
    schema: Type.Object({ file_path: Type.String() }),
    affectedPaths: (params) => [params.file_path],
    description: { short: 'Write file' },
    execute: async () => ({ success: true, llmContent: 'ok' }),
  });

  it('allows verification and read-only commands even when the parent is YOLO', () => {
    for (const command of [
      'bun run test:all',
      'npm test 2>&1',
      'git status --short',
      'git diff -- src/a.ts 2>&1',
    ]) {
      const invocation = bash.build({ command });
      expect(
        resolver.resolveRulePermission(
          bash as unknown as Tool,
          invocation as ToolInvocation<unknown>,
          { command },
          {
            subagentType: 'verification',
            permissionMode: PermissionMode.YOLO,
          }
        ).decision
      ).toMatchObject({
        behavior: 'allow',
        source: 'rule',
      });
    }
    const invocation = bash.build({ command: 'node --test' });
    expect(
      resolver.resolveRulePermission(
        bash as unknown as Tool,
        invocation as ToolInvocation<unknown>,
        { command: 'node --test', cwd: '/workspace/project' },
        {
          subagentType: 'verification',
          permissionMode: PermissionMode.YOLO,
          workspaceRoot: '/workspace/project',
        }
      ).decision
    ).toMatchObject({
      behavior: 'allow',
      source: 'rule',
    });
    const wrappedCommand = 'cd /workspace/project/packages/cli && npm test';
    expect(
      resolver.resolveRulePermission(
        bash as unknown as Tool,
        bash.build({ command: wrappedCommand }) as ToolInvocation<unknown>,
        { command: wrappedCommand },
        {
          subagentType: 'verification',
          permissionMode: PermissionMode.YOLO,
          workspaceRoot: '/workspace/project',
        }
      ).decision
    ).toMatchObject({
      behavior: 'allow',
      source: 'rule',
    });
  });

  it('denies mutating Bash and write tools even when the parent is YOLO', () => {
    for (const subagentType of ['verification', 'goal-verification', 'review']) {
      for (const params of [
        { command: 'rm -rf build' },
        { command: 'rm -rf build; bun test' },
        { command: 'bun test --update' },
        { command: 'npm test 2>test.log' },
        { command: 'bun test', run_in_background: true },
        { command: 'git status --short', env: { PATH: '/tmp/evil' } },
        { command: 'bun test', cwd: '/tmp' },
        { command: 'bun test', cwd: '../other-workspace' },
      ]) {
        const bashInvocation = bash.build({ command: params.command });
        expect(
          resolver.resolveRulePermission(
            bash as unknown as Tool,
            bashInvocation as ToolInvocation<unknown>,
            params,
            {
              subagentType,
              permissionMode: PermissionMode.YOLO,
            }
          ).decision
        ).toMatchObject({
          behavior: 'deny',
          matchedRule: 'builtin:audit-agent-read-only',
        });
      }

      const escapedCommand = 'cd /workspace/other && npm test';
      expect(
        resolver.resolveRulePermission(
          bash as unknown as Tool,
          bash.build({ command: escapedCommand }) as ToolInvocation<unknown>,
          { command: escapedCommand },
          {
            subagentType,
            permissionMode: PermissionMode.YOLO,
            workspaceRoot: '/workspace/project',
          }
        ).decision
      ).toMatchObject({
        behavior: 'deny',
        matchedRule: 'builtin:audit-agent-read-only',
      });

      const writeInvocation = write.build({ file_path: '/tmp/changed.txt' });
      expect(
        resolver.resolveRulePermission(
          write as unknown as Tool,
          writeInvocation as ToolInvocation<unknown>,
          { file_path: '/tmp/changed.txt' },
          {
            subagentType,
            permissionMode: PermissionMode.YOLO,
          }
        ).decision
      ).toMatchObject({
        behavior: 'deny',
        matchedRule: 'builtin:audit-agent-read-only',
      });
    }
  });

  it('does not override an explicit Bash deny rule', () => {
    const denied = new PermissionResolver(
      { allow: [], ask: [], deny: ['Bash'] },
      new InMemorySessionApprovalStore(),
      PermissionMode.YOLO
    );
    const invocation = bash.build({ command: 'npm test' });

    expect(
      denied.resolveRulePermission(
        bash as unknown as Tool,
        invocation as ToolInvocation<unknown>,
        { command: 'npm test' },
        {
          subagentType: 'verification',
          permissionMode: PermissionMode.YOLO,
          workspaceRoot: '/workspace/project',
        }
      ).decision
    ).toMatchObject({
      behavior: 'deny',
      source: 'rule',
    });
  });
});
