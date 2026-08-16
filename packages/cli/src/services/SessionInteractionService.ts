import path from 'node:path';
import { nanoid } from 'nanoid';
import { DurableSteeringInbox } from '../agent/runtime/DurableSteeringInbox.js';
import {
  findPendingSessionInteraction,
  findRecoverableSessionInteractions,
  type ProjectedSessionInteraction,
} from '../context/interactions.js';
import { PersistentStore } from '../context/storage/PersistentStore.js';
import type {
  SessionInteractionRequestInfo,
  SessionInteractionResponseInfo,
} from '../context/types.js';
import type { JsonValue } from '../store/types.js';
import type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '../tools/types/ExecutionTypes.js';
import { KeyedMutexRegistry } from '../utils/KeyedMutexRegistry.js';

const MAX_INTERACTION_BYTES = 128 * 1024;
const interactionLocks = new KeyedMutexRegistry<string>();

function interactionKey(projectPath: string, sessionId: string): string {
  return `${path.resolve(projectPath)}\u0000${sessionId}`;
}

export function sessionInteractionCoordinationStatsForTests() {
  return interactionLocks.getStats();
}

function toJsonValue(value: unknown, label: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INTERACTION_BYTES) {
    throw new Error(`${label} exceeds ${MAX_INTERACTION_BYTES} bytes`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function durableInteractionType(
  details: ConfirmationDetails
): SessionInteractionRequestInfo['interactionType'] | undefined {
  if (details.type === 'askUserQuestion') return 'question';
  if (details.type === 'mcpElicitation') return 'elicitation';
  if (details.type === 'permission' || details.type === 'mcpSampling') {
    return 'permission';
  }
  return undefined;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function durableResponseFor(
  interaction: ProjectedSessionInteraction,
  response: ConfirmationResponse
): JsonValue {
  if (interaction.request.interactionType !== 'elicitation') {
    return toJsonValue(response, 'Interaction response');
  }
  return toJsonValue(
    {
      approved: response.approved,
      ...(response.reason ? { reason: response.reason } : {}),
      ...(response.elicitation
        ? { elicitation: { action: response.elicitation.action } }
        : {}),
      ...(response.openExternalUrl ? { openExternalUrl: true } : {}),
    },
    'Interaction response'
  );
}

function storedDetails(interaction: ProjectedSessionInteraction): ConfirmationDetails {
  const value = interaction.request.details;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid durable interaction details: ${interaction.request.requestId}`
    );
  }
  return value as unknown as ConfirmationDetails;
}

function storedResponse(
  interaction: ProjectedSessionInteraction
): ConfirmationResponse {
  const value = interaction.response?.response;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Invalid durable interaction response: ${interaction.request.requestId}`
    );
  }
  return value as unknown as ConfirmationResponse;
}

function renderAnswers(response: ConfirmationResponse): string {
  if (!response.answers || Object.keys(response.answers).length === 0) {
    return 'No structured answers were provided.';
  }
  return Object.entries(response.answers)
    .map(([header, answer]) => {
      const text = Array.isArray(answer) ? answer.join(', ') : answer;
      return `${header}: ${text}`;
    })
    .join('\n');
}

function recoveryContent(
  interaction: ProjectedSessionInteraction,
  response: ConfirmationResponse
): { toolOutput: JsonValue; error?: string; inbox: string } {
  const { request } = interaction;
  if (request.interactionType === 'question') {
    const answers = renderAnswers(response);
    return {
      toolOutput: `User answers:\n${answers}`,
      inbox:
        `The process restarted while waiting for a structured answer. ` +
        `The recovered user response is:\n${answers}\n\nContinue from this decision.`,
    };
  }

  const decision = response.approved ? 'approved' : 'denied';
  const reason = response.reason || response.feedback;
  const error =
    `The process restarted before ${request.toolName} completed. ` +
    `The original invocation was not replayed, so its side effects are unknown or absent.`;
  return {
    toolOutput: null,
    error,
    inbox:
      `The process restarted while ${request.toolName} was waiting for user input. ` +
      `The user ${decision} the original request${reason ? `: ${reason}` : '.'} ` +
      `Blade did not replay the original invocation. Inspect current state and ` +
      `reissue it only if it is still required.`,
  };
}

export interface DurableInteractionContext {
  sessionId: string;
  projectPath: string;
  toolCallId: string;
  toolName: string;
}

export class SessionInteractionService {
  static confirmationDetails(
    interaction: ProjectedSessionInteraction
  ): ConfirmationDetails {
    return storedDetails(interaction);
  }

  static createConfirmationHandler(
    base: ConfirmationHandler | undefined,
    context: DurableInteractionContext
  ): ConfirmationHandler | undefined {
    if (!base) return undefined;
    return {
      requestConfirmation: async (details, signal) => {
        const interactionType = durableInteractionType(details);
        if (!interactionType) {
          return base.requestConfirmation(details, signal);
        }

        const request = await SessionInteractionService.request(context, details);
        const enriched: ConfirmationDetails = {
          ...details,
          interactionRequestId: request.requestId,
          toolCallId: request.toolCallId,
        };
        const response = await base.requestConfirmation(enriched, signal);
        await SessionInteractionService.respond(
          context.projectPath,
          context.sessionId,
          request.requestId,
          response
        );
        return response;
      },
    };
  }

  static async request(
    context: DurableInteractionContext,
    details: ConfirmationDetails
  ): Promise<SessionInteractionRequestInfo> {
    const interactionType = durableInteractionType(details);
    if (!interactionType) {
      throw new Error(`Confirmation type is not durable: ${details.type ?? 'unknown'}`);
    }
    return interactionLocks.runExclusive(
      interactionKey(context.projectPath, context.sessionId),
      async () => {
        const existing = await SessionInteractionService.findPending(
          context.projectPath,
          context.sessionId
        );
        if (existing) {
          throw new Error(
            `Session already has a pending interaction: ${existing.request.requestId}`
          );
        }
        const events = await new PersistentStore(context.projectPath).loadEvents(
          context.sessionId
        );
        const hasDurableToolCall = events?.some(
          (event) =>
            event.type === 'part_created' &&
            event.data.partType === 'tool_call' &&
            (event.data.partId === context.toolCallId ||
              (event.data.payload &&
                typeof event.data.payload === 'object' &&
                !Array.isArray(event.data.payload) &&
                (event.data.payload as Record<string, unknown>).toolCallId ===
                  context.toolCallId))
        );
        if (!hasDurableToolCall) {
          throw new Error(
            `Interaction requires a durable tool call: ${context.toolCallId}`
          );
        }

        const requestId = details.interactionRequestId ?? nanoid(12);
        const requestedAt = new Date().toISOString();
        const durableDetails: ConfirmationDetails = {
          ...details,
          interactionRequestId: requestId,
          toolCallId: context.toolCallId,
        };
        const request: SessionInteractionRequestInfo = {
          requestId,
          toolCallId: context.toolCallId,
          toolName: context.toolName,
          interactionType,
          details: toJsonValue(durableDetails, 'Interaction details'),
          requestedAt,
        };
        await new PersistentStore(context.projectPath).saveInteractionRequest(
          context.sessionId,
          request
        );
        return request;
      }
    );
  }

  static async respond(
    projectPath: string,
    sessionId: string,
    requestId: string,
    response: ConfirmationResponse
  ): Promise<SessionInteractionResponseInfo> {
    return interactionLocks.runExclusive(
      interactionKey(projectPath, sessionId),
      async () => {
        const events = await new PersistentStore(projectPath).loadEvents(sessionId);
        if (!events) throw new Error(`Session not found: ${sessionId}`);
        const interaction = findPendingSessionInteraction(events);
        const existing = findRecoverableSessionInteractions(events).find(
          (candidate) => candidate.request.requestId === requestId
        );
        const target = existing ?? interaction;
        if (!target || target.request.requestId !== requestId) {
          throw new Error(`Pending interaction not found: ${requestId}`);
        }
        const durableResponse = durableResponseFor(target, response);
        if (existing?.response) {
          if (!sameJson(existing.response.response, durableResponse)) {
            throw new Error(`Interaction already responded differently: ${requestId}`);
          }
          return existing.response;
        }
        const record: SessionInteractionResponseInfo = {
          requestId,
          response: durableResponse,
          respondedAt: new Date().toISOString(),
        };
        await new PersistentStore(projectPath).saveInteractionResponse(
          sessionId,
          record
        );
        return record;
      }
    );
  }

  static async findPending(
    projectPath: string,
    sessionId: string
  ): Promise<ProjectedSessionInteraction | undefined> {
    const events = await new PersistentStore(projectPath).loadEvents(sessionId);
    return events ? findPendingSessionInteraction(events) : undefined;
  }

  static async recoverResponded(
    projectPath: string,
    sessionId: string
  ): Promise<number> {
    return interactionLocks.runExclusive(
      interactionKey(projectPath, sessionId),
      async () => {
        const store = new PersistentStore(projectPath);
        const events = await store.loadEvents(sessionId);
        if (!events) return 0;
        const recoverable = findRecoverableSessionInteractions(events);
        let recovered = 0;
        for (const interaction of recoverable) {
          const response = storedResponse(interaction);
          const content = recoveryContent(interaction, response);
          if (!interaction.hasRecoveryToolResult) {
            await store.saveToolResult(
              sessionId,
              interaction.request.toolCallId,
              interaction.request.toolName,
              content.toolOutput,
              interaction.request.toolCallId,
              content.error,
              undefined,
              undefined,
              {
                interactionRecovery: true,
                requestId: interaction.request.requestId,
              }
            );
          }

          const inboxMessageId = `interaction-${interaction.request.requestId}`;
          const inbox = await DurableSteeringInbox.open(projectPath, sessionId);
          await inbox.enqueue(
            {
              id: inboxMessageId,
              content: content.inbox,
              queuedAt: Date.now(),
            },
            (messages) => !messages.some((message) => message.id === inboxMessageId)
          );

          if (!interaction.recovery) {
            await store
              .saveInteractionRecovery(sessionId, {
                requestId: interaction.request.requestId,
                inboxMessageId,
                recoveredAt: new Date().toISOString(),
              })
              .catch((error) => {
                if (!String(error).includes('already recovered')) throw error;
              });
          }
          recovered++;
        }
        return recovered;
      }
    );
  }

  static async respondAndRecover(
    projectPath: string,
    sessionId: string,
    requestId: string,
    response: ConfirmationResponse
  ): Promise<void> {
    await SessionInteractionService.respond(
      projectPath,
      sessionId,
      requestId,
      response
    );
    await SessionInteractionService.recoverResponded(projectPath, sessionId);
  }

  static async resolvePendingWithHandler(
    projectPath: string,
    sessionId: string,
    handler: ConfirmationHandler
  ): Promise<boolean> {
    const pending = await SessionInteractionService.findPending(projectPath, sessionId);
    if (!pending) {
      return (
        (await SessionInteractionService.recoverResponded(projectPath, sessionId)) > 0
      );
    }
    const response = await handler.requestConfirmation(storedDetails(pending));
    await SessionInteractionService.respondAndRecover(
      projectPath,
      sessionId,
      pending.request.requestId,
      response
    );
    return true;
  }

  static async cancelPendingNonInteractive(
    projectPath: string,
    sessionId: string
  ): Promise<boolean> {
    const pending = await SessionInteractionService.findPending(projectPath, sessionId);
    if (!pending) {
      return (
        (await SessionInteractionService.recoverResponded(projectPath, sessionId)) > 0
      );
    }
    await SessionInteractionService.respondAndRecover(
      projectPath,
      sessionId,
      pending.request.requestId,
      {
        approved: false,
        reason: 'Non-interactive resume cannot collect pending user input',
      }
    );
    return true;
  }
}
