import { runHeadless } from '../../src/commands/headless.js';
import { PermissionMode } from '../../src/config/types.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { BrowserToolFixture } from '../integration/real-api/browser-tool-fixture.js';

export interface BrowserToolHeadlessEvidence {
  sessionId: string;
  exitCode: number;
  markerVisible: true;
  output: string;
}

function sink() {
  let output = '';
  return {
    write(chunk: string) {
      output = `${output}${chunk}`.slice(-64_000);
      return true;
    },
    output: () => output,
  };
}

function assistantText(output: string): string {
  return output
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as {
          type?: unknown;
          delta?: unknown;
        };
        return event.type === 'content_delta' && typeof event.delta === 'string'
          ? [event.delta]
          : [];
      } catch {
        return [];
      }
    })
    .join('');
}

export async function runBrowserToolHeadlessDriver(input: {
  workspace: string;
  sessionId: string;
  fixture: BrowserToolFixture;
}): Promise<BrowserToolHeadlessEvidence> {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await runWithCwdOverride(input.workspace, () =>
    runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: input.fixture.prompt,
        sessionId: input.sessionId,
        permissionMode: PermissionMode.YOLO,
        allowedTools: [
          'ToolSearch',
          'BrowserNavigate',
          'BrowserSnapshot',
          'BrowserInteract',
          'BrowserWait',
          'BrowserInspect',
          'BrowserPage',
        ],
        verificationAgent: false,
        maxTurns: 30,
      },
      { stdout, stderr }
    )
  );
  const output = `${stdout.output()}\n${stderr.output()}`;
  const finalText = assistantText(stdout.output());
  if (exitCode !== 0 || !finalText.includes(input.fixture.finalMarker)) {
    throw new Error(
      `Headless Browser Tool evidence is incomplete: ${JSON.stringify({
        exitCode,
        finalText,
        output: output.slice(-4_000),
      })}`
    );
  }
  return {
    sessionId: input.sessionId,
    exitCode,
    markerVisible: true,
    output,
  };
}
