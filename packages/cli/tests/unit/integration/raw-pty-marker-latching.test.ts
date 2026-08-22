import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const supportDir = path.resolve(import.meta.dirname, '../../support');
const runnerInventory = [
  'backgroundSubagentCompletionPtyRunner.ts',
  'foregroundBoundedOutputPtyRunner.ts',
  'foregroundCommandHandoffPtyRunner.ts',
  'foregroundProviderRecoveryPtyRunner.ts',
  'goalFinalizationPtyRunner.ts',
  'gracefulShutdownPtyRunner.ts',
  'promptCacheStatusPtyRunner.ts',
  'rootTurnAutoResumePtyRunner.ts',
  'sessionRuntimeResidencyPtyRunner.ts',
  'subagentResultAdoptionPtyRunner.ts',
  'tokenBudgetHandoffPtyRunner.ts',
  'toolAdmissionPtyRunner.ts',
  'tuiPtyRunner.ts',
  'weightedProviderAdmissionPtyRunner.ts',
] as const;

function readRunner(fileName: (typeof runnerInventory)[number]): string {
  return readFileSync(path.join(supportDir, fileName), 'utf8');
}

describe('raw PTY marker latching source contract', () => {
  it('requires every production PTY runner to be explicitly inventoried', () => {
    const actual = readdirSync(supportDir)
      .filter((fileName) => /PtyRunner\.ts$/.test(fileName))
      .sort();

    expect(actual).toEqual([...runnerInventory]);
  });

  it.each([
    ['backgroundSubagentCompletionPtyRunner.ts', 'latchPtyMarker'],
    ['foregroundBoundedOutputPtyRunner.ts', 'latchForegroundBoundedPtyMarkers'],
    [
      'foregroundCommandHandoffPtyRunner.ts',
      'new ArmedPtyMarkerLatch(input.fixture.marker)',
    ],
    ['foregroundProviderRecoveryPtyRunner.ts', 'new ArmedPtyMarkerLatch(input.marker)'],
    ['goalFinalizationPtyRunner.ts', 'latchPtyMarker'],
    ['promptCacheStatusPtyRunner.ts', 'latchPtyMarker'],
    ['rootTurnAutoResumePtyRunner.ts', 'latchPtyMarker'],
    ['subagentResultAdoptionPtyRunner.ts', 'latchPtyMarker'],
    [
      'tokenBudgetHandoffPtyRunner.ts',
      'finalMarkerSeen ||= scan.includes(input.finalMarker)',
    ],
    ['toolAdmissionPtyRunner.ts', 'new ArmedPtyMarkerLatch(input.marker)'],
    ['tuiPtyRunner.ts', 'latchPtyMarker'],
    ['weightedProviderAdmissionPtyRunner.ts', 'latchPtyEvidence'],
  ] as const)('%s latches positive marker evidence', (fileName, latchName) => {
    expect(readRunner(fileName)).toContain(latchName);
  });

  it('does not derive completed evidence from a rotatable terminal tail', () => {
    const forbidden = [
      'sawChildMarker: output.includes',
      'sawParentFinal: output.includes',
      'sawInitial: output.includes',
      "sawCompleteGoal: output.includes('goal:complete')",
      'sawFollowup: output.includes',
      'sawChild: output.includes',
      'sawParent: output.includes',
      'sawExpected: output.includes',
      'parentFinalVisible: output.includes',
      'finalMarkerSeen = output.includes',
      'finalMarkerSeen: output.includes',
    ];
    const sources = runnerInventory.map(readRunner).join('\n');

    for (const pattern of forbidden) {
      expect(sources).not.toContain(pattern);
    }
  });

  it('latches token-budget completion across raw PTY chunk boundaries', () => {
    const source = readRunner('tokenBudgetHandoffPtyRunner.ts');

    expect(source).toContain('input.finalMarker.length,');
    const scanIndex = source.indexOf('const scan = `${scanTail}${chunk}`;');
    const latchIndex = source.indexOf(
      'finalMarkerSeen ||= scan.includes(input.finalMarker);'
    );
    const rotateIndex = source.indexOf('scanTail = scan.slice(-(maxNeedle - 1));');

    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(latchIndex).toBeGreaterThan(scanIndex);
    expect(rotateIndex).toBeGreaterThan(latchIndex);
    expect(source).toContain(
      'await waitFor(\n      () => finalMarkerSeen,\n      () => exited,'
    );
    expect(source).toContain('finalMarkerSeen: true,');
    expect(source).toContain(
      'classifyTokenBudgetPtyFinal(finalText, input.finalMarker)'
    );
    expect(source).toContain("if (state === 'matched') return;");
    expect(source).toContain("if (state === 'mismatched')");
    expect(source).toContain("composerReady ||= scan.includes('输入命令...')");
    expect(source).toContain('composerFailureCode');
    expect(source).toContain('const deadline = Date.now() + input.timeoutMs - 10_000');
    expect(source).toContain('remainingStageBudget(deadline');
    expect(source).not.toContain("composerReady ||= scan.includes('请输入您的问题')");
    expect(source).not.toContain('JSON.stringify(events).includes(input.finalMarker)');
    expect(source).not.toMatch(
      /finalMarkerSeen\s*(?:=|:)\s*(?:output|scanTail|scan|projectOutput)\b/
    );
  });

  it.each([
    ['foregroundCommandHandoffPtyRunner.ts', 'input.fixture.prompt'],
    ['foregroundProviderRecoveryPtyRunner.ts', 'input.prompt'],
    ['toolAdmissionPtyRunner.ts', 'input.prompt'],
  ] as const)('%s arms a prompt-isolated final marker latch', (fileName, prompt) => {
    const source = readRunner(fileName);

    expect(source).toContain(`${prompt}.includes(`);
    expect(source).toContain('finalMarkerLatch.arm();');
    expect(source).toContain('finalMarkerLatch.observe(chunk);');
    expect(source).toContain('() => finalMarkerLatch.seen');
    expect(source).toContain('finalMarkerSeen: finalMarkerLatch.seen');
  });

  it('does not use bounded output coordinates for Provider recovery completion', () => {
    const source = readRunner('foregroundProviderRecoveryPtyRunner.ts');

    expect(source).not.toContain('recoveryBoundary');
    expect(source).not.toContain('output.slice(');
  });

  it.each([
    'foregroundCommandHandoffPtyRunner.ts',
    'foregroundProviderRecoveryPtyRunner.ts',
    'toolAdmissionPtyRunner.ts',
  ] as const)('%s cancels its graceful-exit deadline', (fileName) => {
    expect(readRunner(fileName)).toContain('waitForPtyExit(');
  });

  it('gives background completion stages one shared evidence deadline', () => {
    const source = readRunner('backgroundSubagentCompletionPtyRunner.ts');

    expect(source).toContain('const evidenceDeadline = Date.now() + 270_000');
    expect(source).not.toContain(
      "'Raw PTY did not render Provider admission queue',\n      60_000"
    );
  });
});
