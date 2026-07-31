/**
 * Read-Only Command Validation
 *
 * Three-tier validation for determining if a Bash command is read-only:
 * 1. Simple regex matching (cat, head, wc, etc.)
 * 2. Custom regex matching (echo, pwd, find, ls, cd, etc.)
 * 3. Flag-level whitelist validation (git, gh, docker, rg, etc.)
 *
 * Ref: Claude Code's readOnlyCommandValidation.ts + BashTool/readOnlyValidation.ts
 */

import {
  splitCompoundCommand,
  stripSafeEnvVars,
  stripSafeWrappers,
  tokenize,
} from './commandNormalizer.js';

// ============================================================
// Type definitions
// ============================================================

export type FlagArgType = 'none' | 'number' | 'string';

export interface CommandConfig {
  safeFlags: Record<string, FlagArgType>;
  /** Return true if the command is dangerous given these args */
  isDangerousCallback?: (rawCommand: string, args: string[]) => boolean;
  /** Optional regex for additional validation */
  regex?: RegExp;
  /** Whether -- stops flag parsing (default: true) */
  respectsDoubleDash?: boolean;
}

// ============================================================
// Shared flag groups (DRY helpers for git commands)
// ============================================================

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
};

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
};

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
};

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
};

const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
};

const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
};

const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
};

const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
};

const GIT_FORMAT_FLAGS: Record<string, FlagArgType> = {
  '--format': 'string',
  '--pretty': 'string',
};

// ============================================================
// GIT_READ_ONLY_COMMANDS (24 subcommands)
// ============================================================

