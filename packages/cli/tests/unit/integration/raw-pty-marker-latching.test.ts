import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chunkUtf8PtyInput,
  createTuiPtyComposerReadyHandshake,
  createTuiPtyEnvironment,
} from '../../support/ptyInput.js';

const supportDir = path.resolve(import.meta.dirname, '../../support');
const runnerInventory = [
  'backgroundSubagentCompletionPtyRunner.ts',
  'browserToolPtyRunner.ts',
  'durableInteractionRecoveryPtyRunner.ts',
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
  'tuiTaskAttentionPtyRunner.ts',
  'weightedProviderAdmissionPtyRunner.ts',
] as const;

const promptInputRunners = [
  'browserToolPtyRunner.ts',
  'foregroundBoundedOutputPtyRunner.ts',
  'foregroundCommandHandoffPtyRunner.ts',
  'foregroundProviderRecoveryPtyRunner.ts',
  'goalFinalizationPtyRunner.ts',
  'gracefulShutdownPtyRunner.ts',
  'sessionRuntimeResidencyPtyRunner.ts',
  'tokenBudgetHandoffPtyRunner.ts',
  'toolAdmissionPtyRunner.ts',
  'tuiPtyRunner.ts',
] as const satisfies readonly (typeof runnerInventory)[number][];

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

  it.each(promptInputRunners)(
    '%s waits for the real composer and uses bounded bracketed paste',
    (fileName) => {
      const source = readRunner(fileName);

      expect(source).toContain('createTuiPtyComposerReadyHandshake');
      expect(source).toContain('handshake.marker');
      expect(source).toContain('handshake.env');
      expect(source).toContain('await writeBracketedPaste(');
      expect(source).toContain('waitFor(');
      expect(source).not.toContain('TUI_COMPOSER_MARKER');
      expect(source).not.toContain("output.includes('请输入您的问题')");
      expect(source).not.toContain('terminal.write(`\\u001B[200~');
    }
  );

  it.each([
    [
      'browserToolPtyRunner.ts',
      'await waitFor(() => output.includes(handshake.marker)',
    ],
    [
      'foregroundBoundedOutputPtyRunner.ts',
      'await waitFor(\n      () => output.includes(handshake.marker),',
    ],
    [
      'foregroundCommandHandoffPtyRunner.ts',
      'await waitFor(\n      () => output.includes(handshake.marker),',
    ],
    [
      'foregroundProviderRecoveryPtyRunner.ts',
      'waitFor(\n        () => output.includes(handshake.marker),',
    ],
    [
      'goalFinalizationPtyRunner.ts',
      'await waitFor(\n      () => sawInitial && sawCompleteGoal && output.includes(handshake.marker),',
    ],
    [
      'gracefulShutdownPtyRunner.ts',
      'waitFor(\n        () => output.includes(handshake.marker),',
    ],
    [
      'sessionRuntimeResidencyPtyRunner.ts',
      'waitFor(\n        () => output.includes(handshake.marker),',
    ],
    [
      'toolAdmissionPtyRunner.ts',
      'await waitFor(\n      () => output.includes(handshake.marker),',
    ],
    ['tuiPtyRunner.ts', 'await waitFor(() => output.includes(handshake.marker)'],
  ] as const)(
    '%s waits for the exact ready marker before writing paste',
    (fileName, markerWait) => {
      const source = readRunner(fileName);
      const markerWaitIndex = source.indexOf(markerWait);
      const pasteWriteIndex = source.indexOf('await writeBracketedPaste(');

      expect(markerWaitIndex).toBeGreaterThanOrEqual(0);
      expect(pasteWriteIndex).toBeGreaterThan(markerWaitIndex);
    }
  );

  it.each(runnerInventory)(
    '%s forces interactive rendering in its PTY child',
    (fileName) => {
      const source = readRunner(fileName);
      expect(
        source.includes('createTuiPtyEnvironment') ||
          source.includes('createTuiPtyComposerReadyHandshake')
      ).toBe(true);
    }
  );

  it('overrides inherited CI flags for interactive PTY children', () => {
    expect(
      createTuiPtyEnvironment({
        CI: '1',
        CONTINUOUS_INTEGRATION: 'true',
        PTY_TEST_MARKER: 'preserved',
      })
    ).toMatchObject({
      CI: 'false',
      CONTINUOUS_INTEGRATION: 'false',
      PTY_TEST_MARKER: 'preserved',
    });
  });

  it('creates a nonce-bound composer-ready handshake per PTY child', () => {
    const first = createTuiPtyComposerReadyHandshake({
      BASE: 'value',
    });
    const second = createTuiPtyComposerReadyHandshake({
      BASE: 'value',
    });

    expect(first.env.BASE).toBe('value');
    expect(first.env.BLADE_TUI_COMPOSER_READY_NONCE).toMatch(/^[0-9a-f]{32}$/);
    expect(second.env.BLADE_TUI_COMPOSER_READY_NONCE).toMatch(/^[0-9a-f]{32}$/);
    expect(first.env.BLADE_TUI_COMPOSER_READY_NONCE).not.toBe(
      second.env.BLADE_TUI_COMPOSER_READY_NONCE
    );
    expect(first.marker).toContain(first.env.BLADE_TUI_COMPOSER_READY_NONCE);
    expect(second.marker).toContain(second.env.BLADE_TUI_COMPOSER_READY_NONCE);
    expect(first.marker).not.toBe(second.marker);
  });

  it.each([
    ['backgroundSubagentCompletionPtyRunner.ts', 'latchPtyMarker'],
    ['browserToolPtyRunner.ts', 'latchPtyMarker'],
    [
      'durableInteractionRecoveryPtyRunner.ts',
      'new ArmedPtyMarkerLatch(input.finalMarker)',
    ],
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
    ['tuiTaskAttentionPtyRunner.ts', "new ArmedPtyMarkerLatch('[NEW]')"],
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
    expect(source).toContain('handshake.marker.length,');
    const scanIndex = source.indexOf('const scan = `${scanTail}${chunk}`;');
    const latchIndex = source.indexOf(
      'composerReady ||= scan.includes(handshake.marker);'
    );
    const composerWaitIndex = source.indexOf(
      'await waitFor(\n      () => composerReady,'
    );
    const finalMarkerLatchIndex = source.indexOf(
      'finalMarkerSeen ||= scan.includes(input.finalMarker);'
    );
    const rotateIndex = source.indexOf('scanTail = scan.slice(-(maxNeedle - 1));');
    const pasteWriteIndex = source.indexOf(
      "await writeBracketedPaste(terminal, input.prompt ?? '');"
    );

    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(latchIndex).toBeGreaterThan(scanIndex);
    expect(finalMarkerLatchIndex).toBeGreaterThan(scanIndex);
    expect(rotateIndex).toBeGreaterThan(finalMarkerLatchIndex);
    expect(composerWaitIndex).toBeGreaterThan(latchIndex);
    expect(pasteWriteIndex).toBeGreaterThan(composerWaitIndex);
    expect(source).toContain(
      'await waitFor(\n      () => finalMarkerSeen,\n      () => exited,'
    );
    expect(source).toContain('finalMarkerSeen: true,');
    expect(source).toContain(
      'classifyTokenBudgetPtyFinal(finalText, input.finalMarker)'
    );
    expect(source).toContain("if (state === 'matched') return;");
    expect(source).toContain("if (state === 'mismatched')");
    expect(source).toContain('composerReady ||= scan.includes(handshake.marker)');
    expect(source).toContain(
      "'Timed out waiting for token-budget PTY paste acknowledgement'"
    );
    const pasteAcknowledgementIndex = source.indexOf(
      "'Timed out waiting for token-budget PTY paste acknowledgement'"
    );
    const submitIndex = source.indexOf("terminal.write('\\r');");
    expect(pasteWriteIndex).toBeGreaterThanOrEqual(0);
    expect(pasteAcknowledgementIndex).toBeGreaterThan(pasteWriteIndex);
    expect(submitIndex).toBeGreaterThan(pasteAcknowledgementIndex);
    expect(source).not.toContain(
      "if (input.mode === 'task') bracketedPasteAccepted = true"
    );
    expect(source).toContain('composerFailureCode');
    expect(source).toContain('const deadline = Date.now() + input.timeoutMs - 10_000');
    expect(source).toContain('remainingStageBudget(deadline');
    expect(source).not.toContain('Date.now() - bracketedPasteModeSeenAt >= 5_000');
    expect(source).not.toContain('bracketedPasteModeSeenAt');
    expect(source).not.toContain('bracketedPasteModeSeen = true');
    expect(source).not.toContain('TUI_COMPOSER_MARKER');
    expect(source).not.toContain("composerReady ||= scan.includes('请输入您的问题')");
    expect(source).not.toContain('JSON.stringify(events).includes(input.finalMarker)');
    expect(source).not.toMatch(
      /finalMarkerSeen\s*(?:=|:)\s*(?:output|scanTail|scan|projectOutput)\b/
    );
  });

  it('chunks large PTY input without splitting UTF-8 code points', () => {
    const input = `${'a'.repeat(8)}你😀${'b'.repeat(8)}`;
    const chunks = chunkUtf8PtyInput(input, 4);

    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 4)).toBe(true);
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
