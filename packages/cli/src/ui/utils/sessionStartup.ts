export interface SessionStartupIdentityOptions {
  resumeSessionId?: string;
  forkSession?: boolean;
}

export function getInitialLocalSessionId(
  options: SessionStartupIdentityOptions
): string | undefined {
  return options.forkSession ? undefined : options.resumeSessionId;
}

export function initializeLocalSessionIdentity(
  options: SessionStartupIdentityOptions,
  restoreSession: (sessionId: string) => void
): void {
  const sessionId = getInitialLocalSessionId(options);
  if (sessionId) restoreSession(sessionId);
}
