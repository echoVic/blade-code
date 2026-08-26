import type {
  BrowserAction,
  BrowserInteractionVisual,
  BrowserToolName,
} from '@api/browserSchemas';
import type { SessionRef } from '@api/schemas';
import { create } from 'zustand';

const BROWSER_TOOL_NAMES = new Set<BrowserToolName>([
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserInteract',
  'BrowserWait',
  'BrowserInspect',
  'BrowserPage',
]);
const BROWSER_ACTIONS = new Set<BrowserAction['kind']>([
  'click',
  'hover',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'scroll',
]);

export interface AgentBrowserActivity {
  sessionRef: SessionRef;
  toolCallId: string;
  toolName: BrowserToolName;
  phase: 'running' | 'ready' | 'error';
  revision: number;
  frameRevision: number;
  pointerRevision: number;
  pageId?: string;
  origin?: string;
  url?: string;
  title?: string;
  errorCode?: string;
  pendingAction?: {
    action: BrowserAction['kind'];
    ref?: string;
  };
  interaction?: BrowserInteractionVisual;
}

interface BrowserActivityState {
  agentActivity: AgentBrowserActivity | null;
  beginAgentActivity: (
    ref: SessionRef,
    input: {
      toolCallId: string;
      toolName: BrowserToolName;
      argumentsValue?: unknown;
    }
  ) => void;
  completeAgentActivity: (
    ref: SessionRef,
    input: {
      toolCallId: string;
      toolName: BrowserToolName;
      success: boolean;
      metadata?: unknown;
    }
  ) => void;
  clearAgentActivity: () => void;
}

function sameSession(left: SessionRef | undefined, right: SessionRef): boolean {
  return left?.sessionId === right.sessionId && left.projectPath === right.projectPath;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function browserAction(value: unknown): BrowserAction['kind'] | undefined {
  return typeof value === 'string' &&
    BROWSER_ACTIONS.has(value as BrowserAction['kind'])
    ? (value as BrowserAction['kind'])
    : undefined;
}

function interactionVisual(value: unknown): BrowserInteractionVisual | undefined {
  const source = record(value);
  const action = browserAction(source?.action);
  if (!source || !action) return undefined;
  const viewport = record(source.viewport);
  const targetBox = record(source.targetBox);
  const finite = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate);
  return {
    action,
    ...(typeof source.ref === 'string' ? { ref: source.ref } : {}),
    ...(viewport && finite(viewport.width) && finite(viewport.height)
      ? { viewport: { width: viewport.width, height: viewport.height } }
      : {}),
    ...(targetBox &&
    finite(targetBox.x) &&
    finite(targetBox.y) &&
    finite(targetBox.width) &&
    finite(targetBox.height)
      ? {
          targetBox: {
            x: targetBox.x,
            y: targetBox.y,
            width: targetBox.width,
            height: targetBox.height,
          },
        }
      : {}),
  };
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return typeof value === 'string' && BROWSER_TOOL_NAMES.has(value as BrowserToolName);
}

export const useBrowserActivityStore = create<BrowserActivityState>((set) => ({
  agentActivity: null,

  beginAgentActivity: (sessionRef, input) =>
    set((state) => {
      const previous = sameSession(state.agentActivity?.sessionRef, sessionRef)
        ? state.agentActivity
        : null;
      const args = parseArguments(input.argumentsValue);
      const action =
        input.toolName === 'BrowserInteract'
          ? browserAction(record(args?.action)?.kind)
          : undefined;
      return {
        agentActivity: {
          sessionRef,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          phase: 'running',
          revision: (previous?.revision ?? 0) + 1,
          frameRevision: previous?.frameRevision ?? 0,
          pointerRevision: previous?.pointerRevision ?? 0,
          ...(previous?.pageId ? { pageId: previous.pageId } : {}),
          ...(previous?.origin ? { origin: previous.origin } : {}),
          ...(previous?.url ? { url: previous.url } : {}),
          ...(previous?.title ? { title: previous.title } : {}),
          ...(action
            ? {
                pendingAction: {
                  action,
                  ...(typeof args?.ref === 'string' ? { ref: args.ref } : {}),
                },
              }
            : {}),
          ...(input.toolName !== 'BrowserNavigate' && previous?.interaction
            ? { interaction: previous.interaction }
            : {}),
        },
      };
    }),

  completeAgentActivity: (sessionRef, input) =>
    set((state) => {
      const previous = sameSession(state.agentActivity?.sessionRef, sessionRef)
        ? state.agentActivity
        : null;
      const browser = record(record(input.metadata)?.browser);
      const interaction = interactionVisual(browser?.interaction);
      const pageId =
        typeof browser?.pageId === 'string' ? browser.pageId : previous?.pageId;
      const origin =
        typeof browser?.origin === 'string' ? browser.origin : previous?.origin;
      const preserveInteraction =
        input.toolName !== 'BrowserNavigate' && input.toolName !== 'BrowserPage';
      return {
        agentActivity: {
          sessionRef,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          phase: input.success ? 'ready' : 'error',
          revision: (previous?.revision ?? 0) + 1,
          frameRevision:
            pageId && origin
              ? (previous?.frameRevision ?? 0) + 1
              : (previous?.frameRevision ?? 0),
          pointerRevision: interaction?.targetBox
            ? (previous?.pointerRevision ?? 0) + 1
            : (previous?.pointerRevision ?? 0),
          ...(pageId ? { pageId } : {}),
          ...(origin ? { origin } : {}),
          ...(typeof browser?.url === 'string'
            ? { url: browser.url }
            : previous?.url
              ? { url: previous.url }
              : {}),
          ...(typeof browser?.title === 'string'
            ? { title: browser.title }
            : previous?.title
              ? { title: previous.title }
              : {}),
          ...(typeof browser?.errorCode === 'string'
            ? { errorCode: browser.errorCode }
            : {}),
          ...(interaction
            ? { interaction }
            : preserveInteraction && previous?.interaction
              ? { interaction: previous.interaction }
              : {}),
        },
      };
    }),

  clearAgentActivity: () => set({ agentActivity: null }),
}));