export const GIT_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--cached': 'none',
      '--staged': 'none',
      '--no-index': 'none',
      '--diff-filter': 'string',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '-U': 'number',
      '--unified': 'number',
      '--compact-summary': 'none',
      '--ignore-space-change': 'none',
      '-b': 'none',
      '--ignore-all-space': 'none',
      '-w': 'none',
      '--ignore-blank-lines': 'none',
      '--src-prefix': 'string',
      '--dst-prefix': 'string',
      '--no-prefix': 'none',
      '-R': 'none',
      '--relative': 'none',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--check': 'none',
      '--ext-diff': 'none',
      '--binary': 'none',
      '--abbrev': 'none',
      '--full-index': 'none',
      '--break-rewrites': 'none',
      '-B': 'none',
      '--find-renames': 'none',
      '-M': 'none',
      '--find-copies': 'none',
      '-C': 'none',
      '--diff-algorithm': 'string',
    },
  },

  'git log': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      ...GIT_FORMAT_FLAGS,
      '--follow': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--ancestry-path': 'none',
      '--simplify-by-decoration': 'none',
      '--abbrev-commit': 'none',
      '--no-abbrev-commit': 'none',
      '--abbrev': 'number',
      '--topo-order': 'none',
      '--diff-filter': 'string',
      '--skip': 'number',
      '--left-right': 'none',
      '--cherry-pick': 'none',
      '--cherry-mark': 'none',
      '--cherry': 'none',
      '--walk-reflogs': 'none',
      '-g': 'none',
      '--boundary': 'none',
      '--source': 'none',
    },
  },

  'git show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_FORMAT_FLAGS,
      '--abbrev-commit': 'none',
      '--no-abbrev-commit': 'none',
      '--abbrev': 'number',
      '-U': 'number',
      '--unified': 'number',
      '--diff-filter': 'string',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--compact-summary': 'none',
    },
  },

  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '-s': 'none',
      '--summary': 'none',
      '-n': 'number',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '--group': 'string',
      '--format': 'string',
    },
  },

  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_FORMAT_FLAGS,
      '--date': 'string',
    },
    isDangerousCallback: (_raw, args) => {
      // reflog expire, delete, exists are dangerous
      const dangerousSubs = new Set(['expire', 'delete', 'exists']);
      for (const arg of args) {
        if (dangerousSubs.has(arg)) return true;
      }
      return false;
    },
  },

  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_FORMAT_FLAGS,
    },
  },

  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '-U': 'number',
      '--unified': 'number',
      '--include-untracked': 'none',
      '-u': 'none',
    },
  },

  'git ls-remote': {
    safeFlags: {
      '--heads': 'none',
      '--tags': 'none',
      '--refs': 'none',
      '--quiet': 'none',
      '-q': 'none',
      '--get-url': 'none',
      '--sort': 'string',
      '--symref': 'none',
    },
  },

  'git status': {
    safeFlags: {
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      '--untracked-files': 'none',
      '-u': 'none',
      '--ignored': 'none',
      '--ignore-submodules': 'none',
      '--column': 'none',
      '--no-column': 'none',
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      '--renames': 'none',
      '--no-renames': 'none',
      '--show-stash': 'none',
    },
  },

  'git blame': {
    safeFlags: {
      '-L': 'string',
      '--line-porcelain': 'none',
      '--porcelain': 'none',
      '-p': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-w': 'none',
      '-M': 'none',
      '-C': 'none',
      '--date': 'string',
      '--color-lines': 'none',
      '--color-by-age': 'none',
      '--abbrev': 'number',
      '-s': 'none',
      '--score-debug': 'none',
      '--first-parent': 'none',
      '--root': 'none',
      '--since': 'string',
    },
  },

  'git ls-files': {
    safeFlags: {
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      '--error-unmatch': 'none',
      '--full-name': 'none',
      '--recurse-submodules': 'none',
      '-z': 'none',
      '--eol': 'none',
      '--deduplicate': 'none',
    },
  },

  'git config --get': {
    safeFlags: {
      '--global': 'none',
      '--system': 'none',
      '--local': 'none',
      '--worktree': 'none',
      '--get-regexp': 'none',
      '--list': 'none',
      '-l': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--type': 'string',
      '--default': 'string',
    },
  },

  'git remote show': {
    safeFlags: {
      '-n': 'none',
    },
    isDangerousCallback: (_raw, args) => {
      // Must have exactly one alphanumeric remote name
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      if (nonFlags.length !== 1) return true;
      return !/^[a-zA-Z0-9_.-]+$/.test(nonFlags[0]);
    },
  },

  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    isDangerousCallback: (_raw, args) => {
      // Only bare `git remote` or `git remote -v` is safe
      // Any positional arg (add/remove/rename/set-url) is dangerous
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      return nonFlags.length > 0;
    },
  },

  'git merge-base': {
    safeFlags: {
      '--all': 'none',
      '--octopus': 'none',
      '--is-ancestor': 'none',
      '--independent': 'none',
      '--fork-point': 'none',
    },
  },

  'git rev-parse': {
    safeFlags: {
      '--verify': 'none',
      '--quiet': 'none',
      '-q': 'none',
      '--short': 'none',
      '--symbolic': 'none',
      '--symbolic-full-name': 'none',
      '--abbrev-ref': 'none',
      '--show-toplevel': 'none',
      '--show-cdup': 'none',
      '--show-prefix': 'none',
      '--show-superproject-working-tree': 'none',
      '--git-dir': 'none',
      '--git-common-dir': 'none',
      '--git-path': 'string',
      '--is-inside-git-dir': 'none',
      '--is-inside-work-tree': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--absolute-git-dir': 'none',
      '--resolve-git-dir': 'string',
      '--all': 'none',
      '--branches': 'none',
      '--tags': 'none',
      '--remotes': 'none',
      '--glob': 'string',
      '--exclude': 'string',
    },
  },

  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      '--count': 'none',
      '--objects': 'none',
      '--no-walk': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--ancestry-path': 'none',
      '--topo-order': 'none',
      '--left-right': 'none',
      '--cherry-pick': 'none',
      '--cherry-mark': 'none',
      '--cherry': 'none',
      '--boundary': 'none',
      '--abbrev-commit': 'none',
      '--abbrev': 'number',
      '--header': 'none',
      '--skip': 'number',
    },
  },

  'git describe': {
    safeFlags: {
      '--all': 'none',
      '--tags': 'none',
      '--contains': 'none',
      '--abbrev': 'number',
      '--long': 'none',
      '--first-parent': 'none',
      '--always': 'none',
      '--match': 'string',
      '--exclude': 'string',
      '--exact-match': 'none',
      '--dirty': 'none',
      '--broken': 'none',
      '--candidates': 'number',
      '--debug': 'none',
    },
  },

  'git cat-file': {
    safeFlags: {
      '-t': 'none',
      '-s': 'none',
      '-e': 'none',
      '-p': 'none',
      '--batch': 'none',
      '--batch-check': 'none',
      '--batch-all-objects': 'none',
      '--textconv': 'none',
      '--filters': 'none',
      '--allow-unknown-type': 'none',
      '--buffer': 'none',
      '--unordered': 'none',
    },
  },

  'git for-each-ref': {
    safeFlags: {
      '--format': 'string',
      '--sort': 'string',
      '--count': 'number',
      '--shell': 'none',
      '--perl': 'none',
      '--python': 'none',
      '--tcl': 'none',
      '--points-at': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--contains': 'string',
      '--no-contains': 'string',
    },
  },

  'git grep': {
    safeFlags: {
      '-i': 'none',
      '--ignore-case': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '--name-only': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-e': 'string',
      '-f': 'string',
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      '--all-match': 'none',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '--cached': 'none',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--max-depth': 'number',
      '-h': 'none',
      '--no-filename': 'none',
      '-H': 'none',
      '--full-name': 'none',
      '-z': 'none',
      '--break': 'none',
      '--heading': 'none',
      '-p': 'none',
      '--show-function': 'none',
      '-W': 'none',
      '--function-context': 'none',
      '--threads': 'number',
      '-O': 'string',
      '--open-files-in-pager': 'none',
      '-A': 'number',
      '-B': 'number',
      '-C': 'number',
      '--context': 'number',
    },
  },

  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
      '-z': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--expire': 'string',
    },
  },

  'git tag': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--sort': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--points-at': 'string',
      '--format': 'string',
      '--color': 'none',
      '--no-color': 'none',
    },
    isDangerousCallback: (_raw, args) => {
      // Safe only with -l/--list flag or no positional args
      const hasListFlag = args.some((a) => a === '-l' || a === '--list');
      if (hasListFlag) return false;
      // Without --list, any positional arg = creating a tag
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      return nonFlags.length > 0;
    },
  },

  'git branch': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '-vv': 'none',
      '--sort': 'string',
      '--format': 'string',
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--points-at': 'string',
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      '--show-current': 'none',
    },
    isDangerousCallback: (_raw, args) => {
      // Safe with --list, -a, -r, --show-current, or bare git branch
      const listFlags = new Set([
        '-l',
        '--list',
        '-a',
        '--all',
        '-r',
        '--remotes',
        '--show-current',
      ]);
      const hasListFlag = args.some((a) => listFlags.has(a));
      if (hasListFlag) return false;
      // Dangerous flags: -d, -D, -m, -M, -c, --copy, --delete, --move, --set-upstream-to, --unset-upstream
      const dangerousFlags = new Set([
        '-d',
        '-D',
        '-m',
        '-M',
        '-c',
        '--copy',
        '--delete',
        '--move',
        '--set-upstream-to',
        '--unset-upstream',
        '--edit-description',
      ]);
      if (args.some((a) => dangerousFlags.has(a.split('=')[0]))) return true;
      // Without list flag, any positional arg = creating a branch
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      return nonFlags.length > 0;
    },
  },
};

