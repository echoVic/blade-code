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
const SAFE_EXIT_STATUS_PROBE =
  /[ \t]*;[ \t]*echo[ \t]+"[A-Za-z0-9 _:=.-]*(?:\$\{PIPESTATUS\[0\]\}|\$\?)[A-Za-z0-9 _:=.-]*"[ \t]*$/;

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

function findUnquotedPipes(command: string): number[] | undefined {
  const pipes: number[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (character !== '|' || inSingleQuote || inDoubleQuote) continue;
    if (command[index + 1] === '|') return undefined;
    pipes.push(index);
  }

  return pipes;
}

function isSafeLineTruncation(command: string): boolean {
  const tokens = tokenize(command);
  const [executable, option, value] = tokens;
  if (executable !== 'head' && executable !== 'tail') return false;
  if (tokens.length === 1) return true;

  const boundedLineCount = (candidate: string | undefined): boolean =>
    candidate !== undefined && /^[1-9]\d{0,4}$/.test(candidate);

  if (tokens.length === 2) {
    return (
      (option?.startsWith('--lines=') &&
        boundedLineCount(option.slice('--lines='.length))) ||
      (option?.startsWith('-') && boundedLineCount(option.slice(1)))
    );
  }
  return (
    tokens.length === 3 &&
    (option === '-n' || option === '--lines') &&
    boundedLineCount(value)
  );
}

export function normalizeVerificationCommandForExecution(
  command: string
): string | undefined {
  const normalized = stripSafeStderrMerge(
    command.replace(SAFE_EXIT_STATUS_PROBE, '').trim()
  );
  const pipeIndexes = findUnquotedPipes(normalized);
  if (!pipeIndexes) return undefined;
  if (pipeIndexes.length === 0) return normalized;
  if (pipeIndexes.length !== 1) return undefined;

  const pipeIndex = pipeIndexes[0];
  if (pipeIndex === undefined) return undefined;
  const source = stripSafeStderrMerge(normalized.slice(0, pipeIndex).trim());
  const truncation = normalized.slice(pipeIndex + 1).trim();
  if (!source || !isSafeLineTruncation(truncation)) return undefined;
  return source;
}

export function isVerificationCommand(
  command: string,
  workspaceRoot?: string
): boolean {
  const unwrapped = normalizeVerificationCommandForExecution(command);
  if (!unwrapped) return false;
  const normalized = stripSafeEnvVars(unwrapped);
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
