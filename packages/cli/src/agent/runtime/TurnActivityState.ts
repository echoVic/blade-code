import { nanoid } from 'nanoid';
import {
  normalizeTurnActivityToolName,
  TURN_ACTIVITY_ACTIVE_TOOL_LIMIT,
  type TurnActivityProjection,
  TurnActivityProjectionSchema,
  type TurnActivitySnapshot,
  type TurnActivityTool,
} from '../../api/turnActivitySchemas.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../services/StructuredOutputService.js';
import type { LoopEvent, ToolKindStr } from '../loop/types.js';

const MAX_ACTIVITY_COUNTER = 1_000_000;

export interface TurnActivityGeneration {
  readonly id: string;
}

interface TurnActivityStateOptions {
  now?: () => number;
  createGenerationId?: () => string;
}

interface PrivateActiveTool extends TurnActivityTool {
  id: string;
}

interface PrivateActivityState {
  phase: TurnActivitySnapshot['phase'];
  startedAt: number;
  updatedAt: number;
  turn: number;
  maxTurns: number | null;
  outputStarted: boolean;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  activeTools: PrivateActiveTool[];
}

function cloneProjection(projection: TurnActivityProjection): TurnActivityProjection {
  return structuredClone(projection);
}

function incrementCounter(value: number): number {
  return Math.min(MAX_ACTIVITY_COUNTER, value + 1);
}

function publicTool(tool: PrivateActiveTool): TurnActivityTool {
  return {
    name: tool.name,
    ...(tool.kind ? { kind: tool.kind } : {}),
    startedAt: tool.startedAt,
    ...(tool.progress !== undefined && tool.total !== undefined
      ? { progress: tool.progress, total: tool.total }
      : {}),
  };
}

function publicSnapshot(state: PrivateActivityState): TurnActivitySnapshot {
  return {
    phase: state.phase,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    turn: state.turn,
    maxTurns: state.maxTurns,
    outputStarted: state.outputStarted,
    toolCallsStarted: state.toolCallsStarted,
    toolCallsCompleted: state.toolCallsCompleted,
    activeTools: state.activeTools
      .slice(0, TURN_ACTIVITY_ACTIVE_TOOL_LIMIT)
      .map(publicTool),
    activeToolOverflow: Math.max(
      0,
      state.activeTools.length - TURN_ACTIVITY_ACTIVE_TOOL_LIMIT
    ),
  };
}

function toolIdentity(
  event: Extract<LoopEvent, { kind: 'tool_start' | 'tool_progress' | 'tool_result' }>
): { id: string; name: string } | undefined {
  if (!('function' in event.toolCall)) return undefined;
  if (event.toolCall.function.name === STRUCTURED_OUTPUT_TOOL_NAME) return undefined;
  try {
    return {
      id: event.toolCall.id,
      name: normalizeTurnActivityToolName(event.toolCall.function.name),
    };
  } catch {
    return undefined;
  }
}

function validProgress(
  progress: number | undefined,
  total: number | undefined
): { progress: number; total: number } | undefined {
  if (progress === undefined && total === undefined) return undefined;
  if (
    progress === undefined ||
    total === undefined ||
    !Number.isSafeInteger(progress) ||
    !Number.isSafeInteger(total) ||
    progress < 0 ||
    total < 0 ||
    progress > total ||
    progress > MAX_ACTIVITY_COUNTER ||
    total > MAX_ACTIVITY_COUNTER
  ) {
    return undefined;
  }
  return { progress, total };
}

export class TurnActivityState {
  private readonly now: () => number;
  private readonly createGenerationId: () => string;
  private generation = '';
  private revision = 0;
  private state?: PrivateActivityState;
  private projection?: TurnActivityProjection;

  constructor(options: TurnActivityStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createGenerationId = options.createGenerationId ?? (() => nanoid(16));
  }

  begin(): TurnActivityGeneration {
    const now = this.now();
    this.generation = this.createGenerationId();
    this.revision = 0;
    this.state = {
      phase: 'starting',
      startedAt: now,
      updatedAt: now,
      turn: 0,
      maxTurns: null,
      outputStarted: false,
      toolCallsStarted: 0,
      toolCallsCompleted: 0,
      activeTools: [],
    };
    this.projection = this.parse({
      version: 1,
      generation: this.generation,
      revision: 0,
      snapshot: publicSnapshot(this.state),
    });
    return Object.freeze({ id: this.generation });
  }