// ============================================================
// GH_READ_ONLY_COMMANDS
// ============================================================

/**
 * Callback for gh commands: reject tokens with ://, @, or 2+ slashes
 * Prevents HOST/OWNER/REPO exfiltration
 */
function ghIsDangerousCallback(_raw: string, args: string[]): boolean {
  for (const arg of args) {
    if (arg.includes('://') || arg.includes('@')) return true;
    // Count slashes — 2+ means HOST/OWNER/REPO
    const slashCount = (arg.match(/\//g) || []).length;
    if (slashCount >= 2) return true;
  }
  return false;
}

const GH_COMMON_FLAGS: Record<string, FlagArgType> = {
  '--json': 'string',
  '--jq': 'string',
  '--template': 'string',
  '-q': 'none',
  '--limit': 'number',
  '-L': 'number',
  '--web': 'none',
  '-w': 'none',
  '--comments': 'none',
};

export const GH_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  'gh pr view': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr list': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--state': 'string',
      '-s': 'string',
      '--author': 'string',
      '--label': 'string',
      '--base': 'string',
      '--head': 'string',
      '--search': 'string',
      '--assignee': 'string',
      '--draft': 'none',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr diff': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--color': 'string',
      '--patch': 'none',
      '--name-only': 'none',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr checks': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--watch': 'none',
      '--fail-fast': 'none',
      '--required': 'none',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr status': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue view': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue list': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--state': 'string',
      '-s': 'string',
      '--author': 'string',
      '--label': 'string',
      '--search': 'string',
      '--assignee': 'string',
      '--milestone': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue status': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh repo view': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh run list': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--workflow': 'string',
      '-w': 'string',
      '--branch': 'string',
      '-b': 'string',
      '--status': 'string',
      '-s': 'string',
      '--user': 'string',
      '-u': 'string',
      '--event': 'string',
      '-e': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh run view': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--log': 'none',
      '--log-failed': 'none',
      '--exit-status': 'none',
      '--verbose': 'none',
      '-v': 'none',
      '--job': 'string',
      '-j': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh auth status': {
    safeFlags: { '--hostname': 'string', '-h': 'string', '--active': 'none' },
    isDangerousCallback: (_raw, args) => {
      // Block --show-token / -t (leaks credentials)
      return args.some((a) => a === '--show-token' || a === '-t');
    },
  },
  'gh release list': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--exclude-drafts': 'none',
      '--exclude-pre-releases': 'none',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh release view': {
    safeFlags: { ...GH_COMMON_FLAGS },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh workflow list': {
    safeFlags: { ...GH_COMMON_FLAGS, '--all': 'none', '-a': 'none' },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh workflow view': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--yaml': 'none',
      '-y': 'none',
      '--ref': 'string',
      '-r': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh label list': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--search': 'string',
      '--sort': 'string',
      '--order': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search repos': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--language': 'string',
      '--topic': 'string',
      '--sort': 'string',
      '--order': 'string',
      '--match': 'string',
      '--owner': 'string',
      '--visibility': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search issues': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--sort': 'string',
      '--order': 'string',
      '--match': 'string',
      '--state': 'string',
      '--label': 'string',
      '--language': 'string',
      '--author': 'string',
      '--assignee': 'string',
      '--repo': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search prs': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--sort': 'string',
      '--order': 'string',
      '--match': 'string',
      '--state': 'string',
      '--label': 'string',
      '--language': 'string',
      '--author': 'string',
      '--assignee': 'string',
      '--repo': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search commits': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--sort': 'string',
      '--order': 'string',
      '--author': 'string',
      '--committer': 'string',
      '--repo': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search code': {
    safeFlags: {
      ...GH_COMMON_FLAGS,
      '--language': 'string',
      '--filename': 'string',
      '--extension': 'string',
      '--repo': 'string',
      '--match': 'string',
    },
    isDangerousCallback: ghIsDangerousCallback,
  },
};

