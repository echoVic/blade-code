import { describe, expect, it, vi } from 'vitest';
import {
  checkIncompleteIntent,
  checkOutputRecovery,
  checkVerificationRequired,
  checkWorktreeRequirement,
  MAX_INCOMPLETE_INTENT_RETRIES,
  MAX_OUTPUT_RECOVERY_LIMIT,
  MAX_VERIFICATION_RETRIES,
  MAX_WORKTREE_RETRIES,
  RETRY_PROMPT,
  VERIFICATION_FAILURE_MESSAGE,
  VERIFICATION_RETRY_PROMPT,
  WORKTREE_EXIT_RETRY_PROMPT,
} from '../../../../src/agent/loop/completionPolicy.js';

describe('completionPolicy', () => {
  describe('checkOutputRecovery', () => {
    const makeBudget = () => ({
      budget: 100000,
      usage: 0,
      consecutiveContinuations: 0,
      lastOutputDelta: 0,
      isSubagent: false,
    });

    it('returns none when finishReason is not length', () => {
      expect(checkOutputRecovery('stop', 0, makeBudget())).toEqual({ action: 'none' });
      expect(checkOutputRecovery('tool_calls', 0, makeBudget())).toEqual({
        action: 'none',
      });
      expect(checkOutputRecovery(undefined, 0, makeBudget())).toEqual({
        action: 'none',
      });
    });

    it('returns recover when under limit', () => {
      expect(checkOutputRecovery('length', 0, makeBudget())).toEqual({
        action: 'recover',
      });
      expect(
        checkOutputRecovery('length', MAX_OUTPUT_RECOVERY_LIMIT - 1, makeBudget())
      ).toEqual({ action: 'recover' });
    });

    it('returns truncated when at limit', () => {
      expect(
        checkOutputRecovery('length', MAX_OUTPUT_RECOVERY_LIMIT, makeBudget())
      ).toEqual({ action: 'truncated' });
    });
  });

  describe('checkIncompleteIntent', () => {
    it('returns none for normal content', () => {
      expect(checkIncompleteIntent('The file contains the answer.', 0)).toEqual({
        action: 'none',
      });
    });

    it('detects trailing colon pattern', () => {
      const result = checkIncompleteIntent('Here is what I found:', 0);
      expect(result.action).toBe('retry');
    });

    it('detects trailing ellipsis', () => {
      const result = checkIncompleteIntent('Let me check the file...', 0);
      expect(result.action).toBe('retry');
    });

    it('detects Chinese intent patterns', () => {
      const result = checkIncompleteIntent('让我先看看这个文件', 0);
      expect(result.action).toBe('retry');
    });

    it('detects English intent patterns', () => {
      const result = checkIncompleteIntent("I'll create a new function for this", 0);
      expect(result.action).toBe('retry');
    });

    it('returns none when retryCount exceeds max', () => {
      expect(
        checkIncompleteIntent('Let me start:', MAX_INCOMPLETE_INTENT_RETRIES)
      ).toEqual({ action: 'none' });
    });

    it('returns none for empty content', () => {
      expect(checkIncompleteIntent('', 0)).toEqual({ action: 'none' });
      expect(checkIncompleteIntent(undefined, 0)).toEqual({ action: 'none' });
    });

    it('detects code block without tool calls', () => {
      const content =
        '```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n// more lines to pass the 50-char threshold...\n```';
      const result = checkIncompleteIntent(content, 0, false);
      expect(result.action).toBe('retry');
      expect(result).toEqual({ action: 'retry', prompt: RETRY_PROMPT });
    });

    it('skips code block detection when hadToolCalls is true', () => {
      const content =
        '```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\n// more lines to pass the 50-char threshold...\n```';
      const result = checkIncompleteIntent(content, 0, true);
      expect(result.action).toBe('none');
    });

    it('ignores patterns inside unclosed code blocks', () => {
      const content = 'Some text\n```\nLet me first check:\n';
      const result = checkIncompleteIntent(content, 0);
      expect(result.action).toBe('none');
    });

    it('detects numbered step lists without tool execution', () => {
      const content =
        'Here is my plan:\n1. First I will read the file\n2. Then modify it\n3. Finally run tests';
      const result = checkIncompleteIntent(content, 0);
      expect(result.action).toBe('retry');
    });
  });

  describe('checkVerificationRequired', () => {
    it('requires Bash when the user explicitly asks to run tests', () => {
      expect(
        checkVerificationRequired(
          'Fix the bug and run npm test before finishing.',
          new Set(['Read', 'Edit']),
          0
        )
      ).toEqual({
        action: 'retry',
        prompt: VERIFICATION_RETRY_PROMPT,
      });
    });

    it('accepts a successful Bash verification', () => {
      expect(
        checkVerificationRequired(
          '修复这个问题并运行测试。',
          new Set(['Read', 'Edit', 'Bash']),
          0
        )
      ).toEqual({ action: 'none' });
    });

    it('does not force Bash when verification was not requested', () => {
      expect(
        checkVerificationRequired(
          'Explain how this function works.',
          new Set(['Read']),
          0
        )
      ).toEqual({ action: 'none' });
    });

    it('fails closed at the verification retry limit', () => {
      expect(
        checkVerificationRequired(
          'Run the test suite.',
          new Set(),
          MAX_VERIFICATION_RETRIES
        )
      ).toEqual({
        action: 'fail',
        message: VERIFICATION_FAILURE_MESSAGE,
      });
    });
  });

  describe('checkWorktreeRequirement', () => {
    it('requires EnterWorktree when worktree isolation was explicit', () => {
      expect(
        checkWorktreeRequirement('Use a git worktree to fix this bug.', new Set(), 0)
      ).toEqual(
        expect.objectContaining({
          action: 'retry',
          tool: 'EnterWorktree',
        })
      );
    });

    it('requires ExitWorktree when the user explicitly asks to exit', () => {
      expect(
        checkWorktreeRequirement(
          'Use a worktree, then exit the worktree with action keep.',
          new Set(['EnterWorktree', 'Bash']),
          0
        )
      ).toEqual({
        action: 'retry',
        tool: 'ExitWorktree',
        prompt: WORKTREE_EXIT_RETRY_PROMPT,
      });
    });

    it('accepts the complete managed worktree lifecycle', () => {
      expect(
        checkWorktreeRequirement(
          'Use a worktree, then exit the worktree with action keep.',
          new Set(['EnterWorktree', 'ExitWorktree']),
          0
        )
      ).toEqual({ action: 'none' });
    });

    it('does not apply to ordinary coding requests', () => {
      expect(
        checkWorktreeRequirement('Fix the bug and run tests.', new Set(), 0)
      ).toEqual({ action: 'none' });
    });

    it('fails closed after repeated worktree protocol violations', () => {
      expect(
        checkWorktreeRequirement(
          'Use a worktree to fix this bug.',
          new Set(),
          MAX_WORKTREE_RETRIES
        )
      ).toEqual(
        expect.objectContaining({
          action: 'fail',
        })
      );
    });
  });
});
