import { describe, expect, it } from 'vitest';
import {
  ACTION_STATIONARITY_HALT_THRESHOLD,
  ACTION_STATIONARITY_NUDGE_THRESHOLD,
  createActionStationarityDetector,
  observeActionStationarity,
} from '../../../../src/agent/loop/actionStationarity.js';
import type { ChatCompletionMessageToolCall } from '../../../../src/services/ChatServiceInterface.js';
import type { ToolResult } from '../../../../src/tools/types/index.js';

function call(
  name: string,
  args: Record<string, unknown>,
  id = `${name}-call`
): ChatCompletionMessageToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function taskOutput(overrides: Record<string, unknown> = {}): ToolResult {
  return {
    success: true,
    llmContent: {
      task_id: 'bash-test',
      type: 'shell',
      status: 'running',
      raw_output_bytes: 0,
      ...overrides,
    },
  };
}

describe('action stationarity detector', () => {
  it('nudges once and then halts an identical action run', () => {
    const detector = createActionStationarityDetector();
    const toolCall = call('Read', { file_path: 'src/index.ts' });
    let event;

    for (let run = 1; run <= ACTION_STATIONARITY_HALT_THRESHOLD; run++) {
      event = observeActionStationarity(
        detector,
        [toolCall],
        [{ success: true, llmContent: 'same file' }]
      );
      if (run === ACTION_STATIONARITY_NUDGE_THRESHOLD) {
        expect(event).toMatchObject({
          phase: 'detected',
          toolName: 'Read',
          runLength: ACTION_STATIONARITY_NUDGE_THRESHOLD,
          progressAware: false,
        });
      } else if (run < ACTION_STATIONARITY_HALT_THRESHOLD) {
        expect(event).toBeUndefined();
      }
    }

    expect(event).toMatchObject({
      phase: 'halted',
      runLength: ACTION_STATIONARITY_HALT_THRESHOLD,
    });
  });

  it('ignores TaskOutput timeout changes when the task makes no progress', () => {
    const detector = createActionStationarityDetector();
    let event;

    for (let run = 1; run <= ACTION_STATIONARITY_NUDGE_THRESHOLD; run++) {
      event = observeActionStationarity(
        detector,
        [
          call('TaskOutput', {
            task_id: 'bash-test',
            block: run % 2 === 0,
            timeout: run * 1_000,
          }),
        ],
        [taskOutput()]
      );
    }

    expect(event).toMatchObject({
      phase: 'detected',
      toolName: 'TaskOutput',
      progressAware: true,
    });
  });

  it('resets a warned TaskOutput run when raw output grows', () => {
    const detector = createActionStationarityDetector();
    const toolCall = call('TaskOutput', {
      task_id: 'bash-test',
      block: true,
      timeout: 30_000,
    });

    for (let run = 1; run <= ACTION_STATIONARITY_NUDGE_THRESHOLD; run++) {
      observeActionStationarity(detector, [toolCall], [taskOutput()]);
    }

    expect(
      observeActionStationarity(
        detector,
        [toolCall],
        [taskOutput({ raw_output_bytes: 128 })]
      )
    ).toMatchObject({
      phase: 'recovered',
      runLength: 1,
      progressAware: true,
    });
  });

  it('emits recovery when a warned run stops calling tools', () => {
    const detector = createActionStationarityDetector();
    const toolCall = call('TaskOutput', {
      task_id: 'bash-test',
      block: true,
      timeout: 30_000,
    });

    for (let run = 1; run <= ACTION_STATIONARITY_NUDGE_THRESHOLD; run++) {
      observeActionStationarity(detector, [toolCall], [taskOutput()]);
    }

    expect(observeActionStationarity(detector, [], [])).toMatchObject({
      phase: 'recovered',
      toolName: 'TaskOutput',
      runLength: ACTION_STATIONARITY_NUDGE_THRESHOLD,
      progressAware: true,
    });
    expect(observeActionStationarity(detector, [], [])).toBeUndefined();
  });

  it('treats semantically equal JSON argument objects as one action', () => {
    const detector = createActionStationarityDetector();
    const first = call('Grep', { pattern: 'todo', path: 'src' });
    const reordered: ChatCompletionMessageToolCall = {
      ...first,
      id: 'grep-reordered',
      function: {
        name: 'Grep',
        arguments: '{"path":"src","pattern":"todo"}',
      },
    };

    observeActionStationarity(
      detector,
      [first],
      [{ success: true, llmContent: 'same' }]
    );
    for (let run = 2; run <= ACTION_STATIONARITY_NUDGE_THRESHOLD; run++) {
      const event = observeActionStationarity(
        detector,
        [reordered],
        [{ success: true, llmContent: 'same' }]
      );
      if (run === ACTION_STATIONARITY_NUDGE_THRESHOLD) {
        expect(event?.phase).toBe('detected');
      }
    }
  });
});
