import type { ChatCompletionMessageToolCall } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';

export const ACTION_STATIONARITY_NUDGE_THRESHOLD = 8;
export const ACTION_STATIONARITY_HALT_THRESHOLD = 16;

interface ActionStationarityState {
  actionSignature?: string;
  progressSignature?: string;
  toolName?: string;
  progressAware: boolean;
  runLength: number;
  nudged: boolean;
}

export interface ActionStationarityDetector {
  state: ActionStationarityState;
}

export interface ActionStationarityEvent {
  phase: 'detected' | 'recovered' | 'halted';
  toolName: string;
  runLength: number;
  nudgeThreshold: number;
  haltThreshold: number;
  progressAware: boolean;
}

export function createActionStationarityDetector(): ActionStationarityDetector {
  return {
    state: {
      runLength: 0,
      nudged: false,
      progressAware: false,
    },
  };
}

export function observeActionStationarity(
  detector: ActionStationarityDetector,
  toolCalls: readonly ChatCompletionMessageToolCall[],
  results: readonly ToolResult[]
): ActionStationarityEvent | undefined {
  if (toolCalls.length === 0) {
    const previous = detector.state;
    const recovered = previous.nudged
      ? {
          phase: 'recovered' as const,
          toolName: previous.toolName ?? 'tool action',
          runLength: previous.runLength,
          nudgeThreshold: ACTION_STATIONARITY_NUDGE_THRESHOLD,
          haltThreshold: ACTION_STATIONARITY_HALT_THRESHOLD,
          progressAware: previous.progressAware,
        }
      : undefined;
    resetActionStationarity(detector);
    return recovered;
  }

  const actionSignature = buildActionSignature(toolCalls);
  const progressSignature = buildProgressSignature(toolCalls, results);
  const toolName =
    toolCalls.length === 1
      ? toolCalls[0]!.function.name
      : `${toolCalls.length}-tool batch`;
  const previous = detector.state;
  const sameAction = previous.actionSignature === actionSignature;
  const madeProgress =
    progressSignature !== undefined &&
    previous.progressSignature !== undefined &&
    previous.progressSignature !== progressSignature;
  const recovered = previous.nudged && (!sameAction || madeProgress);

  if (!sameAction || madeProgress) {
    detector.state = {
      actionSignature,
      progressSignature,
      toolName,
      progressAware: progressSignature !== undefined,
      runLength: 1,
      nudged: false,
    };
  } else {
    detector.state = {
      actionSignature,
      progressSignature,
      toolName,
      progressAware: progressSignature !== undefined,
      runLength: previous.runLength + 1,
      nudged: previous.nudged,
    };
  }

  const state = detector.state;
  const base = {
    toolName,
    runLength: state.runLength,
    nudgeThreshold: ACTION_STATIONARITY_NUDGE_THRESHOLD,
    haltThreshold: ACTION_STATIONARITY_HALT_THRESHOLD,
    progressAware: progressSignature !== undefined,
  };

  if (state.runLength >= ACTION_STATIONARITY_HALT_THRESHOLD) {
    return { phase: 'halted', ...base };
  }
  if (state.runLength >= ACTION_STATIONARITY_NUDGE_THRESHOLD && !state.nudged) {
    state.nudged = true;
    return { phase: 'detected', ...base };
  }
  if (recovered) {
    return { phase: 'recovered', ...base };
  }
  return undefined;
}

export function resetActionStationarity(detector: ActionStationarityDetector): void {
  detector.state = {
    runLength: 0,
    nudged: false,
    progressAware: false,
  };
}

export function getActionStationarityPrompt(event: ActionStationarityEvent): string {
  return (
    `You have repeated ${event.toolName} without observable progress ` +
    `${event.runLength} times. Stop repeating this call and change strategy. ` +
    'For a long-running task, use one blocking TaskOutput wait with a meaningful ' +
    'timeout, then do independent work or report what you are waiting for. ' +
    'The turn will halt if the same action continues without progress.'
  );
}

function buildActionSignature(
  toolCalls: readonly ChatCompletionMessageToolCall[]
): string {
  return toolCalls
    .map((toolCall) => {
      const name = toolCall.function.name;
      const parsed = parseArguments(toolCall.function.arguments);
      const args =
        name === 'TaskOutput' && parsed && typeof parsed.task_id === 'string'
          ? { task_id: parsed.task_id }
          : parsed;
      return `${name}\u001f${stableSerialize(args ?? toolCall.function.arguments)}`;
    })
    .join('\u001e');
}

function buildProgressSignature(
  toolCalls: readonly ChatCompletionMessageToolCall[],
  results: readonly ToolResult[]
): string | undefined {
  if (
    toolCalls.length !== results.length ||
    toolCalls.some((toolCall) => toolCall.function.name !== 'TaskOutput')
  ) {
    return undefined;
  }

  const signatures = results.map(taskOutputProgressSignature);
  return signatures.every((signature) => signature !== undefined)
    ? signatures.join('\u001e')
    : undefined;
}

function taskOutputProgressSignature(result: ToolResult): string | undefined {
  if (!result.success) return undefined;
  const payload = asRecord(result.llmContent);
  if (!payload) return undefined;

  const taskId = stringField(payload, 'task_id');
  const status = stringField(payload, 'status');
  if (!taskId || !status) return undefined;

  return stableSerialize({
    task_id: taskId,
    type: stringField(payload, 'type'),
    status,
    exit_code: payload.exit_code ?? null,
    signal: payload.signal ?? null,
    finished_at: payload.finished_at ?? null,
    completed_at: payload.completed_at ?? null,
    raw_output_bytes: numberField(payload, 'raw_output_bytes'),
    progress_updated_at: numberField(payload, 'progress_updated_at'),
    has_result: payload.result !== undefined,
    error: payload.error ?? null,
  });
}

function parseArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
