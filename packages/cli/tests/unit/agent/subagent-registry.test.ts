/**
 * SubagentRegistry 测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';

// Mock fs and path
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

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
  });
});
