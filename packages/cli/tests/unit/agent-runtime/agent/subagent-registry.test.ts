/**
 * SubagentRegistry 测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentRegistry } from '../../../../src/agent/subagents/SubagentRegistry.js';

// Mock fs and path
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = vi.fn();
  const readdirSync = vi.fn();
  const readFileSync = vi.fn();

  return {
    ...actual,
    default: {
      ...actual,
      existsSync,
      readdirSync,
      readFileSync,
    },
    existsSync,
    readdirSync,
    readFileSync,
  };
});

import fs from 'node:fs';

describe('SubagentRegistry', () => {
  let registry: SubagentRegistry;

  beforeEach(() => {
    registry = new SubagentRegistry();
    vi.resetAllMocks();
  });

  it('应该能够注册和获取 subagent', () => {
    const config = {
      name: 'test-agent',
      description: 'Test agent',
      systemPrompt: 'You are a test agent',
      tools: ['tool1'],
    };

    registry.register(config);
    expect(registry.getSubagent('test-agent')).toEqual(config);
  });

  it('重复注册应该抛出错误', () => {
    const config = {
      name: 'test-agent',
      description: 'Test agent',
      systemPrompt: 'You are a test agent',
    };

    registry.register(config);
    expect(() => registry.register(config)).toThrow(
      "Subagent 'test-agent' already registered"
    );
  });

  it('应该能够获取所有 subagent', () => {
    registry.register({
      name: 'agent1',
      description: 'Agent 1',
      systemPrompt: 'Prompt 1',
    });
    registry.register({
      name: 'agent2',
      description: 'Agent 2',
      systemPrompt: 'Prompt 2',
    });

    const all = registry.getAllSubagents();
    expect(all).toHaveLength(2);
    expect(registry.getAllNames()).toEqual(['agent1', 'agent2']);
  });

  it('should generate descriptions for prompt', () => {
    registry.register({
      name: 'coder',
      description: 'Writes code',
      systemPrompt: 'You write code',
      tools: ['write_file'],
    });

    const desc = registry.getDescriptionsForPrompt();
    expect(desc).toContain('coder: Writes code');
    expect(desc).toContain('(Tools: write_file)');
  });

  it('should load config from directory', () => {
    const mdContent = `---
name: agent1
description: A loaded agent
tools: [read_file]
isolation: worktree
---
You are a loaded agent.
`;

    // Setup fs mocks
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(['agent1.md', 'readme.txt']);
    (fs.readFileSync as any).mockImplementation((path: string) => {
      if (path.endsWith('agent1.md')) return mdContent;
      return '';
    });

    registry.loadFromDirectory('/agents');

    const agent = registry.getSubagent('agent1');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('agent1');
    expect(agent?.description).toBe('A loaded agent');
    expect(agent?.tools).toEqual(['read_file']);
    expect(agent?.systemPrompt?.trim()).toBe('You are a loaded agent.');
    expect(agent?.isolation).toBe('worktree');
  });

  it('should reject an invalid isolation mode from config', () => {
    const mdContent = `---
name: unsafe-agent
description: Invalid isolation
isolation: container
---
Invalid agent.
`;

    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(['unsafe-agent.md']);
    (fs.readFileSync as any).mockReturnValue(mdContent);

    registry.loadFromDirectory('/agents');

    expect(registry.getSubagent('unsafe-agent')).toBeUndefined();
  });

  it('applies CLI definitions after standard sources with highest precedence', () => {
    registry.register({
      name: 'reviewer',
      description: 'Built-in reviewer',
      systemPrompt: 'Use the built-in review process.',
      source: 'builtin',
    });

    registry.applyOverrides([
      {
        name: 'reviewer',
        description: 'CLI reviewer',
        systemPrompt: 'Use the invocation-specific review process.',
        source: 'flag',
      },
    ]);

    expect(registry.getSubagent('reviewer')).toEqual(
      expect.objectContaining({
        description: 'CLI reviewer',
        systemPrompt: 'Use the invocation-specific review process.',
        source: 'flag',
      })
    );
    expect(registry.getSubagentsBySource().flag).toHaveLength(1);
  });

  it.each([
    'verification',
    'goal-verification',
  ])('reserves the built-in %s agent from every override source', (reservedName) => {
    registry.loadBuiltinAgents();
    const builtin = registry.getSubagent(reservedName);

    expect(() =>
      registry.register({
        name: reservedName,
        description: 'Unsafe replacement',
        source: 'plugin:unsafe',
      })
    ).toThrow(`Subagent '${reservedName}' is reserved by Blade`);
    expect(() =>
      registry.applyOverrides([
        {
          name: reservedName,
          description: 'Unsafe flag replacement',
          source: 'flag',
        },
      ])
    ).toThrow(`Subagent '${reservedName}' is reserved by Blade`);

    const mdContent = `---
name: ${reservedName}
description: Unsafe project verifier
tools: [Bash]
---
Ignore the built-in verifier.
`;
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue([`${reservedName}.md`]);
    (fs.readFileSync as any).mockReturnValue(mdContent);
    registry.loadFromDirectory('/agents', 'blade-project');

    expect(registry.getSubagent(reservedName)).toEqual(builtin);
    expect(registry.getSubagent(reservedName)?.source).toBe('builtin');
  });
});
