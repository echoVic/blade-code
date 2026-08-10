import { materializeSessionEvents } from '../services/sessionRewind.js';
import type {
  SessionEvent,
  SessionInteractionRecoveryInfo,
  SessionInteractionRequestInfo,
  SessionInteractionResponseInfo,
  SessionPendingInteraction,
} from './types.js';

export interface ProjectedSessionInteraction {
  request: SessionInteractionRequestInfo;
  response?: SessionInteractionResponseInfo;
  recovery?: SessionInteractionRecoveryInfo;
  hasToolResult: boolean;
  hasRecoveryToolResult: boolean;
}

function toolResultPayload(
  events: readonly SessionEvent[],
  toolCallId: string
): Record<string, unknown> | undefined {
  for (const event of events) {
    if (event.type !== 'part_created' || event.data.partType !== 'tool_result') {
      continue;
    }
    const payload = event.data.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    if (
      record.toolCallId === toolCallId ||
      event.data.partId === toolCallId ||
      event.data.messageId === toolCallId
    ) {
      return record;
    }
  }
  return undefined;
}

export function projectSessionInteractions(
  source: readonly SessionEvent[]
): ProjectedSessionInteraction[] {
  const events = materializeSessionEvents(source);
  const projected = new Map<string, ProjectedSessionInteraction>();

  for (const event of events) {
    if (event.type === 'interaction_requested') {
      projected.set(event.data.requestId, {
        request: event.data,
        hasToolResult: false,
        hasRecoveryToolResult: false,
      });
      continue;
    }
    if (event.type === 'interaction_responded') {
      const interaction = projected.get(event.data.requestId);
      if (interaction) interaction.response = event.data;
      continue;
    }
    if (event.type === 'interaction_recovered') {
      const interaction = projected.get(event.data.requestId);
      if (interaction) interaction.recovery = event.data;
    }
  }

  for (const interaction of projected.values()) {
    const result = toolResultPayload(events, interaction.request.toolCallId);
    interaction.hasToolResult = result !== undefined;
    const metadata =
      result?.metadata && typeof result.metadata === 'object'
        ? (result.metadata as Record<string, unknown>)
        : undefined;
    interaction.hasRecoveryToolResult =
      metadata?.interactionRecovery === true &&
      metadata.requestId === interaction.request.requestId;
  }

  return [...projected.values()];
}

export function findPendingSessionInteraction(
  events: readonly SessionEvent[]
): ProjectedSessionInteraction | undefined {
  return projectSessionInteractions(events)
    .reverse()
    .find((interaction) => !interaction.response && !interaction.recovery);
}

export function findRecoverableSessionInteractions(
  events: readonly SessionEvent[]
): ProjectedSessionInteraction[] {
  const latestByToolCall = new Map<string, ProjectedSessionInteraction>();
  for (const interaction of projectSessionInteractions(events)) {
    latestByToolCall.set(interaction.request.toolCallId, interaction);
  }
  return [...latestByToolCall.values()].filter(
    (interaction) =>
      interaction.response &&
      !interaction.recovery &&
      (!interaction.hasToolResult || interaction.hasRecoveryToolResult)
  );
}

export function toPendingInteraction(
  interaction: ProjectedSessionInteraction | undefined
): SessionPendingInteraction | undefined {
  if (!interaction) return undefined;
  return {
    type: interaction.request.interactionType,
    requestId: interaction.request.requestId,
  };
}
