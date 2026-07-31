import { describe, expect, it } from 'vitest';
import {
  containsUnsafePatterns,
  normalizeGitCommand,
  splitCompoundCommand,
  stripAllEnvVars,
  stripSafeEnvVars,
  stripSafeWrappers,
  tokenize,
} from '../../../../../src/utils/shell/commandNormalizer.js';

// ============================================================
// stripSafeEnvVars
// ============================================================

describe('stripSafeEnvVars', () => {
  it('strips safe env vars', () => {
    expect(stripSafeEnvVars('NODE_ENV=production git log')).toBe('git log');
    expect(stripSafeEnvVars('RUST_LOG=debug cargo test')).toBe('cargo test');
  });

  it('strips multiple safe env vars', () => {
    expect(stripSafeEnvVars('NODE_ENV=production RUST_LOG=info git log')).toBe(
      'git log'
    );
  });

  it('does NOT strip unsafe env vars', () => {
    expect(stripSafeEnvVars('EVIL_VAR=x git log')).toBe('EVIL_VAR=x git log');
    expect(stripSafeEnvVars('CUSTOM=y git log')).toBe('CUSTOM=y git log');
  });

  it('does NOT strip binary hijack vars', () => {
    expect(stripSafeEnvVars('PATH=/evil git log')).toBe('PATH=/evil git log');
    expect(stripSafeEnvVars('LD_PRELOAD=evil.so git log')).toBe(
      'LD_PRELOAD=evil.so git log'
    );
  });

  it('does NOT strip executable Git env vars (they run external binaries)', () => {
    expect(stripSafeEnvVars('GIT_PAGER=/tmp/evil git log')).toBe(
      'GIT_PAGER=/tmp/evil git log'
    );
    expect(stripSafeEnvVars('GIT_SSH_COMMAND=/tmp/evil git ls-remote')).toBe(
      'GIT_SSH_COMMAND=/tmp/evil git ls-remote'
    );
  });

  it('returns command unchanged if no env vars', () => {
    expect(stripSafeEnvVars('git log --oneline')).toBe('git log --oneline');
  });

  it('rejects env vars with shell metacharacters in value', () => {
    // Values with $ should not match ENV_VAR_PATTERN
    expect(stripSafeEnvVars('NODE_ENV=$HOME git log')).toBe('NODE_ENV=$HOME git log');
  });
});

// ============================================================
// stripAllEnvVars
// ============================================================

describe('stripAllEnvVars', () => {
  it('strips all env vars aggressively', () => {
    expect(stripAllEnvVars('EVIL_VAR=x git push')).toBe('git push');
    expect(stripAllEnvVars('CUSTOM=y FOO=bar git log')).toBe('git log');
  });

  it('does NOT strip binary hijack vars', () => {
    expect(stripAllEnvVars('PATH=/evil git log')).toBe('PATH=/evil git log');
    expect(stripAllEnvVars('LD_PRELOAD=evil.so rm -rf /')).toBe(
      'LD_PRELOAD=evil.so rm -rf /'
    );
    expect(stripAllEnvVars('DYLD_LIBRARY_PATH=/bad git log')).toBe(
      'DYLD_LIBRARY_PATH=/bad git log'
    );
  });

  it('strips non-hijack vars but stops at hijack vars', () => {
    expect(stripAllEnvVars('FOO=bar PATH=/evil git log')).toBe('PATH=/evil git log');
  });
});

// ============================================================
// stripSafeWrappers
// ============================================================

describe('stripSafeWrappers', () => {
  it('strips timeout', () => {
    expect(stripSafeWrappers('timeout 30 git log')).toBe('git log');
    expect(stripSafeWrappers('timeout --foreground 60 git diff')).toBe('git diff');
  });

  it('strips time', () => {
    expect(stripSafeWrappers('time git status')).toBe('git status');
  });

  it('strips nice', () => {
    expect(stripSafeWrappers('nice -n 10 git status')).toBe('git status');
    expect(stripSafeWrappers('nice git log')).toBe('git log');
  });

  it('strips nohup', () => {
    expect(stripSafeWrappers('nohup git log')).toBe('git log');
  });

  it('strips nested wrappers', () => {
    expect(stripSafeWrappers('time nice -n 5 git log')).toBe('git log');
  });

  it('strips -- (end of options)', () => {
    expect(stripSafeWrappers('-- git log')).toBe('git log');
  });

  it('returns command unchanged if no wrappers', () => {
    expect(stripSafeWrappers('git log --oneline')).toBe('git log --oneline');
  });
});

// ============================================================
// splitCompoundCommand
// ============================================================

