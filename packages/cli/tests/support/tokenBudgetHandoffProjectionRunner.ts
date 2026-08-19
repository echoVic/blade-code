import path from 'node:path';
import {
  isTokenBudgetHandoffMessage,
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  TOKEN_BUDGET_HANDOFF_TAG,
} from '../../src/context/TokenBudgetHandoff.js';
import { assertValidSessionId } from '../../src/context/storage/pathUtils.js';
import { SessionService } from '../../src/services/SessionService.js';

const TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX = '__BLADE_TOKEN_BUDGET_PROJECTION__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadInput(): { sessionId: string; workspace: string } {
  const encoded = process.argv[2];
  if (
    !encoded ||
    encoded.length > 16_384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Token-budget projection input is missing or oversized');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new Error('Token-budget projection input encoding is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Token-budget projection input is invalid');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, 'sessionId') ||
    !Object.hasOwn(parsed, 'workspace') ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.workspace !== 'string' ||
    !path.isAbsolute(parsed.workspace)
  ) {
    throw new Error('Token-budget projection input shape is invalid');
  }
  assertValidSessionId(parsed.sessionId);
  return { sessionId: parsed.sessionId, workspace: path.resolve(parsed.workspace) };
}

function containsHiddenMarker(
  messages: Awaited<ReturnType<typeof SessionService.loadSession>>
): boolean {
  if (
    messages.some((message) => {
      if (isTokenBudgetHandoffMessage(message)) return true;
      if (typeof message.content !== 'string') return false;
      return (
        message.content.includes(TOKEN_BUDGET_HANDOFF_TAG) ||
        message.content.includes('token_budget_handoff_recorded') ||
        message.content.includes(TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX) ||
        message.content.includes('Context rollover is approaching')
      );
    })
  ) {
    return true;
  }
  const serialized = JSON.stringify(messages);
  return [
    TOKEN_BUDGET_HANDOFF_TAG,
    'token_budget_handoff_recorded',
    TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
    'Context rollover is approaching',
  ].some((value) => serialized.includes(value));
}

async function main(): Promise<void> {
  const input = loadInput();
  const [modelMessages, publicMessages] = await Promise.all([
    SessionService.loadSessionModelContext(input.sessionId, input.workspace),
    SessionService.loadSession(input.sessionId, input.workspace),
  ]);
  const evidence = {
    modelHasMarker: containsHiddenMarker(modelMessages),
    publicHasMarker: containsHiddenMarker(publicMessages),
    modelMessageCount: modelMessages.length,
    publicMessageCount: publicMessages.length,
  };
  process.stdout.write(
    `${TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX}${JSON.stringify(evidence)}\n`
  );
}

if (import.meta.main) {
  await main();
}
