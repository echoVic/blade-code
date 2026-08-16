import type {
  SessionTaskCapacityResource,
  SessionTaskFailure,
  SessionTaskFailureCode,
} from './types.js';

const FAILURE_DEFINITIONS = {
  authentication: {
    message: 'Provider authentication failed. Check model credentials.',
    retryable: false,
  },
  permission: {
    message: 'Provider rejected this request. Check account and model permissions.',
    retryable: false,
  },
  rate_limit: {
    message: 'Provider rate limit or quota exceeded.',
    retryable: true,
  },
  timeout: {
    message: 'Provider request timed out.',
    retryable: true,
  },
  network: {
    message: 'Provider connection failed.',
    retryable: true,
  },
  model_unavailable: {
    message: 'The selected model is unavailable.',
    retryable: true,
  },
  context_limit: {
    message: 'The request exceeded the model context limit.',
    retryable: false,
  },
  unsupported_input: {
    message: 'The selected model does not support this input.',
    retryable: false,
  },
  capacity: {
    message: 'Task admission capacity is full. Retry after running tasks complete.',
    retryable: true,
  },
  runtime: {
    message: 'Agent execution failed.',
    retryable: true,
  },
} as const satisfies Record<SessionTaskFailureCode, Omit<SessionTaskFailure, 'code'>>;

function rawErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (
      error !== null &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

function classifyFailureCode(message: string): SessionTaskFailureCode {
  const lower = message.toLowerCase();
  if (
    /\b(401|unauthorized|authentication|invalid (?:api[ _-]?)?key|api[ _-]?key|credential)\b/.test(
      lower
    )
  ) {
    return 'authentication';
  }
  if (/\b(403|forbidden|permission denied|not permitted)\b/.test(lower)) {
    return 'permission';
  }
  if (/\b(429|rate limit|too many requests|quota)\b/.test(lower)) {
    return 'rate_limit';
  }
  if (/\b(timeout|timed out|deadline exceeded|etimedout)\b/.test(lower)) {
    return 'timeout';
  }
  if (/\b(econnreset|econnrefused|enotfound|network|socket|connection)\b/.test(lower)) {
    return 'network';
  }
  if (
    /\b(model not found|model unavailable|unsupported model|no such model)\b/.test(
      lower
    )
  ) {
    return 'model_unavailable';
  }
  if (
    /\b(context (?:length|window)|maximum context|too many tokens|token limit)\b/.test(
      lower
    )
  ) {
    return 'context_limit';
  }
  if (/\b(image|vision|multimodal|unsupported input|does not support)\b/.test(lower)) {
    return 'unsupported_input';
  }
  if (/\btask admission\b.*\b(capacity|queue)\b/.test(lower)) {
    return 'capacity';
  }
  return 'runtime';
}

function taskAdmissionResource(
  error: unknown
): SessionTaskCapacityResource | undefined {
  try {
    if (
      !error ||
      typeof error !== 'object' ||
      !('name' in error) ||
      (error.name !== 'TaskAdmissionQueueFullError' &&
        error.name !== 'SessionRuntimeCapacityError') ||
      !('resource' in error)
    ) {
      return undefined;
    }
    return error.resource === 'pending_count' ||
      error.resource === 'pending_bytes' ||
      error.resource === 'resident_runtimes'
      ? error.resource
      : undefined;
  } catch {
    return undefined;
  }
}

export function taskFailureForCode(code: SessionTaskFailureCode): SessionTaskFailure {
  return {
    code,
    ...FAILURE_DEFINITIONS[code],
  };
}

export function toTaskFailure(error: unknown): SessionTaskFailure {
  const resource = taskAdmissionResource(error);
  if (resource) {
    return {
      ...taskFailureForCode('capacity'),
      resource,
    };
  }
  return taskFailureForCode(classifyFailureCode(rawErrorMessage(error)));
}

export function isSessionTaskFailure(value: unknown): value is SessionTaskFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionTaskFailure>;
  if (typeof candidate.code !== 'string' || !(candidate.code in FAILURE_DEFINITIONS)) {
    return false;
  }
  const canonical = FAILURE_DEFINITIONS[candidate.code as SessionTaskFailureCode];
  const resourceValid =
    candidate.resource === undefined ||
    candidate.resource === 'pending_count' ||
    candidate.resource === 'pending_bytes' ||
    candidate.resource === 'resident_runtimes';
  return (
    candidate.message === canonical.message &&
    candidate.retryable === canonical.retryable &&
    resourceValid &&
    (candidate.code === 'capacity' || candidate.resource === undefined)
  );
}
