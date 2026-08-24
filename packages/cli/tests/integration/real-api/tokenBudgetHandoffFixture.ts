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
export const TOKEN_BUDGET_FINAL_COPY_INSTRUCTION =
  'FINAL_RESPONSE_CONTRACT=NEXT_LINE_ONLY; PREFIX_BYTES=0; SUFFIX_BYTES=0; ' +
  'FIRST_CHARACTER=F; FORBID_BOUNDARY_STATUS=1; FORBID_ACKNOWLEDGEMENT=1';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderTokenBudgetExactNextAction(input: { command: string }): string {
  return (
    'PRIOR_FAILED_BASH_COMPLETE; PRIOR_WRITE_COMPLETE; ' +
    'DO_NOT_REPEAT_PRIOR_ACTIONS; ' +
    `RUN_ONLY_EXACT_BASH=${JSON.stringify(input.command)}; REQUIRE_ZERO_EXIT; ` +
    'AFTER_ZERO_EXIT_COPY_FINAL_NONEMPTY_STDOUT_LINE_BYTE_FOR_BYTE_AS_ENTIRE_RESPONSE; ' +
    'FINAL_PREFIX_BYTES=0; FINAL_SUFFIX_BYTES=0; FIRST_CHARACTER=F; ' +
    'PROHIBIT_BOUNDARY_STATUS_ACKNOWLEDGEMENT_OR_COPY_NARRATION'
  );
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
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    `const targetPath = ${JSON.stringify(targetPath)};`,
    `const expected = ${JSON.stringify(targetContent)};`,
    `const failed = ${JSON.stringify(sentinels.failedVerification)};`,
    `const final = ${JSON.stringify(finalMarker)};`,
    'let actual;',
    'try {',
    "  actual = readFileSync(targetPath, 'utf8');",
    '} catch {',
    '  assert.fail(failed);',
    '}',
    'assert.equal(actual, expected, failed);',
    `process.stdout.write(${JSON.stringify(
      `${TOKEN_BUDGET_FINAL_COPY_INSTRUCTION}\n`
    )});`,
    'process.stdout.write(`${final}\\n`);',
    '',
  ].join('\n');
  await writeFile(scriptPath, script, { mode: 0o600 });

  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  const prompt = [
    'Complete this task in exactly four model boundaries and preserve every named sentinel exactly.',
    'If context compaction occurs, the following three lines are exact continuation records whose bracketed labels name their destination headings:',
    `EXACT CONTINUATION RECORD [Workspace mutations] :: ${sentinels.mutation} status=applied`,
    `EXACT CONTINUATION RECORD [Verification evidence] :: ${sentinels.failedVerification} status=failed`,
    `EXACT CONTINUATION RECORD [Exact next action] :: ${sentinels.pendingAction} status=pending`,
    'Each canonical record must appear exactly once in its named section as its own list item with no extra text on that item.',
    'The exact-next-action execution record must also appear exactly once as its own list item and be followed literally after compaction.',
    'Boundary 1: call Bash exactly once with the following verification command. It must fail; do not call any other tool in this boundary:',
    command,
    'Boundary 2: after observing that failure, call Write exactly once with the following exact file path and exact content; do not call any other tool in this boundary:',
    `file_path=${JSON.stringify(targetPath)}`,
    `content=${JSON.stringify(targetContent)}`,
    `Boundary 3 is the post-compaction pending action ${sentinels.pendingAction}: call Bash exactly once with the following verification command, require it to pass, and call no other tool in this boundary:`,
    command,
    `EXACT CONTINUATION RECORD [Exact next action] :: ${renderTokenBudgetExactNextAction(
      { command }
    )}`,
    'Boundary 4: call no tools. Emit exactly the final non-empty stdout line from the successful Bash as the complete assistant content.',
    'The first assistant character must be F and the last character must be the final marker character; prefix and suffix byte counts must both be zero.',
    'Do not emit any boundary status, acknowledgement, verification summary, copying narration, quotation, code fence, or blank line.',
    'The final response value is intentionally absent from this prompt and must not be guessed.',
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
