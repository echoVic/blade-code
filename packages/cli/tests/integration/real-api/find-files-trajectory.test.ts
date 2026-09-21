import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import {
  type HeadlessJsonlEvent,
  HeadlessJsonlEventSchema,
} from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  isReleaseMatrix,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

// DeepSeek only exercises Flash for this trajectory; the release matrix still
// requires the full Flash/Pro credential matrix but runs Flash alone here.
const modelConfigs = isRealApiTestEnabled()
  ? isReleaseMatrix()
    ? resolveRequiredDeepSeekQualificationModels().filter(
        (config) => config.model === 'deepseek-flash'
      )
    : expandDeepSeekModelMatrix(
        getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
      ).filter((config) => config.model === 'deepseek-flash')
  : [];
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

function finalContentAfterLastRead(events: readonly HeadlessJsonlEvent[]): string {
  const lastReadResult = events.findLastIndex(
    (event) => event.type === 'tool_result' && event.tool_name === 'Read'
  );
  return events
    .slice(lastReadResult + 1)
    .filter((event) => event.type === 'content_delta')
    .map((event) => event.delta)
    .join('')
    .trim();
}

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe
  .skipIf(!enabled)
  .sequential('FindFiles production trajectory (real API)', () => {
    for (const modelConfig of modelConfigs) {
      it(`${modelConfig.model} fuzzy-finds and reads an unknown file path`, async () => {
        const workspace = await mkdtemp(
          path.join(os.tmpdir(), 'blade-find-files-api-')
        );
        const marker = 'FILENAME_INDEX_REAL_API_OK_7C91';
        let output = '';
        let errorOutput = '';

        try {
          process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
          getState().config.actions.setConfig({
            ...buildRealApiRuntimeConfig(modelConfig),
            permissionMode: PermissionMode.YOLO,
          });
          await mkdir(path.join(workspace, 'src', 'runtime'), { recursive: true });
          await writeFile(
            path.join(workspace, 'src', 'runtime', 'SessionRuntimeLedger.ts'),
            `marker=${marker}\n`
          );

          const exitCode = await runWithCwdOverride(workspace, () =>
            runHeadless(
              {
                headless: true,
                outputFormat: 'jsonl',
                maxTurns: 6,
                taskIsolation: 'local',
                verificationAgent: false,
                allowedTools: ['FindFiles', 'Read'],
                appendSystemPrompt:
                  'This is a strict file-discovery check. Your first tool call must ' +
                  'be FindFiles with the exact query "sessonruntime". Then call Read ' +
                  'using the path returned by FindFiles. Do not guess the path. After ' +
                  'reading the file, reply with only the exact value after "marker=".',
                message:
                  'I only remember the approximate file name "sessonruntime". Find ' +
                  'that file and return the marker stored inside it.',
              },
              {
                stdout: {
                  write(chunk: string) {
                    output += chunk;
                    return true;
                  },
                },
                stderr: {
                  write(chunk: string) {
                    errorOutput += chunk;
                    return true;
                  },
                },
              }
            )
          );
          const events = output
            .split('\n')
            .filter(Boolean)
            .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          const toolStarts = events.filter((event) => event.type === 'tool_start');
          const toolResults = events.filter((event) => event.type === 'tool_result');
          const findFilesIndex = toolStarts.findIndex(
            (event) => event.tool_name === 'FindFiles'
          );
          const readIndex = toolStarts.findIndex((event) => event.tool_name === 'Read');

          expect(
            exitCode,
            errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')
          ).toBe(0);
          expect(findFilesIndex).toBe(0);
          expect(readIndex).toBeGreaterThan(findFilesIndex);
          expect(toolStarts[findFilesIndex]).toMatchObject({
            tool_name: 'FindFiles',
            target: 'sessonruntime',
          });
          expect(toolStarts[readIndex]?.target).toMatch(
            /src\/runtime\/SessionRuntimeLedger\.ts$/
          );
          expect(toolResults).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_result',
                tool_name: 'FindFiles',
                success: true,
              }),
              expect.objectContaining({
                type: 'tool_result',
                tool_name: 'Read',
                success: true,
              }),
            ])
          );
          expect(finalContentAfterLastRead(events)).toBe(marker);
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'phase',
                phase: 'completed',
                status: 'done',
              }),
            ])
          );
          expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }, 180_000);
    }
  });
