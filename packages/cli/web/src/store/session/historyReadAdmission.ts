import type { SessionLocatorV2 } from '@api/schemas';
import { surfaceLocatorKey } from './sessionIdentity';

const MAX_CONCURRENT_HISTORY_READS = 4;

interface AdmissionWaiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

class HistoryReadAdmission {
  private active = 0;
  private readonly waiters: AdmissionWaiter[] = [];

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < MAX_CONCURRENT_HISTORY_READS) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      const waiter: AdmissionWaiter = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener('abort', onAbort),
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter.removeAbortListener();
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.active -= 1;
  }
}

const historyReadAdmission = new HistoryReadAdmission();
const historyPageRequests = new Map<
  string,
  { signal: AbortSignal; token: symbol; promise: Promise<void> }
>();

export function runBoundedHistoryRead<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  return historyReadAdmission.run(signal, operation);
}

export function getHistoryPageRequest(
  locator: SessionLocatorV2
): Promise<void> | undefined {
  const key = surfaceLocatorKey(locator);
  const entry = historyPageRequests.get(key);
  if (entry?.signal.aborted) {
    historyPageRequests.delete(key);
    return undefined;
  }
  return entry?.promise;
}

export function registerHistoryPageRequest(
  locator: SessionLocatorV2,
  signal: AbortSignal,
  requestFactory: () => Promise<void>
): Promise<void> {
  const key = surfaceLocatorKey(locator);
  const existing = historyPageRequests.get(key);
  if (existing && !existing.signal.aborted) return existing.promise;
  if (existing) historyPageRequests.delete(key);
  const token = Symbol(key);
  const request = requestFactory().finally(() => {
    if (historyPageRequests.get(key)?.token === token) {
      historyPageRequests.delete(key);
    }
  });
  historyPageRequests.set(key, { signal, token, promise: request });
  return request;
}
