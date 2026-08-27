export type BrowserOriginClass = 'public' | 'loopback' | 'private-network';

export const BROWSER_TOOL_NAMES = [
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserInteract',
  'BrowserWait',
  'BrowserInspect',
  'BrowserPage',
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export function isBrowserToolName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export type BrowserErrorCode =
  | 'browser_not_installed'
  | 'browser_capacity'
  | 'browser_busy'
  | 'browser_disconnected'
  | 'browser_disposed'
  | 'browser_page_not_found'
  | 'browser_snapshot_stale'
  | 'browser_origin_mismatch'
  | 'browser_cross_origin_navigation'
  | 'browser_cross_origin_frame'
  | 'browser_timeout'
  | 'browser_operation_failed'
  | 'browser_action_uncertain'
  | 'browser_download_blocked'
  | 'browser_unsupported';

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly details: {
      candidateOrigin?: string;
      retryable?: boolean;
      sideEffectsUncertain?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'BrowserRuntimeError';
  }
}

export interface BrowserPageSummary {
  pageId: string;
  selected: boolean;
  url: string;
  origin: string;
  title: string;
}

export interface BrowserObservation {
  pageId: string;
  snapshotId: string;
  url: string;
  origin: string;
  title: string;
  tabs: BrowserPageSummary[];
  snapshot: string;
  truncated: boolean;
}

export interface BrowserPageResult {
  tabs: BrowserPageSummary[];
  selectedPageId?: string;
  observation?: BrowserObservation;
}

export type BrowserDiagnosticKind =
  | 'console'
  | 'page-error'
  | 'request'
  | 'response'
  | 'request-failure'
  | 'dialog'
  | 'download'
  | 'popup-capacity'
  | 'navigation-blocked';

export interface BrowserDiagnosticEntry {
  sequence: number;
  pageId: string;
  kind: BrowserDiagnosticKind;
  level?: string;
  method?: string;
  resourceType?: string;
  status?: number;
  url?: string;
  text?: string;
}

export interface BrowserScreenshotArtifact {
  id: string;
  kind: 'image';
  mimeType: 'image/png';
  size: number;
  sha256: string;
  persisted: true;
  path?: string;
}

export type BrowserInspectTarget =
  | { kind: 'console'; limit?: number }
  | { kind: 'page-errors'; limit?: number }
  | { kind: 'network'; limit?: number }
  | { kind: 'find'; text: string; limit?: number }
  | { kind: 'screenshot' };

export interface BrowserInspectResult {
  pageId: string;
  target: BrowserInspectTarget['kind'];
  entries?: BrowserDiagnosticEntry[];
  matches?: string[];
  snapshotId?: string;
  screenshotId?: string;
  origin?: string;
  url?: string;
  viewport?: BrowserViewportSize;
  artifact?: BrowserScreenshotArtifact;
  truncated: boolean;
}

export type BrowserAllowedKey =
  | 'Enter'
  | 'Tab'
  | 'Escape'
  | 'Backspace'
  | 'Delete'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'Space';

export interface BrowserDialogAction {
  action: 'accept' | 'dismiss';
}

export type BrowserAction =
  | { kind: 'click'; dialog?: BrowserDialogAction }
  | {
      kind: 'click_at';
      screenshotId: string;
      x: number;
      y: number;
      dialog?: BrowserDialogAction;
    }
  | { kind: 'hover' }
  | { kind: 'fill'; value: string }
  | { kind: 'type'; value: string }
  | { kind: 'press'; key: BrowserAllowedKey }
  | { kind: 'select'; values: string[] }
  | { kind: 'check' }
  | { kind: 'uncheck' }
  | {
      kind: 'scroll';
      direction: 'up' | 'down' | 'left' | 'right';
      amount: number;
    };

export type BrowserWaitCondition =
  | { kind: 'load'; state: 'domcontentloaded' | 'load' | 'networkidle' }
  | { kind: 'text'; text: string }
  | { kind: 'url'; value: string }
  | {
      kind: 'ref';
      snapshotId: string;
      ref: string;
      state: 'visible' | 'hidden' | 'attached' | 'detached';
    }
  | { kind: 'time'; milliseconds: number };

export type BrowserPageAction =
  | { kind: 'list' }
  | { kind: 'open' }
  | { kind: 'select'; pageId: string }
  | { kind: 'close'; pageId: string }
  | { kind: 'reset' };

export interface BrowserViewportSize {
  width: number;
  height: number;
}

export interface BrowserTargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserInteractionVisual {
  action: BrowserAction['kind'];
  ref?: string;
  viewport?: BrowserViewportSize;
  targetBox?: BrowserTargetBox;
}

export type BrowserInteractionResult = (
  | {
      outcome: 'applied';
      pageId: string;
      actionApplied: true;
      sideEffectsUncertain: false;
      observation: BrowserObservation;
    }
  | {
      outcome: 'applied_observation_failed';
      pageId: string;
      actionApplied: true;
      sideEffectsUncertain: false;
      observationError: 'browser_observation_failed';
    }
  | {
      outcome: 'uncertain';
      pageId: string;
      actionApplied: 'unknown';
      sideEffectsUncertain: true;
      errorCode:
        | 'browser_cross_origin_navigation'
        | 'browser_disconnected'
        | 'browser_timeout'
        | 'browser_action_uncertain';
      candidateOrigin?: string;
    }
) & {
  interaction?: BrowserInteractionVisual;
};
