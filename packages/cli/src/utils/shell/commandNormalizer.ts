/**
 * Command Normalizer
 *
 * Normalizes Bash commands for permission matching:
 * - Strip safe environment variable prefixes
 * - Strip wrapper commands (timeout/time/nice/nohup)
 * - Split compound commands (&&, ||, ;)
 * - Normalize git commands (strip -C, --no-pager, etc.)
 *
 * Ref: Claude Code's stripSafeWrappers / stripAllLeadingEnvVars / splitCommand
 */

// ============================================================
// Safe environment variable allowlist
// ============================================================

/**
 * Safe env vars that can be stripped when matching allow rules.
 *
 * NEVER add: PATH, LD_PRELOAD, DYLD_*, PYTHONPATH,
 * NODE_PATH, NODE_OPTIONS, HOME, SHELL, BASH_ENV
 */
const SAFE_ENV_VARS = new Set([
  // Go
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE',
  // Rust
  'RUST_BACKTRACE', 'RUST_LOG',
  // Node
  'NODE_ENV',
  // Python
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  // Git (only non-executable env vars; GIT_PAGER and GIT_SSH_COMMAND
  // are deliberately excluded — they execute external binaries)
  'GIT_TERMINAL_PROMPT',
  // Locale/Terminal
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  // Colors
  'LS_COLORS', 'LSCOLORS', 'GREP_COLOR', 'GREP_COLORS',
]);

/**
 * Binary hijack env vars — never strip even in aggressive mode.
 * Prevents: LD_PRELOAD=evil.so denied_command bypassing deny rules.
 * Matches: any var starting with LD_ or DYLD_, or exactly PATH.
 */
const BINARY_HIJACK_PATTERN = /^(LD_.+|DYLD_.+|PATH)$/;

/**
 * Env var assignment pattern: KEY=value (value restricted to safe chars).
 * Value must NOT contain $, `, ;, |, & or other shell metacharacters.
 */
const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([\w./:@-]*)$/;

// ============================================================
// Env var stripping
// ============================================================

/**
 * Strip safe environment variable prefixes only.
 * Only strips vars in SAFE_ENV_VARS allowlist with safe values.
 *
 * @example
 * stripSafeEnvVars('NODE_ENV=production git log') // => 'git log'
 * stripSafeEnvVars('EVIL_VAR=x git log')          // => 'EVIL_VAR=x git log' (not stripped)
 * stripSafeEnvVars('PATH=/evil git log')           // => 'PATH=/evil git log' (not stripped)
 */
export function stripSafeEnvVars(command: string): string {
  let result = command;

  while (true) {
    const match = result.match(/^(\S+)[ \t]+([\s\S]*)$/);
    if (!match) break;

    const token = match[1];
    const rest = match[2];

    const envMatch = token.match(ENV_VAR_PATTERN);
    if (!envMatch) break;

    const varName = envMatch[1];
    if (!SAFE_ENV_VARS.has(varName)) break;

    result = rest;
  }

  return result;
}

/**
 * Strip ALL env var prefixes (aggressive mode for deny/ask rule matching).
 * Strips everything except BINARY_HIJACK_PATTERN vars.
 *
 * @example
 * stripAllEnvVars('EVIL=x git push')     // => 'git push'
 * stripAllEnvVars('PATH=/evil git push')  // => 'PATH=/evil git push' (not stripped)
 */
export function stripAllEnvVars(command: string): string {
  let result = command;

  while (true) {
    const match = result.match(/^(\S+)[ \t]+([\s\S]*)$/);
    if (!match) break;

    const token = match[1];
    const rest = match[2];

    const envMatch = token.match(ENV_VAR_PATTERN);
    if (!envMatch) break;

    const varName = envMatch[1];
    if (BINARY_HIJACK_PATTERN.test(varName)) break;

    result = rest;
  }

  return result;
}

// ============================================================
// Wrapper command stripping
// ============================================================

/**
 * Safe wrapper command patterns.
 * Each pattern matches the wrapper and its args; remainder is the actual command.
 * Uses [ \t]+ not \s+ (newlines are command separators).
 */
const SAFE_WRAPPER_REGEXES: RegExp[] = [
  // timeout [flags] DURATION (must come before the actual command)
  /^timeout[ \t]+(?:--foreground[ \t]+|--preserve-status[ \t]+|-v[ \t]+|--verbose[ \t]+|-k[ \t]+\S+[ \t]+|--kill-after[= ]\S+[ \t]+|-s[ \t]+\S+[ \t]+|--signal[= ]\S+[ \t]+)*\S+[ \t]+/,
  // time
  /^time[ \t]+/,
  // nice [-n N] or nice -N
  /^nice[ \t]+(?:-n[ \t]+\d+[ \t]+|-\d+[ \t]+)?/,
  // nohup
  /^nohup[ \t]+/,
];

/**
 * Strip safe wrapper command prefixes.
 *
 * @example
 * stripSafeWrappers('timeout 30 git log')     // => 'git log'
 * stripSafeWrappers('nice -n 10 git status')  // => 'git status'
 * stripSafeWrappers('nohup git log')           // => 'git log'
 */
export function stripSafeWrappers(command: string): string {
  let result = command;

  let changed = true;
  while (changed) {
    changed = false;
    for (const regex of SAFE_WRAPPER_REGEXES) {
      const match = result.match(regex);
      if (match) {
        result = result.slice(match[0].length);
        changed = true;
        break;
      }
    }
    // Also strip optional -- (end of options)
    if (result.startsWith('-- ')) {
      result = result.slice(3);
      changed = true;
    }
  }

  return result;
}