  observe(
    generation: TurnActivityGeneration,
    event: LoopEvent
  ): TurnActivityProjection | undefined {
    if (!this.isCurrent(generation) || !this.state) return undefined;

    switch (event.kind) {
      case 'turn_start':
        return this.mutate(() => {
          this.state!.phase = 'thinking';
          this.state!.turn = Math.max(0, Math.min(MAX_ACTIVITY_COUNTER, event.turn));
          this.state!.maxTurns =
            event.maxTurns < 0
              ? null
              : Math.max(0, Math.min(MAX_ACTIVITY_COUNTER, event.maxTurns));
          return true;
        });
      case 'thinking_delta':
        if (event.delta.length === 0) return undefined;
        return this.mutate(() => {
          this.state!.phase = 'thinking';
          this.state!.outputStarted = true;
          return true;
        });
      case 'content_delta':
        if (event.delta.length === 0) return undefined;
        return this.mutate(() => {
          this.state!.phase = 'responding';
          this.state!.outputStarted = true;
          return true;
        });
      case 'structured_output':
        return this.mutate(() => {
          this.state!.phase = 'responding';
          this.state!.outputStarted = true;
          return true;
        });
      case 'tool_start': {
        const identity = toolIdentity(event);
        if (
          !identity ||
          this.state.activeTools.some((tool) => tool.id === identity.id)
        ) {
          return undefined;
        }
        return this.mutate(() => {
          this.state!.phase = 'executing_tools';
          this.state!.toolCallsStarted = incrementCounter(this.state!.toolCallsStarted);
          this.state!.activeTools.push({
            ...identity,
            ...(event.toolKind ? { kind: event.toolKind as ToolKindStr } : {}),
            startedAt: this.now(),
          });
          return true;
        });
      }
      case 'tool_progress': {
        const identity = toolIdentity(event);
        if (!identity) return undefined;
        const progress = validProgress(event.update.progress, event.update.total);
        if (!progress) return undefined;
        const active = this.state.activeTools.find((tool) => tool.id === identity.id);
        if (
          !active ||
          (active.progress === progress.progress && active.total === progress.total)
        ) {
          return undefined;
        }
        return this.mutate(() => {
          active.progress = progress.progress;
          active.total = progress.total;
          return true;
        });
      }
      case 'tool_result': {
        const identity = toolIdentity(event);
        if (!identity) return undefined;
        const index = this.state.activeTools.findIndex(
          (tool) => tool.id === identity.id
        );
        if (index < 0) return undefined;
        return this.mutate(() => {
          this.state!.activeTools.splice(index, 1);
          this.state!.toolCallsCompleted = incrementCounter(
            this.state!.toolCallsCompleted
          );
          this.state!.phase =
            this.state!.activeTools.length > 0 ? 'executing_tools' : 'continuing';
          return true;
        });
      }
      case 'compaction':
        return this.mutate(() => {
          this.state!.phase = event.phase === 'start' ? 'compacting' : 'thinking';
          return true;
        });
      case 'follow_up_started':
      case 'goal_continuation_started':
        return this.mutate(() => {
          this.state!.phase = 'continuing';
          return true;
        });
      default:
        return undefined;
    }
  }

  clear(generation: TurnActivityGeneration): TurnActivityProjection | undefined {
    if (
      !this.isCurrent(generation) ||
      !this.state ||
      this.projection?.snapshot === null
    ) {
      return undefined;
    }
    this.state = undefined;
    const projection = this.commit(null);
    this.generation = '';
    return projection;
  }

  snapshot(): TurnActivityProjection {
    if (!this.projection) {
      const generation = this.begin();
      if (generation.id !== this.generation) {
        throw new Error('Turn activity generation initialization failed');
      }
    }
    return cloneProjection(this.projection as TurnActivityProjection);
  }

  private mutate(operation: () => boolean): TurnActivityProjection | undefined {
    if (!this.state) return undefined;
    const before = JSON.stringify({ ...publicSnapshot(this.state), updatedAt: 0 });
    if (!operation() || !this.state) return undefined;
    const after = JSON.stringify({ ...publicSnapshot(this.state), updatedAt: 0 });
    if (before === after) return undefined;
    this.state.updatedAt = this.now();
    return this.commit(publicSnapshot(this.state));
  }

  private commit(snapshot: TurnActivitySnapshot | null): TurnActivityProjection {
    this.revision = incrementCounter(this.revision);
    this.projection = this.parse({
      version: 1,
      generation: this.generation,
      revision: this.revision,
      snapshot,
    });
    return cloneProjection(this.projection);
  }

  private isCurrent(generation: TurnActivityGeneration): boolean {
    return generation.id === this.generation;
  }

  private parse(value: TurnActivityProjection): TurnActivityProjection {
    return TurnActivityProjectionSchema.parse(value);
  }
}
