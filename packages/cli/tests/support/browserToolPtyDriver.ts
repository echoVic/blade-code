import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserToolFixture } from '../integration/real-api/browser-tool-fixture.js';

const execFileAsync = promisify(execFile);

export interface BrowserToolPtyEvidence {
  success: true;
  sawExpected: true;
  output: string;
}

export async function runBrowserToolPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  fixture: BrowserToolFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<BrowserToolPtyEvidence> {
  const runner = path.resolve(import.meta.dirname, 'browserToolPtyRunner.ts');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_BROWSER_TOOL_PTY_CLI_ENTRY: cliEntry,
      BLADE_BROWSER_TOOL_PTY_WORKSPACE: input.workspace,
      BLADE_BROWSER_TOOL_PTY_PROMPT: input.fixture.prompt,
      BLADE_BROWSER_TOOL_PTY_EXPECTED: input.fixture.finalMarker,
      BLADE_BROWSER_TOOL_PTY_SESSION_ID: input.sessionId,
      BLADE_BROWSER_TOOL_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const result = await execFileAsync('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env,
    timeout: input.timeoutMs ?? 270_000,
    maxBuffer: 128 * 1024,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (
    parsed.success !== true ||
    parsed.sawExpected !== true ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Browser Tool PTY evidence is incomplete: ${String(
        parsed.error ?? parsed.output ?? 'unknown'
      )}`
    );
  }
  if (parsed.output.includes(input.secret)) {
    throw new Error('Browser Tool PTY evidence contains Provider credentials');
  }
  return parsed as unknown as BrowserToolPtyEvidence;
}