describe('splitCompoundCommand', () => {
  it('splits on &&', () => {
    expect(splitCompoundCommand('git status && git log')).toEqual([
      'git status',
      'git log',
    ]);
  });

  it('splits on ||', () => {
    expect(splitCompoundCommand('git status || echo failed')).toEqual([
      'git status',
      'echo failed',
    ]);
  });

  it('splits on ;', () => {
    expect(splitCompoundCommand('git status; git log')).toEqual([
      'git status',
      'git log',
    ]);
  });

  it('returns null for pipe', () => {
    expect(splitCompoundCommand('git log | head')).toBeNull();
  });

  it('returns null for redirect', () => {
    expect(splitCompoundCommand('git log > out.txt')).toBeNull();
    expect(splitCompoundCommand('git log < in.txt')).toBeNull();
  });

  it('returns null for background &', () => {
    expect(splitCompoundCommand('sleep 10 &')).toBeNull();
  });

  it('does not split inside quotes', () => {
    expect(splitCompoundCommand('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(splitCompoundCommand("echo 'a || b'")).toEqual(["echo 'a || b'"]);
  });

  it('handles mixed separators', () => {
    expect(splitCompoundCommand('a && b; c || d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns single command as array', () => {
    expect(splitCompoundCommand('git status')).toEqual(['git status']);
  });
});

// ============================================================
// containsUnsafePatterns
// ============================================================

describe('containsUnsafePatterns', () => {
  it('detects pipe', () => {
    expect(containsUnsafePatterns('git log | head')).toBe(true);
  });

  it('detects redirect', () => {
    expect(containsUnsafePatterns('git log > out.txt')).toBe(true);
    expect(containsUnsafePatterns('git log < in.txt')).toBe(true);
  });

  it('detects $variable', () => {
    expect(containsUnsafePatterns('echo $HOME')).toBe(true);
    expect(containsUnsafePatterns('echo ${PATH}')).toBe(true);
  });

  it('detects subshell', () => {
    expect(containsUnsafePatterns('echo $(whoami)')).toBe(true);
    expect(containsUnsafePatterns('echo `whoami`')).toBe(true);
  });

  it('detects brace expansion', () => {
    expect(containsUnsafePatterns('echo {a,b}')).toBe(true);
    expect(containsUnsafePatterns('echo {1..5}')).toBe(true);
  });

  it('ignores patterns inside single quotes', () => {
    expect(containsUnsafePatterns("echo '$HOME'")).toBe(false);
    expect(containsUnsafePatterns("echo '| grep'")).toBe(false);
  });

  it('detects $ inside double quotes', () => {
    expect(containsUnsafePatterns('echo "$HOME"')).toBe(true);
  });

  it('returns false for safe commands', () => {
    expect(containsUnsafePatterns('git log --oneline -5')).toBe(false);
    expect(containsUnsafePatterns('ls -la')).toBe(false);
  });
});

// ============================================================
// normalizeGitCommand
// ============================================================

describe('normalizeGitCommand', () => {
  it('strips -C <path>', () => {
    const result = normalizeGitCommand('git -C /path/to/repo log --oneline');
    expect(result).toEqual({ subcommand: 'log', args: ['--oneline'] });
  });

  it('strips --no-pager', () => {
    const result = normalizeGitCommand('git --no-pager diff');
    expect(result).toEqual({ subcommand: 'diff', args: [] });
  });

  it('strips multiple safe options', () => {
    const result = normalizeGitCommand(
      'git -C /path --no-pager --no-optional-locks log --oneline'
    );
    expect(result).toEqual({ subcommand: 'log', args: ['--oneline'] });
  });

  it('returns null for -c (config)', () => {
    expect(normalizeGitCommand('git -c core.pager=less log')).toBeNull();
  });

  it('returns null for --exec-path', () => {
    expect(normalizeGitCommand('git --exec-path=/evil log')).toBeNull();
  });

  it('returns null for --git-dir', () => {
    expect(normalizeGitCommand('git --git-dir=/evil log')).toBeNull();
  });

  it('returns null for non-git command', () => {
    expect(normalizeGitCommand('ls -la')).toBeNull();
  });

  it('returns null for git with no subcommand', () => {
    expect(normalizeGitCommand('git')).toBeNull();
  });

  it('handles -C=/path form', () => {
    const result = normalizeGitCommand('git -C=/some/path status');
    expect(result).toEqual({ subcommand: 'status', args: [] });
  });
});

// ============================================================
// tokenize
// ============================================================

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('git log --oneline')).toEqual(['git', 'log', '--oneline']);
  });

  it('handles single quotes', () => {
    expect(tokenize("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('handles double quotes', () => {
    expect(tokenize('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('handles escaped characters', () => {
    expect(tokenize('echo hello\\ world')).toEqual(['echo', 'hello world']);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles mixed quotes', () => {
    expect(tokenize('git commit -m "fix: don\'t break"')).toEqual([
      'git',
      'commit',
      '-m',
      "fix: don't break",
    ]);
  });
});
