/**
 * Read-Only Command Validation <p> Three-tier validation for determining if a Bash
 * command is read-only: 1. Simple regex matching (cat, head, wc, etc.) 2. Custom regex
 * matching (echo, pwd, find, ls, cd, etc.) 3. Flag-level whitelist validation (git, gh,
 * docker, rg, etc.) <p> Ref: Claude Code's readOnlyCommandValidation.ts +
 * BashTool/readOnlyValidation.ts
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

type FlagSpec = Partial<Record<FlagArgType, string>>;

function flags(
  spec: FlagSpec,
  ...sharedGroups: readonly Readonly<Record<string, FlagArgType>>[]
): Record<string, FlagArgType> {
  const result: Record<string, FlagArgType> = Object.assign({}, ...sharedGroups);
  for (const argType of ['none', 'number', 'string'] as const) {
    const names = spec[argType]?.trim();
    if (!names) continue;
    for (const name of names.split(/\s+/)) result[name] = argType;
  }
  return result;
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
    safeFlags: flags(
      {
        none: `
        --cached --staged --no-index --word-diff --compact-summary
        --ignore-space-change -b --ignore-all-space -w
        --ignore-blank-lines --no-prefix -R --relative --histogram
        --patience --minimal --check --ext-diff --binary --abbrev
        --full-index --break-rewrites -B --find-renames -M
        --find-copies -C
      `,
        number: '-U --unified',
        string: `
        --diff-filter --word-diff-regex --src-prefix --dst-prefix
        --diff-algorithm
      `,
      },
      GIT_STAT_FLAGS,
      GIT_COLOR_FLAGS,
      GIT_PATCH_FLAGS
    ),
  },

  'git log': {
    safeFlags: flags(
      {
        none: `
        --follow --first-parent --merges --no-merges --reverse
        --ancestry-path --simplify-by-decoration --abbrev-commit
        --no-abbrev-commit --topo-order --left-right --cherry-pick
        --cherry-mark --cherry --walk-reflogs -g --boundary --source
      `,
        number: '--abbrev --skip',
        string: '--diff-filter',
      },
      GIT_REF_SELECTION_FLAGS,
      GIT_DATE_FILTER_FLAGS,
      GIT_LOG_DISPLAY_FLAGS,
      GIT_COUNT_FLAGS,
      GIT_STAT_FLAGS,
      GIT_COLOR_FLAGS,
      GIT_PATCH_FLAGS,
      GIT_AUTHOR_FILTER_FLAGS,
      GIT_FORMAT_FLAGS
    ),
  },

  'git show': {
    safeFlags: flags(
      {
        none: `
        --abbrev-commit --no-abbrev-commit --word-diff
        --compact-summary
      `,
        number: '--abbrev -U --unified',
        string: '--diff-filter --word-diff-regex',
      },
      GIT_STAT_FLAGS,
      GIT_COLOR_FLAGS,
      GIT_PATCH_FLAGS,
      GIT_FORMAT_FLAGS
    ),
  },

  'git shortlog': {
    safeFlags: flags(
      {
        none: '-s --summary --numbered -e --email',
        number: '-n',
        string: '--group --format',
      },
      GIT_REF_SELECTION_FLAGS,
      GIT_DATE_FILTER_FLAGS,
      GIT_COUNT_FLAGS,
      GIT_AUTHOR_FILTER_FLAGS
    ),
  },

  'git reflog': {
    safeFlags: flags(
      {
        string: '--date',
      },
      GIT_LOG_DISPLAY_FLAGS,
      GIT_COUNT_FLAGS,
      GIT_COLOR_FLAGS,
      GIT_FORMAT_FLAGS
    ),
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
    safeFlags: flags({}, GIT_LOG_DISPLAY_FLAGS, GIT_COLOR_FLAGS, GIT_FORMAT_FLAGS),
  },

  'git stash show': {
    safeFlags: flags(
      {
        none: '--include-untracked -u',
        number: '-U --unified',
      },
      GIT_STAT_FLAGS,
      GIT_COLOR_FLAGS,
      GIT_PATCH_FLAGS
    ),
  },

  'git ls-remote': {
    safeFlags: flags({
      none: '--heads --tags --refs --quiet -q --get-url --symref',
      string: '--sort',
    }),
  },

  'git status': {
    safeFlags: flags({
      none: `
        --short -s --branch -b --porcelain --long --verbose -v
        --untracked-files -u --ignored --ignore-submodules --column
        --no-column --ahead-behind --no-ahead-behind --renames
        --no-renames --show-stash
      `,
    }),
  },

  'git blame': {
    safeFlags: flags({
      none: `
        --line-porcelain --porcelain -p --show-name --show-number -n
        --show-email -e -w -M -C --color-lines --color-by-age -s
        --score-debug --first-parent --root
      `,
      number: '--abbrev',
      string: '-L --date --since',
    }),
  },

  'git ls-files': {
    safeFlags: flags({
      none: `
        --cached -c --deleted -d --modified -m --others -o --ignored
        -i --stage -s --unmerged -u --killed -k --exclude-standard
        --error-unmatch --full-name --recurse-submodules -z --eol
        --deduplicate
      `,
      string: '--exclude -x --exclude-from -X --exclude-per-directory',
    }),
  },

  'git config --get': {
    safeFlags: flags({
      none: `
        --global --system --local --worktree --get-regexp --list -l
        --show-origin --show-scope -z --null --name-only
      `,
      string: '--type --default',
    }),
  },

  'git remote show': {
    safeFlags: flags({
      none: '-n',
    }),
    isDangerousCallback: (_raw, args) => {
      // Must have exactly one alphanumeric remote name
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      if (nonFlags.length !== 1) return true;
      return !/^[a-zA-Z0-9_.-]+$/.test(nonFlags[0]);
    },
  },

  'git remote': {
    safeFlags: flags({
      none: '-v --verbose',
    }),
    isDangerousCallback: (_raw, args) => {
      // Only bare `git remote` or `git remote -v` is safe
      // Any positional arg (add/remove/rename/set-url) is dangerous
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      return nonFlags.length > 0;
    },
  },

  'git merge-base': {
    safeFlags: flags({
      none: '--all --octopus --is-ancestor --independent --fork-point',
    }),
  },

  'git rev-parse': {
    safeFlags: flags({
      none: `
        --verify --quiet -q --short --symbolic --symbolic-full-name
        --abbrev-ref --show-toplevel --show-cdup --show-prefix
        --show-superproject-working-tree --git-dir --git-common-dir
        --is-inside-git-dir --is-inside-work-tree
        --is-bare-repository --is-shallow-repository
        --absolute-git-dir --all --branches --tags --remotes
      `,
      string: '--git-path --resolve-git-dir --glob --exclude',
    }),
  },

  'git rev-list': {
    safeFlags: flags(
      {
        none: `
        --count --objects --no-walk --first-parent --merges
        --no-merges --reverse --ancestry-path --topo-order
        --left-right --cherry-pick --cherry-mark --cherry --boundary
        --abbrev-commit --header
      `,
        number: '--abbrev --skip',
      },
      GIT_REF_SELECTION_FLAGS,
      GIT_DATE_FILTER_FLAGS,
      GIT_COUNT_FLAGS
    ),
  },

  'git describe': {
    safeFlags: flags({
      none: `
        --all --tags --contains --long --first-parent --always
        --exact-match --dirty --broken --debug
      `,
      number: '--abbrev --candidates',
      string: '--match --exclude',
    }),
  },

  'git cat-file': {
    safeFlags: flags({
      none: `
        -t -s -e -p --batch --batch-check --batch-all-objects
        --textconv --filters --allow-unknown-type --buffer
        --unordered
      `,
    }),
  },

  'git for-each-ref': {
    safeFlags: flags({
      none: '--shell --perl --python --tcl',
      number: '--count',
      string: `
        --format --sort --points-at --merged --no-merged --contains
        --no-contains
      `,
    }),
  },

  'git grep': {
    safeFlags: flags({
      none: `
        -i --ignore-case -w --word-regexp -v --invert-match -n
        --line-number -l --files-with-matches --name-only -L
        --files-without-match -c --count --color --no-color --and
        --or --not --all-match -E --extended-regexp -G
        --basic-regexp -P --perl-regexp -F --fixed-strings --cached
        --untracked --no-index --recurse-submodules -h --no-filename
        -H --full-name -z --break --heading -p --show-function -W
        --function-context --open-files-in-pager
      `,
      number: '--max-depth --threads -A -B -C --context',
      string: '-e -f -O',
    }),
  },

  'git worktree list': {
    safeFlags: flags({
      none: '--porcelain -z -v --verbose',
      string: '--expire',
    }),
  },

  'git tag': {
    safeFlags: flags({
      none: '-l --list --column --no-column --color --no-color',
      number: '-n',
      string: `
        --sort --contains --no-contains --merged --no-merged
        --points-at --format
      `,
    }),
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
    safeFlags: flags({
      none: `
        -l --list -a --all -r --remotes -v --verbose -vv --color
        --no-color --column --no-column --no-abbrev --show-current
      `,
      number: '--abbrev',
      string: `
        --sort --format --contains --no-contains --merged
        --no-merged --points-at
      `,
    }),
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
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr list': {
    safeFlags: flags(
      {
        none: '--draft',
        string: `
        --state -s --author --label --base --head --search
        --assignee
      `,
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr diff': {
    safeFlags: flags(
      {
        none: '--patch --name-only',
        string: '--color',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr checks': {
    safeFlags: flags(
      {
        none: '--watch --fail-fast --required',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh pr status': {
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue view': {
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue list': {
    safeFlags: flags(
      {
        string: '--state -s --author --label --search --assignee --milestone',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh issue status': {
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh repo view': {
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh run list': {
    safeFlags: flags(
      {
        string: '--workflow -w --branch -b --status -s --user -u --event -e',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh run view': {
    safeFlags: flags(
      {
        none: '--log --log-failed --exit-status --verbose -v',
        string: '--job -j',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh auth status': {
    safeFlags: flags({
      none: '--active',
      string: '--hostname -h',
    }),
    isDangerousCallback: (_raw, args) => {
      // Block --show-token / -t (leaks credentials)
      return args.some((a) => a === '--show-token' || a === '-t');
    },
  },
  'gh release list': {
    safeFlags: flags(
      {
        none: '--exclude-drafts --exclude-pre-releases',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh release view': {
    safeFlags: flags({}, GH_COMMON_FLAGS),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh workflow list': {
    safeFlags: flags(
      {
        none: '--all -a',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh workflow view': {
    safeFlags: flags(
      {
        none: '--yaml -y',
        string: '--ref -r',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh label list': {
    safeFlags: flags(
      {
        string: '--search --sort --order',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search repos': {
    safeFlags: flags(
      {
        string: `
        --language --topic --sort --order --match --owner
        --visibility
      `,
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search issues': {
    safeFlags: flags(
      {
        string: `
        --sort --order --match --state --label --language --author
        --assignee --repo
      `,
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search prs': {
    safeFlags: flags(
      {
        string: `
        --sort --order --match --state --label --language --author
        --assignee --repo
      `,
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search commits': {
    safeFlags: flags(
      {
        string: '--sort --order --author --committer --repo',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
  'gh search code': {
    safeFlags: flags(
      {
        string: '--language --filename --extension --repo --match',
      },
      GH_COMMON_FLAGS
    ),
    isDangerousCallback: ghIsDangerousCallback,
  },
};

// ============================================================
// DOCKER & RIPGREP READ_ONLY_COMMANDS
// ============================================================

export const DOCKER_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  'docker logs': {
    safeFlags: flags({
      none: '--follow -f --timestamps -t --details',
      number: '--tail -n',
      string: '--since --until',
    }),
  },
  'docker inspect': {
    safeFlags: flags({
      none: '--size -s',
      string: '--format -f --type',
    }),
  },
};

export const RIPGREP_READ_ONLY_COMMANDS: Record<string, CommandConfig> = {
  rg: {
    safeFlags: flags({
      none: `
        -F --fixed-strings -i --ignore-case -S --smart-case -s
        --case-sensitive -v --invert-match -w --word-regexp -x
        --line-regexp -P --pcre2 --mmap --no-mmap -U --multiline
        --multiline-dotall --crlf --no-crlf -c --count
        --count-matches -l --files-with-matches
        --files-without-match -o --only-matching --vimgrep -n
        --line-number -N --no-line-number -H --with-filename
        --no-filename -p --pretty --heading --no-heading --column
        --no-column --byte-offset --trim --stats --no-ignore
        --no-ignore-vcs --no-ignore-parent --no-ignore-global
        --hidden --no-hidden -L --follow --one-file-system --null -0
        --no-config --no-ignore-dot --no-ignore-exclude --no-unicode
        --pcre2-version -q --quiet --help -h --version -V -- --json
        --auto-hybrid-regex --binary --block-buffered
        --line-buffered --debug --no-messages --search-zip -z
        --type-list --unrestricted -u
      `,
      number: `
        -m --max-count --max-depth --maxdepth -d -A --after-context
        -B --before-context -C --context -j --threads
      `,
      string: `
        -e --regexp --engine --max-filesize -r --replace -t --type
        -T --type-not -g --glob --iglob --type-add --type-clear
        --color --colors --sort --sortr --path-separator
        --dfa-size-limit --encoding -E --regex-size-limit
      `,
    }),
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
    safeFlags: flags({
      none: `
        -b --brief -i --mime --mime-type --mime-encoding -L -h
        --no-dereference -z
      `,
    }),
  },
  sort: {
    safeFlags: flags({
      none: `
        -r --reverse -n --numeric-sort -u --unique -f --ignore-case
        -s --stable -h --human-numeric-sort -V --version-sort -g
        --general-numeric-sort -M --month-sort
      `,
      string: '-k --key -t --field-separator',
    }),
  },
  grep: {
    safeFlags: flags({
      none: `
        -i --ignore-case -v --invert-match -c --count -l
        --files-with-matches -L --files-without-match -n
        --line-number -H --with-filename -h --no-filename -r -R
        --recursive -E --extended-regexp -F --fixed-strings -P
        --perl-regexp -w --word-regexp -x --line-regexp -o
        --only-matching -q --quiet --silent -s --no-messages -Z
        --null
      `,
      number: `
        -A --after-context -B --before-context -C --context -m
        --max-count
      `,
      string: `
        --color --colour -e --regexp --include --exclude
        --exclude-dir
      `,
    }),
  },
  tree: {
    safeFlags: flags({
      none: `
        -d -a -f -i -l -s -h -p -u -g -D -r -t --noreport
        --dirsfirst -C --color -n --prune -J -X
      `,
      number: '-L',
      string: '-I -P --charset -o -H',
    }),
  },
  date: {
    safeFlags: flags({
      none: '-u --utc -I --iso-8601 -R --rfc-2822',
      string: '-d --date --rfc-3339',
    }),
  },
  ps: {
    safeFlags: flags({
      none: '-e -f -l -a -u -x --forest -H --headers --no-headers -w',
      number: '--width',
      string: '-o --sort -p --pid -C',
    }),
  },
  lsof: {
    safeFlags: flags({
      none: '-n -P -t -a',
      string: '-i -p -c -u -d',
    }),
  },
  netstat: {
    safeFlags: flags({
      none: '-t -u -l -n -p -a -r -s -e -o -i',
    }),
  },
  man: {
    safeFlags: flags({
      string: '-k --apropos -f --whatis',
    }),
  },
  sed: {
    safeFlags: flags({
      none: '-n --quiet --silent -E -r --regexp-extended',
      string: '-e --expression',
    }),
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
    safeFlags: flags({
      none: '-d --decode -i --ignore-garbage',
      number: '-w --wrap',
    }),
  },
  sha256sum: {
    safeFlags: flags({
      none: `
        -c --check -b --binary -t --text --tag --status -w --warn
        --strict --quiet
      `,
    }),
  },
  sha1sum: {
    safeFlags: flags({
      none: '-c --check -b --binary --tag --status',
    }),
  },
  md5sum: {
    safeFlags: flags({
      none: '-c --check -b --binary --tag --status',
    }),
  },
  hostname: {
    safeFlags: flags({
      none: '-s -f --fqdn -d -i -I -a',
    }),
  },
  pgrep: {
    safeFlags: flags({
      none: '-l -a -f -x -n -o -c',
      string: '-d -u -U -P -G -t',
    }),
  },
  ss: {
    safeFlags: flags({
      none: '-t -u -l -n -p -a -r -s -e -o -i -4 -6 -m -Z -K',
    }),
  },
  fd: {
    safeFlags: flags({
      none: `
        -H --hidden -I --no-ignore -s --case-sensitive -i
        --ignore-case -a --absolute-path -l --list-details -L
        --follow -p --full-path -0 --print0 -1 --glob -g -F
        --fixed-strings --prune -u --unrestricted
      `,
      number: '-d --max-depth -j --threads',
      string: `
        -t --type -e --extension -E --exclude --color -S --size
        --changed-within --changed-before
      `,
    }),
  },
  fdfind: {
    safeFlags: flags({
      none: `
        -H --hidden -I --no-ignore -s --case-sensitive -i
        --ignore-case -a --absolute-path -l --list-details -L
        --follow -p --full-path -0 --print0 -1 --glob -g -F
        --fixed-strings
      `,
      number: '-d --max-depth',
      string: '-t --type -e --extension -E --exclude --color',
    }),
  },
  tput: {
    safeFlags: flags({
      none: '-S',
    }),
  },
  help: { safeFlags: flags({}) },
  info: { safeFlags: flags({}) },
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

/** Validate flag argument value against expected type. */
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

 * Validate that all flags in a token list are in the whitelist. <p> Handles: -

 * --flag=value (split on =) - -n 5 (flag with next-token argument) - Combined short

 * flags -rn (all must be 'none' type) - Git numeric shorthand -<number> - -- (end of

 * options separator) <p> Returns true if all flags are safe.

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

    // Combined short flags: -rn, -la, etc. All flags in the bundle must be 'none' type
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

/** Check if command matches any readonly regex pattern (Tier 1 + 2). */
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