// ============================================================
// Compound command splitting
// ============================================================

/**
 * Split compound commands into sub-command list.
 * Supports &&, ||, ; separators. Quote-aware.
 *
 * Returns null if command contains pipe (|) or redirects (> >> <) — not safe.
 *
 * @example
 * splitCompoundCommand('git status && git log')  // => ['git status', 'git log']
 * splitCompoundCommand('git log | head')          // => null (pipe)
 * splitCompoundCommand('echo "a && b"')           // => ['echo "a && b"']
 */
export function splitCompoundCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    // Inside quotes: don't analyze
    if (inSingleQuote || inDoubleQuote) {
      current += ch;
      continue;
    }

    // Detect pipe and redirect => unsafe
    if (ch === '|') {
      if (i + 1 < command.length && command[i + 1] === '|') {
        // || is logical OR — split here
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++; // skip second |
        continue;
      }
      // Single | is pipe — not safe
      return null;
    }

    if (ch === '>' || ch === '<') {
      return null;
    }

    // Detect &&
    if (ch === '&' && i + 1 < command.length && command[i + 1] === '&') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i++; // skip second &
      continue;
    }

    // Single & (background) — not safe
    if (ch === '&') {
      return null;
    }

    // Detect ;
    if (ch === ';') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : null;
}

// ============================================================
// Unsafe pattern detection
// ============================================================

/**
 * Detect if command contains unsafe patterns.
 * Used for fast rejection in read-only validation.
 *
 * Detects: pipe | , redirect > >> < , subshell $() `` , $ variable refs, brace expansion
 */
export function containsUnsafePatterns(command: string): boolean {
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

    // $ is dangerous both inside and outside double quotes
    if (ch === '$') {
      const next = command[i + 1];
      if (next && /[A-Za-z_@*#?!$0-9({]/.test(next)) {
        return true;
      }
    }

    // Backtick (subshell)
    if (ch === '`') return true;

    // Inside double quotes: don't check pipe/redirect/brace
    if (inDoubleQuote) continue;

    // Pipe
    if (ch === '|') return true;

    // Redirect
    if (ch === '>' || ch === '<') return true;

    // Brace expansion: {a,b} or {1..5}
    if (ch === '{') {
      const rest = command.slice(i);
      if (/^\{[^}]*,[^}]*\}/.test(rest) || /^\{[^}]*\.\.[^}]*\}/.test(rest)) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Git command normalization
// ============================================================

/** Git safe global options (can be stripped) */
const GIT_SAFE_GLOBAL_FLAGS: Record<string, 'none' | 'string'> = {
  '-C': 'string',             // change directory
  '--no-pager': 'none',       // disable pager
  '--no-optional-locks': 'none',
  '-P': 'none',               // --paginate alias
  '--paginate': 'none',
  '--literal-pathspecs': 'none',
  '--glob-pathspecs': 'none',
  '--noglob-pathspecs': 'none',
  '--icase-pathspecs': 'none',
};

/** Git dangerous global options (reject if found) */
const GIT_DANGEROUS_GLOBAL_FLAGS = new Set([
  '-c',              // modify config
  '--exec-path',     // binary hijack
  '--config-env',    // read config from env
  '--git-dir',       // switch .git dir (escape)
  '--work-tree',     // switch work dir
]);

/**
 * Normalize git command: strip -C <path>, --no-pager, etc.
 * Returns null if dangerous options found (-c, --exec-path, etc.)
 *
 * @example
 * normalizeGitCommand('git -C /path --no-pager log --oneline')
 * // => { subcommand: 'log', args: ['--oneline'] }
 *
 * normalizeGitCommand('git -c core.pager=less log')
 * // => null (-c is unsafe)
 */
export function normalizeGitCommand(command: string): {
  subcommand: string;
  args: string[];
} | null {
  const tokens = tokenize(command);
  if (tokens.length === 0 || tokens[0] !== 'git') return null;

  let i = 1; // skip 'git'

  // Skip safe global options
  while (i < tokens.length) {
    const token = tokens[i];

    // Check dangerous options (handle --exec-path=xxx and -c key=val)
    const flagName = token.includes('=') ? token.split('=')[0] : token;
    if (GIT_DANGEROUS_GLOBAL_FLAGS.has(flagName)) {
      return null;
    }

    // Check safe options
    const flagType = GIT_SAFE_GLOBAL_FLAGS[flagName];
    if (flagType === 'none') {
      i++;
      continue;
    }
    if (flagType === 'string') {
      if (token.includes('=')) {
        i++; // -C=/path form
      } else {
        i += 2; // -C /path form
      }
      continue;
    }

    // Not a global option — should be the subcommand
    break;
  }

  if (i >= tokens.length) return null;

  return {
    subcommand: tokens[i],
    args: tokens.slice(i + 1),
  };
}

// ============================================================
// Utilities
// ============================================================

/**
 * Simple shell-aware tokenizer (quote-aware word splitting).
 * Doesn't handle complex shell features (process substitution, etc.),
 * only used for permission matching scenarios.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      if (inDoubleQuote) {
        const next = command[i + 1];
        if (next && '$`"\\'.includes(next)) {
          continue; // skip \, next char handled in escaped branch
        }
        current += ch;
        escaped = false;
      }
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

    if (!inSingleQuote && !inDoubleQuote && /[ \t]/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
