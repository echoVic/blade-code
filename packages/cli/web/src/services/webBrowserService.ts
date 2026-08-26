import type {
  BrowserAction,
  BrowserInspectResult,
  BrowserInteractionResult,
  BrowserObservation,
  WebBrowserInteractRequest,
  WebBrowserNavigateRequest,
} from '@api/browserSchemas';
import { type SessionRef, SessionRefSchema } from '@api/schemas';
import { requestJson } from '@/lib/http';

export type BrowserInspectKind = 'console' | 'page-errors' | 'network';

function browserSessionPath(
  ref: SessionRef,
  operation: string,
  parameters: Record<string, string | number | boolean | undefined> = {}
): string {
  const parsed = SessionRefSchema.parse(ref);
  const query = new URLSearchParams({ projectPath: parsed.projectPath });
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(name, String(value));
  }
  return `/sessions/${encodeURIComponent(
    parsed.sessionId
  )}/browser/${operation}?${query.toString()}`;
}

export const webBrowserService = {
  navigate: async (
    ref: SessionRef,
    input: WebBrowserNavigateRequest
  ): Promise<BrowserObservation> =>
    requestJson<BrowserObservation>(browserSessionPath(ref, 'navigate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  snapshot: async (
    ref: SessionRef,
    input: { pageId?: string; depth?: number; includeBoxes?: boolean } = {}
  ): Promise<BrowserObservation> =>
    requestJson<BrowserObservation>(browserSessionPath(ref, 'snapshot', input)),

  interact: async (
    ref: SessionRef,
    input: WebBrowserInteractRequest & { action: BrowserAction }
  ): Promise<BrowserInteractionResult> =>
    requestJson<BrowserInteractionResult>(browserSessionPath(ref, 'interact'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  inspect: async (
    ref: SessionRef,
    input: {
      target: BrowserInspectKind;
      pageId?: string;
      expectedOrigin?: string;
      limit?: number;
    }
  ): Promise<BrowserInspectResult> =>
    requestJson<BrowserInspectResult>(browserSessionPath(ref, 'inspect', input)),

  screenshot: async (
    ref: SessionRef,
    input: { pageId?: string; expectedOrigin?: string } = {}
  ): Promise<Blob> => {
    const response = await fetch(
      browserSessionPath(ref, 'inspect', {
        ...input,
        target: 'screenshot',
      })
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      throw new Error(payload?.error?.message || 'Failed to capture browser image');
    }
    return response.blob();
  },

  reset: async (ref: SessionRef): Promise<void> => {
    await requestJson<{ success: true }>(browserSessionPath(ref, 'reset'), {
      method: 'POST',
    });
  },
};
