import type { TranslationKey } from '@/i18n';
import type { Session } from '@/store/session';

export type TaskFailureCode = NonNullable<Session['taskFailure']>['code'];

const FAILURE_MESSAGE_KEYS: Record<TaskFailureCode, TranslationKey> = {
  authentication: 'task.failure.authentication',
  permission: 'task.failure.permission',
  rate_limit: 'task.failure.rateLimit',
  timeout: 'task.failure.timeout',
  network: 'task.failure.network',
  model_unavailable: 'task.failure.modelUnavailable',
  context_limit: 'task.failure.contextLimit',
  unsupported_input: 'task.failure.unsupportedInput',
  workspace_unavailable: 'task.failure.workspaceUnavailable',
  capacity: 'task.failure.capacity',
  runtime: 'task.failure.runtime',
};

const FAILURE_RETRYABLE: Record<TaskFailureCode, boolean> = {
  authentication: false,
  permission: false,
  rate_limit: true,
  timeout: true,
  network: true,
  model_unavailable: true,
  context_limit: false,
  unsupported_input: false,
  workspace_unavailable: false,
  capacity: true,
  runtime: true,
};

export function taskFailureCode(value: unknown): TaskFailureCode | undefined {
  if (typeof value === 'string' && Object.keys(FAILURE_MESSAGE_KEYS).includes(value)) {
    return value as TaskFailureCode;
  }
  return undefined;
}

export function taskFailureMessageKey(code: TaskFailureCode): TranslationKey {
  return FAILURE_MESSAGE_KEYS[code];
}

export function taskFailureIsRetryable(code: TaskFailureCode): boolean {
  return FAILURE_RETRYABLE[code];
}
