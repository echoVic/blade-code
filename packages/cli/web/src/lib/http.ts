interface ErrorPayload {
  error?: unknown;
  message?: unknown;
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
    throw new Error(message);
  }

  return payload as T;
}