// ============================================================
// DOCKER & RIPGREP READ_ONLY_COMMANDS
// ============================================================

export const DOCKER_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  'docker logs': {
    safeFlags: {
      '--follow': 'none',
      '-f': 'none',
      '--tail': 'number',
      '-n': 'number',
      '--timestamps': 'none',
      '-t': 'none',
      '--since': 'string',
      '--until': 'string',
      '--details': 'none',
    },
  },
  'docker inspect': {
    safeFlags: {
      '--format': 'string',
      '-f': 'string',
      '--type': 'string',
      '--size': 'none',
      '-s': 'none',
    },
  },
};

export const RIPGREP_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  rg: {
    safeFlags: {
      // Pattern flags
      '-e': 'string',
      '--regexp': 'string',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-S': 'none',
      '--smart-case': 'none',
      '-s': 'none',
      '--case-sensitive': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-P': 'none',
      '--pcre2': 'none',
      '--engine': 'string',
      // Search options
      '-m': 'number',
      '--max-count': 'number',
      '--max-depth': 'number',
      '--maxdepth': 'number',
      '-d': 'number',
      '--max-filesize': 'string',
      '--mmap': 'none',
      '--no-mmap': 'none',
      '-U': 'none',
      '--multiline': 'none',
      '--multiline-dotall': 'none',
      '--crlf': 'none',
      '--no-crlf': 'none',
      // Output options
      '-c': 'none',
      '--count': 'none',
      '--count-matches': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '--files-without-match': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '--vimgrep': 'none',
      '-r': 'string',
      '--replace': 'string',
      // File filtering
      '-t': 'string',
      '--type': 'string',
      '-T': 'string',
      '--type-not': 'string',
      '-g': 'string',
      '--glob': 'string',
      '--iglob': 'string',
      '--type-add': 'string',
      '--type-clear': 'string',
      // Display
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--color': 'string',
      '--colors': 'string',
      '-n': 'none',
      '--line-number': 'none',
      '-N': 'none',
      '--no-line-number': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '--no-filename': 'none',
      '-p': 'none',
      '--pretty': 'none',
      '--heading': 'none',
      '--no-heading': 'none',
      '--column': 'none',
      '--no-column': 'none',
      '--byte-offset': 'none',
      '--trim': 'none',
      // Misc
      '-j': 'number',
      '--threads': 'number',
      '--sort': 'string',
      '--sortr': 'string',
      '--stats': 'none',
      '--no-ignore': 'none',
      '--no-ignore-vcs': 'none',
      '--no-ignore-parent': 'none',
      '--no-ignore-global': 'none',
      '--hidden': 'none',
      '--no-hidden': 'none',
      '-L': 'none',
      '--follow': 'none',
      '--one-file-system': 'none',
      '--null': 'none',
      '-0': 'none',
      '--path-separator': 'string',
      '--no-config': 'none',
      '--no-ignore-dot': 'none',
      '--no-ignore-exclude': 'none',
      '--no-unicode': 'none',
      '--pcre2-version': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--help': 'none',
      '-h': 'none',
      '--version': 'none',
      '-V': 'none',
      '--': 'none',
      '--json': 'none',
      '--auto-hybrid-regex': 'none',
      '--binary': 'none',
      '--block-buffered': 'none',
      '--line-buffered': 'none',
      '--debug': 'none',
      '--dfa-size-limit': 'string',
      '--encoding': 'string',
      '-E': 'string',
      '--no-messages': 'none',
      '--regex-size-limit': 'string',
      '--search-zip': 'none',
      '-z': 'none',
      '--type-list': 'none',
      '--unrestricted': 'none',
      '-u': 'none',
    },
  },
};

// ============================================================
// Combined COMMAND_ALLOWLIST
// ============================================================

