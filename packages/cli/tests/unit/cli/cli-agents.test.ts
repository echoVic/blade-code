import { describe, expect, it } from 'vitest';
import { parseCliAgents } from '../../../src/cli/agents.js';
import { PermissionMode } from '../../../src/config/types.js';

describe('--agents parser', () => {
  it('parses strict custom agent definitions into runtime configs', () => {
    const agents = parseCliAgents(
      JSON.stringify({
        reviewer: {
          description: ' Reviews implementation changes ',
          prompt: ' Review correctness and run tests. ',
          tools: ['Read', ' Bash ', 'Read'],
          disallowedTools: ['Write'],
          model: 'deepseek-v4-pro',
          permissionMode: 'dontAsk',
          maxTurns: 6,
          isolation: 'worktree',
        },
      })
    );

    expect(agents).toEqual([
      {
        name: 'reviewer',
        description: 'Reviews implementation changes',
        systemPrompt: 'Review correctness and run tests.',
        tools: ['Read', 'Bash'],
        disallowedTools: ['Write'],
        model: 'deepseek-v4-pro',
        permissionMode: PermissionMode.YOLO,
        maxTurns: 6,
        isolation: 'worktree',
        source: 'flag',
      },
    ]);
  });

  it('fails closed for malformed, ambiguous, or unsupported definitions', () => {
    expect(() => parseCliAgents('{"reviewer":')).toThrow(
      'Invalid JSON provided to --agents'
    );
    expect(() => parseCliAgents('[]')).toThrow('--agents must be a JSON object');
    expect(() =>
      parseCliAgents(JSON.stringify({ reviewer: { description: 'Reviews code' } }))
    ).toThrow('Invalid --agents definition for "reviewer"');
    expect(() =>
      parseCliAgents(
        JSON.stringify({
          'bad name': { description: 'Reviews code', prompt: 'Review.' },
        })
      )
    ).toThrow('Invalid --agents name');
    expect(() =>
      parseCliAgents(
        JSON.stringify({
          reviewer: {
            description: 'Reviews code',
            prompt: 'Review.',
            unsupported: true,
          },
        })
      )
    ).toThrow('Invalid --agents definition for "reviewer"');
  });

  it('inherits the parent permission mode when the definition omits it', () => {
    const [agent] = parseCliAgents(
      JSON.stringify({
        reviewer: {
          description: 'Reviews code',
          prompt: 'Review correctness.',
        },
      })
    );

    expect(agent?.permissionMode).toBeUndefined();
  });
});
