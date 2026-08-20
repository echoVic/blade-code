import path from 'node:path';
import { PathSecurity } from '../pathSecurity.js';
import {
  containsUnsafePatterns,
  splitCompoundCommand,
  stripSafeEnvVars,
  tokenize,
} from './commandNormalizer.js';

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const DIRECT_RUNNERS = new Set([
  'biome',
  'eslint',
  'jest',
  'mypy',
  'pyright',
  'pytest',
  'ruff',
  'tsc',
  'vitest',
]);
const MUTATING_FLAGS = new Set([
  '-u',
  '--fix',
  '--update',
  '--update-snapshot',
  '--updateSnapshot',
  '--watch',
  '--watchAll',
  '--write',
]);

function isVerificationScript(script: string | undefined): boolean {
  return (
    script !== undefined &&
    /^(?:test|lint|build|type-?check)(?::[\w.-]+)*$/i.test(script)
  );
}

export function stripSafeStderrMerge(command: string): string {
  return command.replace(/\s+2>&1\s*$/, '').trim();
}

function unwrapWorkspaceDirectory(
  command: string,
  parts: readonly string[],
  workspaceRoot: string | undefined
): string | undefined {
  if (!workspaceRoot || parts.length !== 2) return undefined;
  const wrapper = /^(.+?)[ \t]+&&[ \t]+([\s\S]+)$/.exec(command);
  if (!wrapper) return undefined;
  const cdTokens = tokenize(wrapper[1] ?? '');
  if (cdTokens.length !== 2 || cdTokens[0] !== 'cd') return undefined;
  const target = cdTokens[1];
  if (!target || target === '-') return undefined;
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(workspaceRoot, target);
  if (!PathSecurity.isWithinWorkspace(resolvedTarget, workspaceRoot)) {
    return undefined;
  }
  return wrapper[2]?.trim() || undefined;
}

export function isVerificationCommand(
  command: string,
  workspaceRoot?: string
): boolean {
  const normalized = stripSafeEnvVars(stripSafeStderrMerge(command));
  const parts = splitCompoundCommand(normalized);
  if (!parts || containsUnsafePatterns(normalized) || /[\r\n]/.test(normalized)) {
    return false;
  }

  const verificationCommand =
    parts.length === 1
      ? parts[0]
      : unwrapWorkspaceDirectory(normalized, parts, workspaceRoot);
  if (!verificationCommand) return false;

  const tokens = tokenize(verificationCommand);
  if (
    tokens.length === 0 ||
    tokens.some((token) =>
      [...MUTATING_FLAGS].some((flag) => token === flag || token.startsWith(`${flag}=`))
    )
  ) {
    return false;
  }

  const [executable, second, third] = tokens;
  if (PACKAGE_MANAGERS.has(executable ?? '')) {
    const script = second === 'run' ? third : second;
    return isVerificationScript(script) || second === '--test';
  }
  if (
    (executable === 'npx' || executable === 'bunx') &&
    DIRECT_RUNNERS.has(second ?? '')
  ) {
    return true;
  }
  if (DIRECT_RUNNERS.has(executable ?? '')) return true;
  if (executable === 'node' && second === '--test') return true;
  if (executable === 'go' && ['build', 'test', 'vet'].includes(second ?? '')) {
    return true;
  }
  return (
    executable === 'cargo' &&
    ['build', 'check', 'clippy', 'test'].includes(second ?? '')
  );
}

export function isSafeVerificationWorkingDirectory(
  value: unknown,
  workspaceRoot?: string
): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.split(/[\\/]/).includes('..')) {
    return false;
  }
  if (!workspaceRoot) return !path.isAbsolute(value);
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(workspaceRoot, value);
  return PathSecurity.isWithinWorkspace(resolved, workspaceRoot);
}