/** All flag-validated read-only commands */
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  ...GIT_READ_ONLY_COMMANDS,
  ...GH_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
  ...RIPGREP_READ_ONLY_COMMANDS,

  // Additional safe commands with flag validation
  file: {
    safeFlags: {
      '-b': 'none',
      '--brief': 'none',
      '-i': 'none',
      '--mime': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '-L': 'none',
      '-h': 'none',
      '--no-dereference': 'none',
      '-z': 'none',
    },
  },
  sort: {
    safeFlags: {
      '-r': 'none',
      '--reverse': 'none',
      '-n': 'none',
      '--numeric-sort': 'none',
      '-u': 'none',
      '--unique': 'none',
      '-k': 'string',
      '--key': 'string',
      '-t': 'string',
      '--field-separator': 'string',
      '-f': 'none',
      '--ignore-case': 'none',
      '-s': 'none',
      '--stable': 'none',
      '-h': 'none',
      '--human-numeric-sort': 'none',
      '-V': 'none',
      '--version-sort': 'none',
      '-g': 'none',
      '--general-numeric-sort': 'none',
      '-M': 'none',
      '--month-sort': 'none',
    },
  },
  grep: {
    safeFlags: {
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-H': 'none',
      '--with-filename': 'none',
      '-h': 'none',
      '--no-filename': 'none',
      '-r': 'none',
      '-R': 'none',
      '--recursive': 'none',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-x': 'none',
      '--line-regexp': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-m': 'number',
      '--max-count': 'number',
      '--color': 'string',
      '--colour': 'string',
      '-e': 'string',
      '--regexp': 'string',
      '--include': 'string',
      '--exclude': 'string',
      '--exclude-dir': 'string',
      '-o': 'none',
      '--only-matching': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none',
      '--no-messages': 'none',
      '-Z': 'none',
      '--null': 'none',
    },
  },
  tree: {
    safeFlags: {
      '-L': 'number',
      '-d': 'none',
      '-a': 'none',
      '-f': 'none',
      '-i': 'none',
      '-l': 'none',
      '-s': 'none',
      '-h': 'none',
      '-p': 'none',
      '-u': 'none',
      '-g': 'none',
      '-D': 'none',
      '-r': 'none',
      '-t': 'none',
      '--noreport': 'none',
      '--dirsfirst': 'none',
      '-C': 'none',
      '--color': 'none',
      '-n': 'none',
      '-I': 'string',
      '-P': 'string',
      '--charset': 'string',
      '-o': 'string',
      '--prune': 'none',
      '-J': 'none',
      '-X': 'none',
      '-H': 'string',
    },
  },
  date: {
    safeFlags: {
      '-u': 'none',
      '--utc': 'none',
      '-d': 'string',
      '--date': 'string',
      '-I': 'none',
      '--iso-8601': 'none',
      '-R': 'none',
      '--rfc-2822': 'none',
      '--rfc-3339': 'string',
    },
  },
  ps: {
    safeFlags: {
      '-e': 'none',
      '-f': 'none',
      '-l': 'none',
      '-a': 'none',
      '-u': 'none',
      '-x': 'none',
      '-o': 'string',
      '--sort': 'string',
      '-p': 'string',
      '--pid': 'string',
      '-C': 'string',
      '--forest': 'none',
      '-H': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-w': 'none',
      '--width': 'number',
    },
  },
  lsof: {
    safeFlags: {
      '-i': 'string',
      '-p': 'string',
      '-n': 'none',
      '-P': 'none',
      '-t': 'none',
      '-c': 'string',
      '-u': 'string',
      '-d': 'string',
      '-a': 'none',
    },
  },
  netstat: {
    safeFlags: {
      '-t': 'none',
      '-u': 'none',
      '-l': 'none',
      '-n': 'none',
      '-p': 'none',
      '-a': 'none',
      '-r': 'none',
      '-s': 'none',
      '-e': 'none',
      '-o': 'none',
      '-i': 'none',
    },
  },
  man: {
    safeFlags: {
      '-k': 'string',
      '--apropos': 'string',
      '-f': 'string',
      '--whatis': 'string',
    },
  },
  sed: {
    safeFlags: {
      '-n': 'none',
      '--quiet': 'none',
      '--silent': 'none',
      '-E': 'none',
      '-r': 'none',
      '--regexp-extended': 'none',
      '-e': 'string',
      '--expression': 'string',
    },
    isDangerousCallback: (_raw, args) => {
      // sed is read-only only with -n (suppress output) and p/d/s patterns
      // Reject -i (in-place edit) and w command
      for (const arg of args) {
        if (arg === '-i' || arg.startsWith('-i') || arg === '--in-place') return true;
        // Check for w (write) command in sed expressions
        if (/\bw\s/.test(arg) || /\bw$/.test(arg)) return true;
      }
      return false;
    },
  },
  base64: {
    safeFlags: {
      '-d': 'none',
      '--decode': 'none',
      '-w': 'number',
      '--wrap': 'number',
      '-i': 'none',
      '--ignore-garbage': 'none',
    },
  },
  sha256sum: {
    safeFlags: {
      '-c': 'none',
      '--check': 'none',
      '-b': 'none',
      '--binary': 'none',
      '-t': 'none',
      '--text': 'none',
      '--tag': 'none',
      '--status': 'none',
      '-w': 'none',
      '--warn': 'none',
      '--strict': 'none',
      '--quiet': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      '-c': 'none',
      '--check': 'none',
      '-b': 'none',
      '--binary': 'none',
      '--tag': 'none',
      '--status': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      '-c': 'none',
      '--check': 'none',
      '-b': 'none',
      '--binary': 'none',
      '--tag': 'none',
      '--status': 'none',
    },
  },
  hostname: {
    safeFlags: {
      '-s': 'none',
      '-f': 'none',
      '--fqdn': 'none',
      '-d': 'none',
      '-i': 'none',
      '-I': 'none',
      '-a': 'none',
    },
  },
  pgrep: {
    safeFlags: {
      '-l': 'none',
      '-a': 'none',
      '-f': 'none',
      '-x': 'none',
      '-n': 'none',
      '-o': 'none',
      '-c': 'none',
      '-d': 'string',
      '-u': 'string',
      '-U': 'string',
      '-P': 'string',
      '-G': 'string',
      '-t': 'string',
    },
  },
  ss: {
    safeFlags: {
      '-t': 'none',
      '-u': 'none',
      '-l': 'none',
      '-n': 'none',
      '-p': 'none',
      '-a': 'none',
      '-r': 'none',
      '-s': 'none',
      '-e': 'none',
      '-o': 'none',
      '-i': 'none',
      '-4': 'none',
      '-6': 'none',
      '-m': 'none',
      '-Z': 'none',
      '-K': 'none',
    },
  },
  fd: {
    safeFlags: {
      '-t': 'string',
      '--type': 'string',
      '-e': 'string',
      '--extension': 'string',
      '-E': 'string',
      '--exclude': 'string',
      '-d': 'number',
      '--max-depth': 'number',
      '-H': 'none',
      '--hidden': 'none',
      '-I': 'none',
      '--no-ignore': 'none',
      '-s': 'none',
      '--case-sensitive': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-a': 'none',
      '--absolute-path': 'none',
      '-l': 'none',
      '--list-details': 'none',
      '-L': 'none',
      '--follow': 'none',
      '-p': 'none',
      '--full-path': 'none',
      '-0': 'none',
      '--print0': 'none',
      '-1': 'none',
      '--color': 'string',
      '--glob': 'none',
      '-g': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '--prune': 'none',
      '-u': 'none',
      '--unrestricted': 'none',
      '-S': 'string',
      '--size': 'string',
      '--changed-within': 'string',
      '--changed-before': 'string',
      '-j': 'number',
      '--threads': 'number',
    },
  },
  fdfind: {
    safeFlags: {
      '-t': 'string',
      '--type': 'string',
      '-e': 'string',
      '--extension': 'string',
      '-E': 'string',
      '--exclude': 'string',
      '-d': 'number',
      '--max-depth': 'number',
      '-H': 'none',
      '--hidden': 'none',
      '-I': 'none',
      '--no-ignore': 'none',
      '-s': 'none',
      '--case-sensitive': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-a': 'none',
      '--absolute-path': 'none',
      '-l': 'none',
      '--list-details': 'none',
      '-L': 'none',
      '--follow': 'none',
      '-p': 'none',
      '--full-path': 'none',
      '-0': 'none',
      '--print0': 'none',
      '-1': 'none',
      '--color': 'string',
      '--glob': 'none',
      '-g': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
    },
  },
  tput: { safeFlags: { '-S': 'none' } },
  help: { safeFlags: {} },
  info: { safeFlags: {} },
};

