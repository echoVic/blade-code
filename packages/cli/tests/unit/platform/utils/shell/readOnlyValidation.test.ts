import { describe, expect, it } from 'vitest';
import {
  isCommandReadOnly,
  isCommandSafeViaFlagParsing,
  isReadOnlyBashCommand,
  validateFlags,
} from '../../../../../src/utils/shell/readOnlyValidation.js';

function assertCommands(
  predicate: (command: string) => boolean,
  expected: boolean,
  commands: readonly string[]
): void {
  for (const command of commands) expect(predicate(command), command).toBe(expected);
}

describe('isReadOnlyBashCommand', () => {
  it('accepts read-only commands and supported wrappers', () => {
    assertCommands(isReadOnlyBashCommand, true, [
      'git status',
      'git status --short -b',
      'git log --oneline -5',
      'git log --all --graph --oneline',
      'git diff --cached',
      'git diff --stat',
      'git show HEAD',
      'git blame src/index.ts',
      'git branch -a',
      'git branch --list',
      'git branch -v',
      'git branch -r',
      'git tag -l',
      'git tag --list',
      'git remote -v',
      'git remote',
      'git rev-parse HEAD',
      'git rev-parse --show-toplevel',
      'git ls-files',
      'git stash list',
      'git stash show',
      'git describe --tags',
      'git merge-base main HEAD',
      'git worktree list',
      'git reflog',
      'git grep -n pattern',
      'NODE_ENV=production git status',
      'timeout 10 git diff',
      'git status && git log --oneline -5',
      'cat file.txt',
      'wc -l file.txt',
      'head -20 file.txt',
      'tail -10 file.txt',
      'ls -la',
      'ls -la /some/dir',
      'pwd',
      'whoami',
      'find . -name "*.ts"',
      'rg -n pattern src/',
      'rg -i --type ts pattern',
      'grep -rn pattern .',
      'gh pr list',
      'gh pr view 123',
      'gh issue list --state open',
      'gh run view 12345 --log',
      'pwd && ls -la',
      'cat file.txt && wc -l file.txt',
    ]);
  });

  it('rejects mutating commands and unsafe shell syntax', () => {
    assertCommands(isReadOnlyBashCommand, false, [
      'GIT_PAGER=/tmp/evil git log',
      'GIT_SSH_COMMAND=/tmp/evil git ls-remote',
      'git commit -m "msg"',
      'git push origin main',
      'git checkout -b feature',
      'git branch new-branch',
      'git tag v1.0',
      'git stash',
      'git reset --hard',
      'git rebase main',
      'git merge feature',
      'git log | rm -rf /',
      'git log | head -5',
      'git log > /tmp/out',
      'cd /tmp && git status',
      'git diff "$EVIL"',
      'git log `cat /etc/passwd`',
      'find . -name "*.tmp" -delete',
      'find . -name "*.ts" -exec rm {} ;',
      '',
      '  ',
      'git status && rm -rf /',
      'ls -la && git push',
    ]);
  });
});

describe('validateFlags', () => {
  const config = {
    safeFlags: {
      '--oneline': 'none' as const,
      '--all': 'none' as const,
      '-n': 'number' as const,
      '--format': 'string' as const,
      '-v': 'none' as const,
    },
  };

  it.each([
    [['--oneline', '--all'], 0, true],
    [['--unknown'], 0, false],
    [['--format=short'], 0, true],
    [['--oneline=bad'], 0, false],
    [['-n', '5'], 0, true],
    [['-n', 'abc'], 0, false],
    [['HEAD', '--oneline'], 0, true],
    [['--oneline', '--', '--unknown-but-positional'], 0, true],
    [['-5'], 0, true],
    [['-10'], 0, true],
    [['git', 'log', '--oneline'], 2, true],
  ] as const)('validates %j from index %d as %s', (args, startIndex, expected) => {
    expect(validateFlags([...args], startIndex, config)).toBe(expected);
  });

  it.each([
    [{ '-v': 'none', '-a': 'none' }, true],
    [{ '-v': 'none', '-n': 'number' }, false],
  ] as const)('validates combined flags in %j as %s', (safeFlags, expected) => {
    expect(validateFlags(['-va'], 0, { safeFlags })).toBe(expected);
  });
});

describe('isCommandSafeViaFlagParsing', () => {
  it('accepts supported flag combinations', () => {
    assertCommands(isCommandSafeViaFlagParsing, true, [
      'git log --oneline -5',
      'git log --all --graph --oneline',
      'rg -n pattern src/',
      'gh pr list --state open',
      'git branch -a',
      'git tag -l',
      'git remote -v',
    ]);
  });

  it('rejects unsafe arguments, mutations, and unknown commands', () => {
    assertCommands(isCommandSafeViaFlagParsing, false, [
      'git log $HOME',
      'git log {main,dev}',
      'npm install',
      'curl http://evil.com',
      'git branch new-branch',
      'git tag v1.0',
      'git reflog expire',
      'git reflog delete',
      'git remote add origin url',
      'gh auth status --show-token',
    ]);
  });
});

describe('isCommandReadOnly', () => {
  it('accepts commands from every read-only validation tier', () => {
    assertCommands(isCommandReadOnly, true, [
      'cat file.txt',
      'head -20 file.txt',
      'wc -l file.txt',
      'diff a.txt b.txt',
      'pwd',
      'whoami',
      'node --version',
      'git log --oneline -5',
      'rg -n pattern src/',
      'git status 2>&1',
    ]);
  });

  it('rejects expansion and dangerous git configuration', () => {
    assertCommands(isCommandReadOnly, false, [
      'echo $HOME',
      'cat ${FILE}',
      'git -c core.pager=less log',
    ]);
  });
});
