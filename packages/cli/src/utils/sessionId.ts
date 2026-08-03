import { nanoid } from 'nanoid';

const SESSION_ID_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Generate an ID that is always valid for session-backed storage paths. */
export function createSessionId(prefix = 'session', size = 21): string {
  if (!SESSION_ID_PREFIX.test(prefix)) {
    throw new Error(`Invalid session ID prefix: ${prefix}`);
  }
  return `${prefix}-${nanoid(size)}`;
}