// ============================================================
// Simple readonly command regexes (Tier 1)
// ============================================================

/**
 * Generate regex for a simple safe command.
 * Matches: command [args that don't contain shell metacharacters]
 * Rejects: pipe, redirect, subshell, variable expansion, brace expansion
 */
function makeRegexForSafeCommand(command: string): RegExp {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`);
}

/** Simple commands validated only by regex (no flag parsing needed) */
const SIMPLE_READONLY_COMMANDS = [
  'docker ps',
  'docker images',
  'cal',
  'uptime',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',
  'basename',
  'dirname',
  'realpath',
  'cut',
  'paste',
  'tr',
  'column',
  'tac',
  'rev',
  'fold',
  'expand',
  'unexpand',
  'fmt',
  'comm',
  'cmp',
  'numfmt',
  'readlink',
  'diff',
  'true',
  'false',
  'sleep',
  'which',
  'type',
  'expr',
  'test',
  'getconf',
  'seq',
  'tsort',
  'pr',
];

// ============================================================
// Custom readonly regexes (Tier 2)
// ============================================================

/** Custom regexes for commands that need more nuanced matching */
const CUSTOM_READONLY_REGEXES: RegExp[] = [
  // echo: allow string literals only, no variable expansion
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
  // uniq with safe flags
  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
  // Simple single commands
  /^pwd$/,
  /^whoami$/,
  /^alias$/,
  // Version checks
  /^node\s+(-v|--version)\s*$/,
  /^python\s+--version\s*$/,
  /^python3\s+--version\s*$/,
  /^bun\s+--version\s*$/,
  /^deno\s+--version\s*$/,
  // history
  /^history(?:\s+\d+)?\s*$/,
  // arch
  /^arch(?:\s+(?:--help|-h))?\s*$/,
  // Network info (read-only)
  /^ip\s+addr$/,
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
  // ls: allow flags and paths (no shell metacharacters)
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?\s*$/,
  // cd: allow safe paths only
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // find: allow but exclude -delete, -exec, -execdir, -ok, -okdir, -fprint
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
  // jq: allow but exclude dangerous flags
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
];

/** Build combined set of all regex patterns */
const READONLY_COMMAND_REGEXES: RegExp[] = [
  ...SIMPLE_READONLY_COMMANDS.map(makeRegexForSafeCommand),
  ...CUSTOM_READONLY_REGEXES,
];

// ============================================================
// Flag validation engine
// ============================================================

/**
 * Validate flag argument value against expected type.
 */
function validateFlagArgument(value: string, argType: FlagArgType): boolean {
  switch (argType) {
    case 'none':
      return false; // Should not be called
    case 'number':
      return /^\d+$/.test(value);
    case 'string':
      return true;
  }
}

/**
 * Validate that all flags in a token list are in the whitelist.
 *
 * Handles:
 * - --flag=value (split on =)
 * - -n 5 (flag with next-token argument)
 * - Combined short flags -rn (all must be 'none' type)
 * - Git numeric shorthand -<number>
 * - -- (end of options separator)
 *
 * Returns true if all flags are safe.
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: CommandConfig
): boolean {
  let i = startIndex;
  const respectsDoubleDash = config.respectsDoubleDash !== false;

  while (i < tokens.length) {
    const token = tokens[i];

    // -- separator: everything after is positional
    if (token === '--' && respectsDoubleDash) {
      break;
    }

    // Not a flag: skip positional args
    if (!token.startsWith('-')) {
      i++;
      continue;
    }

    // Long flag: --flag or --flag=value
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      const hasEquals = eqIdx !== -1;
      const flagName = hasEquals ? token.substring(0, eqIdx) : token;
      const flagType = config.safeFlags[flagName];

      if (flagType === undefined) return false; // Unknown flag

      if (flagType === 'none') {
        if (hasEquals) return false; // none-type flag shouldn't have =value
        i++;
        continue;
      }

      // Flag expects an argument
      if (hasEquals) {
        const value = token.substring(eqIdx + 1);
        if (!validateFlagArgument(value, flagType)) return false;
        i++;
      } else {
        // Next token is the argument
        i++;
        if (i >= tokens.length) return false; // Missing argument
        const value = tokens[i];
        // Reject string-type values that look like flags (prevents misparse)
        if (flagType === 'string' && value.startsWith('-')) {
          // Exception: git --sort with reverse sorting (-key)
          if (flagName !== '--sort') return false;
        }
        if (!validateFlagArgument(value, flagType)) return false;
        i++;
      }
      continue;
    }

    // Short flag
    const flag = token;

    // Git numeric shorthand: -5, -10, etc.
    if (/^-\d+$/.test(flag)) {
      i++;
      continue;
    }

    // Check if it's a known single-char flag
    const flagType = config.safeFlags[flag];
    if (flagType !== undefined) {
      if (flagType === 'none') {
        i++;
        continue;
      }
      // Flag expects argument: next token
      i++;
      if (i >= tokens.length) return false;
      const value = tokens[i];
      if (!validateFlagArgument(value, flagType)) return false;
      i++;
      continue;
    }

    // Check for -flag=value form
    const shortEqIdx = flag.indexOf('=');
    if (shortEqIdx !== -1) {
      const shortFlagName = flag.substring(0, shortEqIdx);
      const shortFlagType = config.safeFlags[shortFlagName];
      if (shortFlagType === undefined) return false;
      const value = flag.substring(shortEqIdx + 1);
      if (shortFlagType !== 'none' && !validateFlagArgument(value, shortFlagType))
        return false;
      i++;
      continue;
    }

    // Attached numeric: -A20, -B5, etc.
    if (/^-[A-Za-z]\d+$/.test(flag)) {
      const shortFlag = flag.substring(0, 2);
      const shortFlagType = config.safeFlags[shortFlag];
      if (shortFlagType === 'number') {
        i++;
        continue;
      }
    }

    // Combined short flags: -rn, -la, etc.
    // All flags in the bundle must be 'none' type
    if (/^-[A-Za-z]{2,}$/.test(flag)) {
      let allNone = true;
      for (let j = 1; j < flag.length; j++) {
        const singleFlag = `-${flag[j]}`;
        const singleType = config.safeFlags[singleFlag];
        if (singleType !== 'none') {
          allNone = false;
          break;
        }
      }
      if (allNone) {
        i++;
        continue;
      }
    }

    // Unknown flag
    return false;
  }

  return true;
}

// ============================================================
// Core validation functions
// ============================================================

/**
 * Try to match command against COMMAND_ALLOWLIST using longest prefix match.
 * Returns [matchKey, config, remainingTokens] or null.
 */
function matchCommandAllowlist(
  tokens: string[]
): [string, CommandConfig, number] | null {
  // Try longest prefix first (3 tokens, then 2, then 1)
  for (let len = Math.min(3, tokens.length); len >= 1; len--) {
    const prefix = tokens.slice(0, len).join(' ');
    const config = COMMAND_ALLOWLIST[prefix];
    if (config) {
      return [prefix, config, len];
    }
  }
  return null;
}

/**
 * Check if a single (already normalized) command is safe via flag parsing.
 * This is the flag-level whitelist validation (Tier 3).
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens.length === 0) return false;

  const match = matchCommandAllowlist(tokens);
  if (!match) return false;

  const [commandName, config, startIndex] = match;
  const args = tokens.slice(startIndex);

  // Blanket $ rejection: any token after command containing $ is rejected
  for (const arg of args) {
    if (arg.includes('$')) return false;
  }

  // Brace expansion rejection
  for (const arg of args) {
    if (arg.includes('{') && (arg.includes(',') || arg.includes('..'))) return false;
  }

  // Validate flags
  if (!validateFlags(tokens, startIndex, config)) return false;

  // Check regex if present
  if (config.regex && !config.regex.test(command)) return false;

  // Check isDangerousCallback
  if (config.isDangerousCallback && config.isDangerousCallback(command, args))
    return false;

  // Special: block newline/carriage return in grep/rg commands
  if (commandName === 'grep' || commandName === 'rg') {
    for (const arg of args) {
      if (arg.includes('\n') || arg.includes('\r')) return false;
    }
  }

  return true;
}

/**
 * Check if command matches any readonly regex pattern (Tier 1 + 2).
 */
function matchesReadonlyRegex(command: string): boolean {
  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(command)) return true;
  }
  return false;
}

/**
 * Check if a single command contains unquoted expansion characters.
 * More focused than containsUnsafePatterns — specifically checks for
 * variable expansion ($VAR, ${VAR}, $()) and backtick subshells.
 */
function containsUnquotedExpansion(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Inside single quotes: nothing is special
    if (inSingleQuote) continue;

    // $ is dangerous in both unquoted and double-quoted contexts
    if (ch === '$') {
      const next = command[i + 1];
      if (next && /[A-Za-z_@*#?!$0-9({-]/.test(next)) return true;
    }

    // Backtick subshell
    if (ch === '`') return true;

    // Only check globs outside all quotes
    if (!inDoubleQuote) {
      if (ch === '?' || ch === '*' || ch === '[' || ch === ']') {
        // These are glob characters but might be in safe contexts
        // For now, don't flag them here — let individual validators handle it
      }
    }
  }

  return false;
}

