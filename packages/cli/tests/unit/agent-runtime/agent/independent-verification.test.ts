import { describe, expect, it } from 'vitest';
import {
  BASH_MUTATION_MARKER,
  checkIndependentVerificationGate,
  collectModifiedFiles,
  parseVerificationVerdict,
  requiresIndependentVerification,
  restoreIndependentVerificationState,
} from '../../../../src/agent/loop/independentVerification.js';
import type { ToolResult } from '../../../../src/tools/types/index.js';

function successfulResult(metadata: Record<string, unknown>): ToolResult {
  return {
    success: true,
    llmContent: 'ok',
    metadata,
  };
}

function gateInput(
  overrides: Partial<Parameters<typeof checkIndependentVerificationGate>[0]> = {}
): Parameters<typeof checkIndependentVerificationGate>[0] {
  return {
    isSubagent: false,
    taskAvailable: true,
    delegationForbidden: false,
    singleTaskDelegationRequired: false,
    modifiedFiles: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']),
    mutationRevision: 3,
    verificationRevision: -1,
    verificationVerdict: undefined,
    retryCount: 0,
    ...overrides,
  };
}

describe('independent verification policy', () => {
  it('accepts exactly one structured verdict and rejects ambiguous output', () => {
    expect(
      parseVerificationVerdict(
        'Evidence\n## Verification Result: PASS\nAll checks completed.'
      )
    ).toBe('pass');
    expect(
      parseVerificationVerdict(
        '## Verification Result: PASS\n## Verification Result: FAIL'
      )
    ).toBeUndefined();
    expect(
      parseVerificationVerdict(
        '## Verification Result: PASS\n## Verification Result: PASS'
      )
    ).toBeUndefined();
    expect(parseVerificationVerdict('PASS')).toBeUndefined();
  });

  it('records write metadata while distinguishing verification Bash commands', () => {
    expect(
      collectModifiedFiles(
        'ApplyPatch',
        successfulResult({
          affected_paths: ['src/a.ts', 'src/b.ts'],
        })
      )
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(
      collectModifiedFiles(
        'Bash',
        successfulResult({ command: 'bun run test:all', exit_code: 0 })
      )
    ).toEqual([]);
    expect(
      collectModifiedFiles(
        'Bash',
        successfulResult({
          command: 'cd /workspace/project && bun run test:all',
          exit_code: 0,
        }),
        '/workspace/project'
      )
    ).toEqual([]);
    expect(
      collectModifiedFiles(
        'Bash',
        successfulResult({
          command: 'cd /workspace/other && bun run test:all',
          exit_code: 0,
        }),
        '/workspace/project'
      )
    ).toEqual([BASH_MUTATION_MARKER]);
    expect(
      collectModifiedFiles(
        'Bash',
        successfulResult({ command: 'printf x > generated.txt', exit_code: 0 })
      )
    ).toEqual([BASH_MUTATION_MARKER]);
  });

  it('requires verification for broad or high-risk implementation changes', () => {
    expect(
      requiresIndependentVerification(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']))
    ).toBe(true);
    expect(requiresIndependentVerification(new Set(['src/server/routes/a.ts']))).toBe(
      true
    );
    expect(
      requiresIndependentVerification(
        new Set(['docs/a.md', 'tests/a.test.ts', 'fixtures/a.json'])
      )
    ).toBe(false);
    expect(requiresIndependentVerification(new Set(['src/a.ts', 'src/b.ts']))).toBe(
      false
    );
  });

  it('requires a fresh synchronous verifier and accepts only a current PASS', () => {
    expect(checkIndependentVerificationGate(gateInput())).toMatchObject({
      action: 'retry',
      requireVerificationTask: true,
    });
    expect(
      checkIndependentVerificationGate(
        gateInput({
          verificationRevision: 3,
          verificationVerdict: 'pass',
        })
      )
    ).toEqual({ action: 'none' });
    expect(
      checkIndependentVerificationGate(
        gateInput({
          mutationRevision: 4,
          verificationRevision: 3,
          verificationVerdict: 'pass',
        })
      )
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: true,
    });
  });

  it('requires fixes after FAIL or PARTIAL before another verifier run', () => {
    expect(
      checkIndependentVerificationGate(
        gateInput({
          verificationRevision: 3,
          verificationVerdict: 'fail',
        })
      )
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: false,
      prompt: expect.stringContaining('returned FAIL'),
    });
    expect(
      checkIndependentVerificationGate(
        gateInput({
          verificationRevision: 3,
          verificationVerdict: 'partial',
        })
      )
    ).toMatchObject({
      action: 'retry',
      requireVerificationTask: false,
      prompt: expect.stringContaining('returned PARTIAL'),
    });
  });

  it('restores durable mutation revisions and invalidates an older PASS', () => {
    const restored = restoreIndependentVerificationState([
      {
        role: 'tool',
        tool_call_id: 'write-1',
        name: 'Write',
        content: 'ok',
        metadata: {
          toolName: 'Write',
          error: null,
          metadata: { file_path: 'src/server/a.ts' },
        },
      },
      {
        role: 'tool',
        tool_call_id: 'verify-1',
        name: 'Task',
        content: '## Verification Result: PASS',
        metadata: {
          toolName: 'Task',
          error: null,
          metadata: {
            subagentType: 'verification',
            subagentStatus: 'completed',
            verificationAgentBuiltin: true,
            verificationVerdict: 'pass',
          },
        },
      },
      {
        role: 'tool',
        tool_call_id: 'edit-2',
        name: 'Edit',
        content: 'ok',
        metadata: {
          independentVerification: {
            modifiedFiles: ['src/server/b.ts'],
          },
        },
      },
    ]);

    expect(restored.modifiedFiles).toEqual(
      new Set(['src/server/a.ts', 'src/server/b.ts'])
    );
    expect(restored.mutationRevision).toBe(2);
    expect(restored.verificationRevision).toBe(-1);
    expect(restored.verificationVerdict).toBeUndefined();
  });

  it('skips incompatible execution surfaces and fails closed at the retry limit', () => {
    for (const overrides of [
      { isSubagent: true },
      { taskAvailable: false },
      { delegationForbidden: true },
      { singleTaskDelegationRequired: true },
    ]) {
      expect(checkIndependentVerificationGate(gateInput(overrides))).toEqual({
        action: 'none',
      });
    }
    expect(
      checkIndependentVerificationGate(gateInput({ retryCount: 3 }))
    ).toMatchObject({
      action: 'fail',
    });
  });
});
