import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TokenBudgetHandoffFixture {
  workspace: string;
  failingCommand: string;
  passingCommand: string;
  targetPath: string;
  targetContent: string;
  prompt: string;
  finalMarker: string;
  sentinels: {
    mutation: string;
    failedVerification: string;
    pendingAction: string;
  };
}

const NONCE_PATTERN = /^[A-Za-z0-9_]{16,64}$/;
const SENTINEL_PATTERN = /^[A-Za-z0-9_]{16,80}$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSentinel(value: string, name: string): void {
  if (!SENTINEL_PATTERN.test(value)) {
    throw new Error(`Token-budget handoff ${name} sentinel is invalid`);
  }
}

async function assertTargetAbsent(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw new Error('Token-budget handoff fixture could not inspect target path', {
      cause: error,
    });
  }
  throw new Error(`Token-budget handoff fixture target already exists: ${targetPath}`);
}

export async function createTokenBudgetHandoffFixture(
  workspace: string,
  nonce: string
): Promise<TokenBudgetHandoffFixture> {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Token-budget handoff fixture nonce is invalid');
  }

  const sentinels = {
    mutation: `MUTATION_${nonce}`,
    failedVerification: `FAILED_${nonce}`,
    pendingAction: `PENDING_${nonce}`,
  };
  const finalMarker = `FINAL_OK_${nonce}`;
  assertSentinel(sentinels.mutation, 'mutation');
  assertSentinel(sentinels.failedVerification, 'failed verification');
  assertSentinel(sentinels.pendingAction, 'pending action');
  assertSentinel(finalMarker, 'final marker');

  const targetPath = path.join(workspace, 'src', 'status.txt');
  const scriptPath = path.join(workspace, 'test.mjs');
  const targetContent = sentinels.mutation;

  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertTargetAbsent(targetPath);
  const script = [
    "import { readFileSync } from 'node:fs';",
    `const targetPath = ${JSON.stringify(targetPath)};`,
    `const expected = ${JSON.stringify(targetContent)};`,
    `const failed = ${JSON.stringify(sentinels.failedVerification)};`,
    'let actual;',
    'try {',
    "  actual = readFileSync(targetPath, 'utf8');",
    '} catch {',
    '  process.stderr.write(failed);',
    '  process.exit(1);',
    '}',
    'if (actual !== expected) {',
    '  process.stderr.write(failed);',
    '  process.exit(1);',
    '}',
    'process.stdout.write(expected);',
    '',
  ].join('\n');
  await writeFile(scriptPath, script, { mode: 0o600 });

  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  const midpoint = Math.floor(finalMarker.length / 2);
  const finalMarkerFirstHalf = finalMarker.slice(0, midpoint);
  const finalMarkerSecondHalf = finalMarker.slice(midpoint);
  const prompt = [
    'Complete this task in exactly four model boundaries and preserve every named sentinel exactly.',
    'Boundary 1: call Bash exactly once with the following command. It must fail; do not call any other tool in this boundary:',
    command,
    'Boundary 2: after observing that failure, call Write exactly once with the following exact file path and exact content; do not call any other tool in this boundary:',
    `file_path=${JSON.stringify(targetPath)}`,
    `content=${JSON.stringify(targetContent)}`,
    `Boundary 3 is the post-compaction pending action ${sentinels.pendingAction}: call Bash exactly once with the following command, require it to pass, and call no other tool in this boundary:`,
    command,
    'Boundary 4: after the passing result, call no tools. Reply with only the string formed by concatenating these two JSON-quoted halves in order with no separator:',
    JSON.stringify(finalMarkerFirstHalf),
    JSON.stringify(finalMarkerSecondHalf),
  ].join('\n');

  if (prompt.includes(finalMarker)) {
    throw new Error('Token-budget handoff final marker contaminated the prompt');
  }

  return {
    workspace,
    failingCommand: command,
    passingCommand: command,
    targetPath,
    targetContent,
    prompt,
    finalMarker,
    sentinels,
  };
}