/**
 * Determine if a single (already normalized) command is read-only.
 *
 * Priority:
 * 1. Reject if contains unquoted expansion ($, backtick)
 * 2. Try flag-level whitelist validation (Tier 3)
 * 3. Fall back to regex matching (Tier 1 + 2)
 * 4. Post-regex: block git -c/--exec-path/--config-env
 */
export function isCommandReadOnly(command: string): boolean {
  // Strip trailing 2>&1 (safe stderr redirect)
  const cleaned = command.replace(/\s+2>&1\s*$/, '').trim();
  if (!cleaned) return false;

  // Reject unquoted variable expansion
  if (containsUnquotedExpansion(cleaned)) return false;

  // Tier 3: Flag-level whitelist validation (most precise)
  if (isCommandSafeViaFlagParsing(cleaned)) return true;

  // Tier 1+2: Regex matching (broader patterns)
  if (matchesReadonlyRegex(cleaned)) {
    // Post-regex safety: block dangerous git global options
    // that regex patterns might not catch
    if (/\bgit\b/.test(cleaned)) {
      if (
        /\s-c\s/.test(cleaned) ||
        /--exec-path/.test(cleaned) ||
        /--config-env/.test(cleaned)
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Determine if a full bash command is read-only (safe to auto-approve).
 *
 * Pipeline:
 * 1. Quick reject: containsUnsafePatterns (pipe/redirect/subshell/$var)
 * 2. Split compound commands (&&, ||, ;)
 * 3. For each sub-command:
 *    a. Strip safe env vars + safe wrappers (normalize)
 *    b. Check isCommandReadOnly()
 * 4. All sub-commands must be read-only
 *
 * Security hardening:
 * - cd + git compound -> false (sandbox escape prevention)
 * - Pipe/redirect -> false
 * - $ variable expansion -> false
 * - git -c / --exec-path / --config-env -> false (via normalizeGitCommand)
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Step 1: Try to split compound commands
  const parts = splitCompoundCommand(trimmed);

  // null means the command contains pipe | or redirect > < — not safe
  if (parts === null) return false;

  // Step 2: Security: cd + git compound -> reject (sandbox escape)
  if (parts.length > 1) {
    let hasCd = false;
    let hasGit = false;
    for (const part of parts) {
      const normalized = stripSafeEnvVars(stripSafeWrappers(part.trim()));
      if (/^cd\b/.test(normalized)) hasCd = true;
      if (/\bgit\b/.test(normalized)) hasGit = true;
    }
    if (hasCd && hasGit) return false;
  }

  // Step 3: Validate each sub-command
  for (const part of parts) {
    const sub = part.trim();
    if (!sub) continue;

    // Normalize: strip safe env vars + wrappers
    const normalized = stripSafeEnvVars(stripSafeWrappers(sub));
    if (!normalized) return false;

    // Check if the normalized command is read-only
    if (!isCommandReadOnly(normalized)) return false;
  }

  return true;
}
