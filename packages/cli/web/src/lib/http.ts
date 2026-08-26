interface ErrorPayload {
  error?: unknown;
  message?: unknown;
}

export class HttpResponseError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

export function isHttpResponseError(error: unknown): error is HttpResponseError {
  return error instanceof HttpResponseError;
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    const errorPayload = payload as ErrorPayload | undefined;
    const nestedError =
      errorPayload?.error &&
      typeof errorPayload.error === 'object' &&
      !Array.isArray(errorPayload.error)
        ? (errorPayload.error as { message?: unknown })
        : undefined;
    const message =
      typeof errorPayload?.error === 'string'
        ? errorPayload.error
        : typeof nestedError?.message === 'string'
          ? nestedError.message
          : typeof errorPayload?.message === 'string'
            ? errorPayload.message
            : response.statusText || `Request failed (${response.status})`;
    throw new HttpResponseError(message, response.status);
  }

  return payload as T;
}
