import { randomUUID } from 'node:crypto';
import type {
  BrowserContext,
  ConsoleMessage,
  Dialog,
  Download,
  Frame,
  Page,
  Request,
  Response,
  Route,
} from 'playwright';
import {
  BrowserArtifactStore,
  createBrowserSessionIdentity,
} from './BrowserArtifactStore.js';
import { BrowserOperationGate } from './BrowserOperationGate.js';
import {
  type BrowserContextLease,
  type BrowserProcessPool,
  getBrowserProcessPool,
} from './BrowserProcessPool.js';
import {
  browserOriginFromPageUrl,
  byteLength,
  isCredentialControl,
  normalizeBrowserUrl,
  normalizeExpectedBrowserOrigin,
  projectBrowserUrl,
  sanitizeBrowserText,
} from './BrowserSecurity.js';
import { BrowserSnapshotAuthority } from './BrowserSnapshotAuthority.js';
import {
  BROWSER_CLICK_SETTLE_TIMEOUT_MS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DIAGNOSTIC_RESULT_ENTRIES,
  DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
  DEFAULT_BROWSER_SNAPSHOT_DEPTH,
  DEFAULT_BROWSER_WAIT_TIMEOUT_MS,
  MAX_BROWSER_ACTION_TIMEOUT_MS,
  MAX_BROWSER_DIAGNOSTIC_ENTRIES,
  MAX_BROWSER_DIAGNOSTIC_RESULT_ENTRIES,
  MAX_BROWSER_DIAGNOSTIC_TEXT_BYTES,
  MAX_BROWSER_EXPLICIT_WAIT_MS,
  MAX_BROWSER_ID_BYTES,
  MAX_BROWSER_INPUT_BYTES,
  MAX_BROWSER_NAVIGATION_TIMEOUT_MS,
  MAX_BROWSER_PAGES_PER_SESSION,
  MAX_BROWSER_REF_BYTES,
  MAX_BROWSER_RESULT_BYTES,
  MAX_BROWSER_SCROLL_AMOUNT,
  MAX_BROWSER_SELECT_VALUE_BYTES,
  MAX_BROWSER_SELECT_VALUES,
  MAX_BROWSER_SNAPSHOT_BYTES,
  MAX_BROWSER_SNAPSHOT_DEPTH,
  MAX_BROWSER_TITLE_BYTES,
  MAX_BROWSER_WAIT_TEXT_BYTES,
  MAX_BROWSER_WAIT_TIMEOUT_MS,
} from './constants.js';
import {
  type BrowserAction,
  type BrowserDiagnosticEntry,
  type BrowserInspectResult,
  type BrowserInspectTarget,
  type BrowserInteractionResult,
  type BrowserObservation,
  type BrowserPageAction,
  type BrowserPageResult,
  BrowserRuntimeError,
  type BrowserWaitCondition,
} from './types.js';

interface PageState {
  id: string;
  page: Page;
  generation: number;
  authorizedOrigin: string | null;
  openerPageId?: string;
  transientOrigin?: string;
  blockedCandidateOrigin?: string;
  downloadBlocked?: boolean;
  nextDialogAction?: 'accept' | 'dismiss';
  createdSequence: number;
}

interface BlockedPopup {
  origin: string;
  openerPageId?: string;
  referrerOrigin?: string;
}

export interface SessionBrowserRuntimeOptions {
  pool?: BrowserProcessPool;
  storageRoot?: string;
  exposeArtifactPaths?: boolean;
}

export interface BrowserNavigateOptions {
  action?: 'goto' | 'back' | 'forward' | 'reload';
  url?: string;
  pageId?: string;
  expectedOrigin?: string;
  waitUntil?: 'commit' | 'domcontentloaded' | 'load';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserSnapshotOptions {
  pageId?: string;
  depth?: number;
  includeBoxes?: boolean;
  signal?: AbortSignal;
}

export interface BrowserInteractOptions {
  pageId: string;
  snapshotId: string;
  ref?: string;
  expectedOrigin: string;
  action: BrowserAction;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserWaitOptions {
  pageId?: string;
  expectedOrigin?: string;
  condition: BrowserWaitCondition;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserInspectOptions {
  pageId?: string;
  expectedOrigin?: string;
  target: BrowserInspectTarget;
  signal?: AbortSignal;
}

export interface BrowserPageOptions {
  action: BrowserPageAction;
  signal?: AbortSignal;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /timeout/i.test(error.message))
  );
}

function isBrowserClosedError(error: unknown): boolean {
  return (
    error instanceof Error && /browser.*closed|target.*closed/i.test(error.message)
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeBrowserText(
    message.replace(/https?:\/\/\S+/g, (url) => projectBrowserUrl(url)),
    MAX_BROWSER_DIAGNOSTIC_TEXT_BYTES
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  releaseLateResult?: (value: T) => void | Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          if (releaseLateResult) {
            try {
              void Promise.resolve(releaseLateResult(value)).catch(() => undefined);
            } catch {
              // The caller has already observed cancellation; cleanup is best effort.
            }
          }
          return;
        }
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      }
    );
  });
}

export class SessionBrowserRuntime {
  private readonly pool: BrowserProcessPool;
  private readonly gate = new BrowserOperationGate();
  private readonly snapshots = new BrowserSnapshotAuthority();
  private readonly artifacts: BrowserArtifactStore;
  private readonly pages = new Map<string, PageState>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly opaqueFrames = new WeakSet<Frame>();
  private readonly popupOpeners = new WeakMap<Page, string>();
  private readonly pageRegistrations = new WeakMap<Page, Promise<void>>();
  private readonly blockedPopups: BlockedPopup[] = [];
  private readonly downloadCancellations = new WeakMap<Download, Promise<void>>();
  private readonly consoleEntries: BrowserDiagnosticEntry[] = [];
  private readonly pageErrorEntries: BrowserDiagnosticEntry[] = [];
  private readonly networkEntries: BrowserDiagnosticEntry[] = [];
  private readonly pendingPageRegistrations = new Set<Promise<void>>();
  private readonly pendingDownloadCancellations = new Set<Promise<void>>();
  private lease?: BrowserContextLease;
  private context?: BrowserContext;
  private selectedPageId?: string;
  private pageSequence = 0;
  private diagnosticSequence = 0;
  private runtimeGeneration = 0;
  private generationController = new AbortController();
  private disposed = false;

  constructor(
    projectPath: string,
    sessionId: string,
    options: SessionBrowserRuntimeOptions = {}
  ) {
    this.pool = options.pool ?? getBrowserProcessPool();
    this.artifacts = new BrowserArtifactStore(
      createBrowserSessionIdentity(projectPath, sessionId),
      {
        storageRoot: options.storageRoot,
        exposePaths: options.exposeArtifactPaths,
      }
    );
  }

  navigate(options: BrowserNavigateOptions): Promise<BrowserObservation> {
    return this.run(async (signal) => {
      const action = options.action ?? 'goto';
      const timeout = options.timeoutMs ?? DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS;
      this.assertIntegerRange(
        timeout,
        100,
        MAX_BROWSER_NAVIGATION_TIMEOUT_MS,
        'navigation timeout'
      );

      if (action === 'goto' && !options.url) {
        throw new BrowserRuntimeError(
          'browser_unsupported',
          'Browser goto requires a URL'
        );
      }
      if (action !== 'goto' && !options.expectedOrigin) {
        throw new BrowserRuntimeError(
          'browser_origin_mismatch',
          `Browser ${action} requires expectedOrigin`
        );
      }
      const target = action === 'goto' ? normalizeBrowserUrl(options.url!) : undefined;
      const expectedOrigin =
        action === 'goto'
          ? undefined
          : normalizeExpectedBrowserOrigin(options.expectedOrigin!);
      const state = await this.resolvePage(options.pageId, action === 'goto', signal);
      const previousOrigin = state.authorizedOrigin;
      let targetOrigin = previousOrigin;
      if (action === 'goto') {
        targetOrigin = target!.origin;
        state.transientOrigin = target!.origin;
        state.blockedCandidateOrigin = undefined;
        this.invalidatePage(state);
        try {
          await state.page.goto(target!.href, {
            waitUntil: options.waitUntil ?? 'domcontentloaded',
            timeout,
            signal,
          });
        } catch (error) {
          return this.handleNavigationFailure(
            state,
            target!.origin,
            previousOrigin,
            signal,
            error
          );
        }
      } else {
        this.assertExpectedOrigin(state, expectedOrigin!);
        targetOrigin = state.authorizedOrigin;
        state.transientOrigin = state.authorizedOrigin ?? undefined;
        state.blockedCandidateOrigin = undefined;
        this.invalidatePage(state);
        try {
          if (action === 'back') {
            await state.page.goBack({
              waitUntil: options.waitUntil ?? 'domcontentloaded',
              timeout,
              signal,
            });
          } else if (action === 'forward') {
            await state.page.goForward({
              waitUntil: options.waitUntil ?? 'domcontentloaded',
              timeout,
              signal,
            });
          } else {
            await state.page.reload({
              waitUntil: options.waitUntil ?? 'domcontentloaded',
              timeout,
              signal,
            });
          }
        } catch (error) {
          return this.handleNavigationFailure(
            state,
            targetOrigin,
            previousOrigin,
            signal,
            error
          );
        }
      }

      this.settleNavigationAuthorization(state, targetOrigin, previousOrigin);
      state.transientOrigin = undefined;
      if (state.blockedCandidateOrigin) {
        throw new BrowserRuntimeError(
          'browser_cross_origin_navigation',
          `Cross-origin navigation was blocked: ${state.blockedCandidateOrigin}`,
          { candidateOrigin: state.blockedCandidateOrigin }
        );
      }
      return this.observe(state, signal);
    }, options.signal);
  }

  private async handleNavigationFailure(
    state: PageState,
    targetOrigin: string | null,
    previousOrigin: string | null,
    signal: AbortSignal,
    error: unknown
  ): Promise<never> {
    this.settleNavigationAuthorization(state, targetOrigin, previousOrigin);
    const blocked = state.blockedCandidateOrigin;
    state.transientOrigin = undefined;
    if (blocked) {
      throw new BrowserRuntimeError(
        'browser_cross_origin_navigation',
        `Cross-origin navigation was blocked: ${blocked}`,
        { candidateOrigin: blocked }
      );
    }
    if (isTimeoutError(error)) {
      throw new BrowserRuntimeError('browser_timeout', 'Browser navigation timed out', {
        retryable: true,
      });
    }
    this.throwIfDisconnected(error, signal);
    throw new BrowserRuntimeError(
      'browser_action_uncertain',
      'Browser navigation failed after it started',
      { sideEffectsUncertain: true }
    );
  }

  snapshot(options: BrowserSnapshotOptions = {}): Promise<BrowserObservation> {
    return this.run(async (signal) => {
      const depth = options.depth ?? DEFAULT_BROWSER_SNAPSHOT_DEPTH;
      this.assertIntegerRange(depth, 1, MAX_BROWSER_SNAPSHOT_DEPTH, 'snapshot depth');
      const state = await this.resolvePage(options.pageId, true, signal);
      return this.observe(state, signal, depth, options.includeBoxes ?? false);
    }, options.signal);
  }

  interact(options: BrowserInteractOptions): Promise<BrowserInteractionResult> {
    return this.run(async (signal) => {
      this.assertIdentifier(options.pageId, 'page ID');
      this.assertIdentifier(options.snapshotId, 'snapshot ID');
      if (options.action.kind !== 'scroll' && !options.ref) {
        throw new BrowserRuntimeError(
          'browser_unsupported',
          'Browser action requires a snapshot ref'
        );
      }
      if (
        options.ref &&
        (byteLength(options.ref) > MAX_BROWSER_REF_BYTES ||
          !/^[a-z][a-z0-9]*$/.test(options.ref))
      ) {
        throw new BrowserRuntimeError('browser_unsupported', 'Browser ref is invalid');
      }
      this.validateAction(options.action);
      const timeout = options.timeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS;
      this.assertIntegerRange(
        timeout,
        100,
        MAX_BROWSER_ACTION_TIMEOUT_MS,
        'action timeout'
      );
      const state = this.requireExistingPage(options.pageId);
      this.throwIfBlockedNavigation(state);
      const expectedOrigin = this.assertExpectedOrigin(state, options.expectedOrigin);
      const snapshotInput = {
        pageId: state.id,
        snapshotId: options.snapshotId,
        pageGeneration: state.generation,
        origin: expectedOrigin,
      };
      const authority = this.snapshots.validateSnapshot(snapshotInput);
      const validation = options.ref
        ? this.snapshots.validate({ ...snapshotInput, ref: options.ref })
        : undefined;
      const fresh = await state.page.ariaSnapshot({
        mode: 'ai',
        depth: authority.depth,
        boxes: authority.includeBoxes,
        timeout: options.timeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
        signal,
      });
      if (validation) {
        this.snapshots.verifyFreshFingerprint(validation, fresh);
      }

      const locator = options.ref
        ? state.page.locator(`aria-ref=${options.ref}`)
        : undefined;
      if (locator && (await locator.count()) !== 1) {
        throw new BrowserRuntimeError(
          'browser_snapshot_stale',
          'Browser ref no longer resolves to exactly one element'
        );
      }
      if (locator) {
        const element = await locator.elementHandle();
        let ownerFrame: Frame | null = null;
        try {
          ownerFrame = (await element?.ownerFrame()) ?? null;
        } finally {
          await element?.dispose().catch(() => undefined);
        }
        const frameOrigin = ownerFrame
          ? await this.resolveEffectiveFrameOrigin(ownerFrame)
          : null;
        if (frameOrigin !== state.authorizedOrigin) {
          throw new BrowserRuntimeError(
            'browser_cross_origin_frame',
            'Browser ref belongs to a cross-origin frame'
          );
        }
      }
      if (
        locator &&
        validation &&
        (options.action.kind === 'fill' || options.action.kind === 'type')
      ) {
        const [type, autocomplete, name, id, ariaLabel, ariaLabelledBy] =
          await Promise.all([
            locator.getAttribute('type'),
            locator.getAttribute('autocomplete'),
            locator.getAttribute('name'),
            locator.getAttribute('id'),
            locator.getAttribute('aria-label'),
            locator.getAttribute('aria-labelledby'),
          ]);
        if (
          isCredentialControl({
            type,
            autocomplete,
            name,
            id,
            ariaLabel,
            accessibleName: validation.fingerprint,
            accessibleNameExceededLimit: validation.fingerprintExceededLimit,
            referencedAccessibleNameUnavailable:
              Boolean(ariaLabelledBy?.trim()) &&
              !/^-\s+\S+\s+"/u.test(validation.fingerprint),
          })
        ) {
          throw new BrowserRuntimeError(
            'browser_unsupported',
            'Browser credential entry is not supported'
          );
        }
      }

      this.throwIfBlockedNavigation(state);
      this.assertExpectedOrigin(state, expectedOrigin);
      state.downloadBlocked = false;
      this.invalidatePage(state);
      const generation = this.runtimeGeneration;
      let actionFailed = false;
      let actionError: unknown;
      const downloadPromise =
        options.action.kind === 'click'
          ? state.page
              .waitForEvent('download', {
                timeout: Math.min(timeout, BROWSER_CLICK_SETTLE_TIMEOUT_MS),
              })
              .catch(() => undefined)
          : undefined;
      try {
        if (options.action.kind === 'click') {
          state.nextDialogAction = options.action.dialog?.action;
        }
        await this.executeAction(state.page, locator, options.action, timeout, signal);
        const download = downloadPromise
          ? await raceWithAbort(downloadPromise, signal)
          : undefined;
        if (download) {
          this.trackDownloadCancellation(state, download);
        }
        await this.settlePageRegistrations(signal);
        await this.settleDownloadCancellations(signal);
      } catch (error) {
        actionFailed = true;
        actionError = error;
      } finally {
        state.nextDialogAction = undefined;
      }
      this.markUnexpectedInteractionOrigin(state, expectedOrigin);
      if (state.downloadBlocked) {
        state.downloadBlocked = false;
        throw new BrowserRuntimeError(
          'browser_download_blocked',
          'Browser download was blocked'
        );
      }
      if (actionFailed) {
        return this.uncertainInteraction(state, generation, actionError);
      }
      if (state.blockedCandidateOrigin) {
        return {
          outcome: 'uncertain',
          pageId: state.id,
          actionApplied: 'unknown',
          sideEffectsUncertain: true,
          errorCode: 'browser_cross_origin_navigation',
          candidateOrigin: state.blockedCandidateOrigin,
        };
      }
      if (generation !== this.runtimeGeneration) {
        return {
          outcome: 'uncertain',
          pageId: state.id,
          actionApplied: 'unknown',
          sideEffectsUncertain: true,
          errorCode: 'browser_disconnected',
        };
      }

      try {
        const observation = await this.observe(state, signal);
        if (state.blockedCandidateOrigin) {
          return {
            outcome: 'uncertain',
            pageId: state.id,
            actionApplied: 'unknown',
            sideEffectsUncertain: true,
            errorCode: 'browser_cross_origin_navigation',
            candidateOrigin: state.blockedCandidateOrigin,
          };
        }
        return {
          outcome: 'applied',
          pageId: state.id,
          actionApplied: true,
          sideEffectsUncertain: false,
          observation,
        };
      } catch (error) {
        if (
          state.blockedCandidateOrigin ||
          (error instanceof BrowserRuntimeError &&
            error.code === 'browser_cross_origin_navigation')
        ) {
          return {
            outcome: 'uncertain',
            pageId: state.id,
            actionApplied: 'unknown',
            sideEffectsUncertain: true,
            errorCode: 'browser_cross_origin_navigation',
            ...(state.blockedCandidateOrigin
              ? { candidateOrigin: state.blockedCandidateOrigin }
              : {}),
          };
        }
        return {
          outcome: 'applied_observation_failed',
          pageId: state.id,
          actionApplied: true,
          sideEffectsUncertain: false,
          observationError: 'browser_observation_failed',
        };
      }
    }, options.signal);
  }

  wait(options: BrowserWaitOptions): Promise<BrowserObservation> {
    return this.run(async (signal) => {
      const state = await this.resolvePage(options.pageId, false, signal);
      this.throwIfBlockedNavigation(state);
      if (options.expectedOrigin) {
        this.assertExpectedOrigin(state, options.expectedOrigin);
      }
      const timeout = options.timeoutMs ?? DEFAULT_BROWSER_WAIT_TIMEOUT_MS;
      this.assertIntegerRange(
        timeout,
        100,
        MAX_BROWSER_WAIT_TIMEOUT_MS,
        'wait timeout'
      );
      try {
        switch (options.condition.kind) {
          case 'load':
            await state.page.waitForLoadState(options.condition.state, {
              timeout,
              signal,
            });
            break;
          case 'text':
            if (
              byteLength(options.condition.text) === 0 ||
              byteLength(options.condition.text) > MAX_BROWSER_WAIT_TEXT_BYTES
            ) {
              throw new BrowserRuntimeError(
                'browser_unsupported',
                'Browser wait text is empty or exceeds the supported size'
              );
            }
            await state.page
              .getByText(options.condition.text, { exact: true })
              .first()
              .waitFor({ state: 'visible', timeout, signal });
            break;
          case 'url': {
            const expected = normalizeBrowserUrl(options.condition.value);
            await state.page.waitForURL(
              (url) => {
                url.hash = '';
                return url.href === expected.href;
              },
              { timeout, signal }
            );
            break;
          }
          case 'ref': {
            if (!options.expectedOrigin) {
              throw new BrowserRuntimeError(
                'browser_origin_mismatch',
                'Browser ref wait requires expectedOrigin'
              );
            }
            this.assertIdentifier(options.condition.snapshotId, 'snapshot ID');
            if (
              byteLength(options.condition.ref) > MAX_BROWSER_REF_BYTES ||
              !/^[a-z][a-z0-9]*$/.test(options.condition.ref)
            ) {
              throw new BrowserRuntimeError(
                'browser_unsupported',
                'Browser ref is invalid'
              );
            }
            this.snapshots.validate({
              pageId: state.id,
              snapshotId: options.condition.snapshotId,
              pageGeneration: state.generation,
              origin: normalizeExpectedBrowserOrigin(options.expectedOrigin),
              ref: options.condition.ref,
            });
            await state.page.locator(`aria-ref=${options.condition.ref}`).waitFor({
              state: options.condition.state,
              timeout,
              signal,
            });
            break;
          }
          case 'time':
            this.assertIntegerRange(
              options.condition.milliseconds,
              0,
              MAX_BROWSER_EXPLICIT_WAIT_MS,
              'wait duration'
            );
            await delay(options.condition.milliseconds, signal);
            break;
        }
      } catch (error) {
        this.throwIfBlockedNavigation(state);
        this.throwIfDisconnected(error, signal);
        if (isTimeoutError(error)) {
          throw new BrowserRuntimeError('browser_timeout', 'Browser wait timed out', {
            retryable: true,
          });
        }
        throw error;
      }
      return this.observe(state, signal);
    }, options.signal);
  }

  inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult> {
    return this.run(async (signal) => {
      const state = await this.resolvePage(options.pageId, false, signal);
      this.throwIfBlockedNavigation(state);
      if (options.expectedOrigin) {
        this.assertExpectedOrigin(state, options.expectedOrigin);
      }
      if (options.target.kind === 'screenshot') {
        const bytes = await state.page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
          timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
          signal,
        });
        this.throwIfBlockedNavigation(state);
        return {
          pageId: state.id,
          target: 'screenshot',
          artifact: await this.artifacts.writeScreenshot(bytes),
          truncated: false,
        };
      }
      if (options.target.kind === 'find') {
        if (
          byteLength(options.target.text) === 0 ||
          byteLength(options.target.text) > MAX_BROWSER_WAIT_TEXT_BYTES
        ) {
          throw new BrowserRuntimeError(
            'browser_unsupported',
            'Browser find text is empty or exceeds the supported size'
          );
        }
        const limit = options.target.limit ?? DEFAULT_BROWSER_DIAGNOSTIC_RESULT_ENTRIES;
        this.assertIntegerRange(
          limit,
          1,
          MAX_BROWSER_DIAGNOSTIC_RESULT_ENTRIES,
          'limit'
        );
        const observation = await this.observe(state, signal);
        const needle = options.target.text.toLocaleLowerCase('en-US');
        const allMatches = observation.snapshot
          .split('\n')
          .filter((line) => line.toLocaleLowerCase('en-US').includes(needle));
        const matches = allMatches.slice(0, limit);
        return {
          pageId: state.id,
          target: 'find',
          matches,
          snapshotId: observation.snapshotId,
          origin: observation.origin,
          url: observation.url,
          truncated: matches.length < allMatches.length,
        };
      }

      const source =
        options.target.kind === 'console'
          ? this.consoleEntries
          : options.target.kind === 'page-errors'
            ? this.pageErrorEntries
            : this.networkEntries;
      const limit = options.target.limit ?? DEFAULT_BROWSER_DIAGNOSTIC_RESULT_ENTRIES;
      this.assertIntegerRange(limit, 1, MAX_BROWSER_DIAGNOSTIC_RESULT_ENTRIES, 'limit');
      const matching = source.filter((entry) => entry.pageId === state.id);
      const selected = matching.slice(-limit);
      const entries: BrowserDiagnosticEntry[] = [];
      let bytes = 0;
      for (const entry of selected) {
        const entryBytes = byteLength(JSON.stringify(entry));
        if (bytes + entryBytes > MAX_BROWSER_RESULT_BYTES) break;
        entries.push(entry);
        bytes += entryBytes;
      }
      this.throwIfBlockedNavigation(state);
      return {
        pageId: state.id,
        target: options.target.kind,
        entries,
        truncated: entries.length < selected.length || matching.length > limit,
      };
    }, options.signal);
  }

  page(options: BrowserPageOptions): Promise<BrowserPageResult> {
    return this.run(async (signal) => {
      switch (options.action.kind) {
        case 'list':
          return this.pageResult();
        case 'open': {
          const state = await this.createPage(true, signal);
          return {
            ...(await this.pageResult()),
            observation: await this.observe(state, signal),
          };
        }
        case 'select': {
          const state = this.requireExistingPage(options.action.pageId);
          this.selectedPageId = state.id;
          return {
            ...(await this.pageResult()),
            observation: await this.observe(state, signal),
          };
        }
        case 'close': {
          const state = this.requireExistingPage(options.action.pageId);
          await state.page.close({ runBeforeUnload: false });
          this.removePage(state);
          const selected = this.selectedPageId
            ? this.pages.get(this.selectedPageId)
            : undefined;
          return {
            ...(await this.pageResult()),
            ...(selected ? { observation: await this.observe(selected, signal) } : {}),
          };
        }
        case 'reset':
          await this.resetContext();
          return { tabs: [] };
      }
    }, options.signal);
  }

  stats(): {
    pages: number;
    pending: number;
    active: boolean;
    generation: number;
    hasContext: boolean;
    disposed: boolean;
  } {
    const gate = this.gate.stats();
    return {
      pages: this.pages.size,
      pending: gate.pending,
      active: gate.active,
      generation: this.runtimeGeneration,
      hasContext: this.context !== undefined,
      disposed: this.disposed,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const idle = this.gate.close();
    this.generationController.abort(
      new BrowserRuntimeError('browser_disposed', 'Browser Session Runtime is closed')
    );
    const lease = this.lease;
    this.lease = undefined;
    this.clearContextProjection(false);
    await lease?.release();
    await idle;
  }

  private run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const generation = this.runtimeGeneration;
    return this.gate.run(async (gateSignal) => {
      if (generation !== this.runtimeGeneration) {
        throw new BrowserRuntimeError(
          'browser_disconnected',
          'Chromium disconnected before the queued operation started',
          { retryable: true }
        );
      }
      const operationSignal = AbortSignal.any([
        gateSignal,
        this.generationController.signal,
      ]);
      try {
        return await operation(operationSignal);
      } catch (error) {
        this.throwIfDisconnected(error, operationSignal);
        throw error;
      }
    }, signal);
  }

  private async ensureContext(signal: AbortSignal): Promise<BrowserContext> {
    if (this.disposed) {
      throw new BrowserRuntimeError(
        'browser_disposed',
        'Browser Session Runtime is closed'
      );
    }
    if (this.context && this.lease) return this.context;

    const lease = await raceWithAbort(
      this.pool.acquire(() => this.handleDisconnected()),
      signal,
      (lateLease) => lateLease.release()
    );
    const context = lease.context;
    if (this.disposed || signal.aborted) {
      await lease.release();
      throw (
        signal.reason ??
        new BrowserRuntimeError('browser_disposed', 'Browser Session Runtime is closed')
      );
    }
    try {
      await raceWithAbort(
        context.route('**/*', (route) => this.guardRoute(route)),
        signal
      );
      context.setDefaultTimeout(DEFAULT_BROWSER_ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS);
      context.on('page', (page) => {
        this.trackDiscoveredPage(page);
      });
      this.lease = lease;
      this.context = context;
      return context;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  private async createPage(selected: boolean, signal: AbortSignal): Promise<PageState> {
    if (this.pages.size >= MAX_BROWSER_PAGES_PER_SESSION) {
      throw new BrowserRuntimeError(
        'browser_capacity',
        `Browser page capacity is full (max ${MAX_BROWSER_PAGES_PER_SESSION})`,
        { retryable: true }
      );
    }
    const context = await this.ensureContext(signal);
    const page = await raceWithAbort(context.newPage(), signal, (latePage) =>
      latePage.close({ runBeforeUnload: false }).catch(() => undefined)
    );
    const state = this.registerPage(page, selected);
    if (!state) {
      throw new BrowserRuntimeError(
        'browser_capacity',
        `Browser page capacity is full (max ${MAX_BROWSER_PAGES_PER_SESSION})`,
        { retryable: true }
      );
    }
    if (selected) this.selectedPageId = state.id;
    return state;
  }

  private async resolvePage(
    pageId: string | undefined,
    createWhenEmpty: boolean,
    signal: AbortSignal
  ): Promise<PageState> {
    if (pageId) return this.requireExistingPage(pageId);
    if (this.selectedPageId) {
      const selected = this.pages.get(this.selectedPageId);
      if (selected && !selected.page.isClosed()) return selected;
    }
    const first = [...this.pages.values()]
      .filter((state) => !state.page.isClosed())
      .sort((left, right) => left.createdSequence - right.createdSequence)[0];
    if (first) {
      this.selectedPageId = first.id;
      return first;
    }
    if (!createWhenEmpty) {
      throw new BrowserRuntimeError(
        'browser_page_not_found',
        'Browser has no open page'
      );
    }
    return this.createPage(true, signal);
  }

  private requireExistingPage(pageId: string): PageState {
    this.assertIdentifier(pageId, 'page ID');
    const state = this.pages.get(pageId);
    if (!state || state.page.isClosed()) {
      throw new BrowserRuntimeError(
        'browser_page_not_found',
        'Browser page does not exist or is closed'
      );
    }
    return state;
  }

  private registerPage(
    page: Page,
    selected: boolean,
    authorizedOrigin: string | null = null,
    openerPageId?: string
  ): PageState | undefined {
    const existingId = this.pageIds.get(page);
    if (existingId) {
      const existing = this.pages.get(existingId);
      if (existing && openerPageId && !existing.openerPageId) {
        existing.openerPageId = openerPageId;
      }
      if (selected && existing) this.selectedPageId = existing.id;
      return existing;
    }
    if (this.pages.size >= MAX_BROWSER_PAGES_PER_SESSION) {
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
      this.addPageError({
        sequence: ++this.diagnosticSequence,
        pageId: openerPageId ?? this.selectedPageId ?? 'unknown',
        kind: 'popup-capacity',
        text: 'Browser popup closed because the Session page limit was reached',
      });
      return undefined;
    }

    const id = `browser_page_${randomUUID()}`;
    const state: PageState = {
      id,
      page,
      generation: 0,
      authorizedOrigin,
      ...(openerPageId ? { openerPageId } : {}),
      createdSequence: ++this.pageSequence,
    };
    this.pages.set(id, state);
    this.pageIds.set(page, id);
    if (selected || !this.selectedPageId) this.selectedPageId = id;
    this.attachPageListeners(state);
    return state;
  }

  private async registerDiscoveredPage(page: Page): Promise<void> {
    if (this.disposed) return;
    const opener = await page.opener().catch(() => null);
    if (this.disposed) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      return;
    }
    const openerId =
      (opener ? this.pageIds.get(opener) : undefined) ?? this.popupOpeners.get(page);
    const openerState = openerId ? this.pages.get(openerId) : undefined;
    const blockedPopup = this.takeBlockedPopup(openerState);
    const inheritedOrigin = openerState?.authorizedOrigin ?? null;
    const state = this.registerPage(page, false, inheritedOrigin, openerState?.id);
    if (!state) return;
    const currentOrigin = browserOriginFromPageUrl(page.url());
    const blockedOrigin =
      state.blockedCandidateOrigin ??
      blockedPopup?.origin ??
      (currentOrigin && currentOrigin !== inheritedOrigin ? currentOrigin : undefined);
    if (blockedOrigin) {
      state.blockedCandidateOrigin = blockedOrigin;
      if (openerState) openerState.blockedCandidateOrigin = blockedOrigin;
      if (!blockedPopup) {
        this.addNetwork({
          sequence: ++this.diagnosticSequence,
          pageId: openerState?.id ?? state.id,
          kind: 'navigation-blocked',
          url: blockedOrigin,
          text: 'Cross-origin popup was blocked',
        });
      }
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      this.removePage(state);
    }
  }

  private trackDiscoveredPage(page: Page, openerPageId?: string): Promise<void> {
    if (openerPageId) this.popupOpeners.set(page, openerPageId);
    const existing = this.pageRegistrations.get(page);
    if (existing) return existing;
    const registration = this.registerDiscoveredPage(page);
    this.pageRegistrations.set(page, registration);
    this.pendingPageRegistrations.add(registration);
    void registration
      .finally(() => this.pendingPageRegistrations.delete(registration))
      .catch(() => undefined);
    return registration;
  }

  private takeBlockedPopup(
    openerState: PageState | undefined
  ): BlockedPopup | undefined {
    const exactIndex = openerState
      ? this.blockedPopups.findIndex(
          (blocked) => blocked.openerPageId === openerState.id
        )
      : -1;
    const inferredIndex =
      exactIndex === -1 && openerState
        ? this.blockedPopups.findIndex(
            (blocked) =>
              blocked.openerPageId === undefined &&
              blocked.referrerOrigin === openerState.authorizedOrigin
          )
        : -1;
    const index = exactIndex !== -1 ? exactIndex : inferredIndex;
    return index === -1 ? undefined : this.blockedPopups.splice(index, 1)[0];
  }

  private async settlePageRegistrations(signal: AbortSignal): Promise<void> {
    const pending = [...this.pendingPageRegistrations];
    if (pending.length === 0) return;
    await raceWithAbort(
      Promise.allSettled(pending).then(() => undefined),
      signal
    );
  }

  private attachPageListeners(state: PageState): void {
    const { page } = state;
    page.on('framenavigated', (frame) => this.handleFrameNavigated(state, frame));
    page.on('close', () => this.removePage(state));
    page.on('console', (message) => this.recordConsole(state, message));
    page.on('pageerror', (error) => {
      this.addPageError({
        sequence: ++this.diagnosticSequence,
        pageId: state.id,
        kind: 'page-error',
        text: boundedErrorMessage(error),
      });
    });
    page.on('request', (request) => this.recordRequest(state, request));
    page.on('response', (response) => this.recordResponse(state, response));
    page.on('requestfailed', (request) => this.recordRequestFailure(state, request));
    page.on('dialog', (dialog) => {
      void this.dismissDialog(state, dialog);
    });
    page.on('download', (download) => {
      this.trackDownloadCancellation(state, download);
    });
    page.on('popup', (popup) => {
      void this.trackDiscoveredPage(popup, state.id);
    });
  }

  private handleFrameNavigated(state: PageState, frame: Frame): void {
    if (frame !== state.page.mainFrame()) {
      void this.captureOpaqueFrame(frame);
      return;
    }
    this.invalidatePage(state);
    const origin = browserOriginFromPageUrl(frame.url());
    const allowed = state.transientOrigin ?? state.authorizedOrigin;
    if (origin === null) {
      if (allowed) {
        state.blockedCandidateOrigin ??= '[unsupported-origin]';
      }
      state.authorizedOrigin = null;
      return;
    }
    if (origin !== allowed) {
      state.blockedCandidateOrigin ??= origin;
      state.authorizedOrigin = null;
      return;
    }
    state.authorizedOrigin = origin;
  }

  private async guardRoute(route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }
    let frame: Frame;
    try {
      frame = request.frame();
    } catch {
      const candidateOrigin = (() => {
        try {
          return normalizeBrowserUrl(request.url()).origin;
        } catch {
          return '[unsupported-origin]';
        }
      })();
      const referrerOrigin = this.browserRequestReferrerOrigin(request);
      const openerState = this.resolvePopupOpenerFromReferrer(request);
      if (
        openerState?.authorizedOrigin &&
        candidateOrigin === openerState.authorizedOrigin
      ) {
        await route.continue();
        return;
      }
      if (openerState) openerState.blockedCandidateOrigin = candidateOrigin;
      this.blockedPopups.push({
        origin: candidateOrigin,
        ...(openerState ? { openerPageId: openerState.id } : {}),
        ...(referrerOrigin ? { referrerOrigin } : {}),
      });
      if (this.blockedPopups.length > MAX_BROWSER_PAGES_PER_SESSION) {
        this.blockedPopups.splice(
          0,
          this.blockedPopups.length - MAX_BROWSER_PAGES_PER_SESSION
        );
      }
      this.addNetwork({
        sequence: ++this.diagnosticSequence,
        pageId: openerState?.id ?? 'unknown',
        kind: 'navigation-blocked',
        url: candidateOrigin,
        text: 'Cross-origin top-level navigation was blocked',
      });
      await route.abort('blockedbyclient');
      return;
    }
    if (frame.parentFrame()) {
      if (await this.isFrameSandboxOpaque(frame)) {
        this.opaqueFrames.add(frame);
      } else {
        this.opaqueFrames.delete(frame);
      }
      await route.continue();
      return;
    }

    const page = frame.page();
    let state = this.pageIds.get(page)
      ? this.pages.get(this.pageIds.get(page)!)
      : undefined;
    const opener = await page.opener().catch(() => null);
    const openerId =
      this.popupOpeners.get(page) ?? (opener ? this.pageIds.get(opener) : undefined);
    const openerState = openerId ? this.pages.get(openerId) : undefined;
    if (!state) {
      state = this.registerPage(
        page,
        false,
        openerState?.authorizedOrigin ?? null,
        openerState?.id
      );
    } else if (openerState && !state.openerPageId) {
      state.openerPageId = openerState.id;
    }
    if (!state) {
      await route.abort('blockedbyclient');
      return;
    }

    let candidateOrigin: string;
    try {
      candidateOrigin = normalizeBrowserUrl(request.url()).origin;
    } catch {
      state.blockedCandidateOrigin = '[unsupported-origin]';
      await route.abort('blockedbyclient');
      return;
    }
    const allowed = state.transientOrigin ?? state.authorizedOrigin;
    if (!allowed || candidateOrigin !== allowed) {
      state.blockedCandidateOrigin = candidateOrigin;
      const actionState = state.openerPageId
        ? this.pages.get(state.openerPageId)
        : undefined;
      if (actionState) actionState.blockedCandidateOrigin = candidateOrigin;
      this.addNetwork({
        sequence: ++this.diagnosticSequence,
        pageId: actionState?.id ?? state.id,
        kind: 'navigation-blocked',
        url: candidateOrigin,
        text: 'Cross-origin top-level navigation was blocked',
      });
      await route.abort('blockedbyclient');
      if (state.openerPageId) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        this.removePage(state);
      }
      return;
    }
    await route.continue();
  }

  private browserRequestReferrerOrigin(request: Request): string | undefined {
    const referrer = request.headers().referer;
    if (!referrer) return undefined;
    try {
      return normalizeBrowserUrl(referrer).origin;
    } catch {
      return undefined;
    }
  }

  private resolvePopupOpenerFromReferrer(request: Request): PageState | undefined {
    const referrer = request.headers().referer;
    if (!referrer) return undefined;

    let normalizedReferrer;
    try {
      normalizedReferrer = normalizeBrowserUrl(referrer);
    } catch {
      return undefined;
    }
    const candidates = [...this.pages.values()].filter(
      (state) =>
        !state.page.isClosed() && state.authorizedOrigin === normalizedReferrer.origin
    );
    const exact = candidates.filter((state) => {
      try {
        return normalizeBrowserUrl(state.page.url()).href === normalizedReferrer.href;
      } catch {
        return false;
      }
    });
    const referrerIdentifiesDocument =
      normalizedReferrer.url.pathname !== '/' ||
      normalizedReferrer.url.search.length > 0;
    if (referrerIdentifiesDocument && exact.length === 1) return exact[0];
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private settleNavigationAuthorization(
    state: PageState,
    targetOrigin: string | null,
    previousOrigin: string | null
  ): void {
    const currentOrigin = browserOriginFromPageUrl(state.page.url());
    if (currentOrigin === targetOrigin) {
      state.authorizedOrigin = targetOrigin;
    } else if (currentOrigin === previousOrigin) {
      state.authorizedOrigin = previousOrigin;
    } else {
      state.authorizedOrigin = null;
    }
  }

  private assertExpectedOrigin(state: PageState, expectedOrigin: string): string {
    const normalizedExpectedOrigin = normalizeExpectedBrowserOrigin(expectedOrigin);
    const currentOrigin = browserOriginFromPageUrl(state.page.url());
    if (
      state.authorizedOrigin === null ||
      currentOrigin !== state.authorizedOrigin ||
      normalizedExpectedOrigin !== state.authorizedOrigin
    ) {
      throw new BrowserRuntimeError(
        'browser_origin_mismatch',
        'Browser page origin changed; capture a new snapshot or navigate explicitly'
      );
    }
    return normalizedExpectedOrigin;
  }

  private throwIfBlockedNavigation(state: PageState): void {
    if (!state.blockedCandidateOrigin) return;
    throw new BrowserRuntimeError(
      'browser_cross_origin_navigation',
      `Cross-origin navigation was blocked: ${state.blockedCandidateOrigin}`,
      { candidateOrigin: state.blockedCandidateOrigin }
    );
  }

  private markUnexpectedInteractionOrigin(
    state: PageState,
    expectedOrigin: string
  ): void {
    if (state.page.isClosed() || state.blockedCandidateOrigin) return;
    const currentOrigin = browserOriginFromPageUrl(state.page.url());
    if (currentOrigin !== expectedOrigin) {
      state.blockedCandidateOrigin = currentOrigin ?? '[unsupported-origin]';
    }
  }

  private async resolveEffectiveFrameOrigin(frame: Frame): Promise<string | null> {
    let current: Frame | null = frame;
    let effectiveOrigin: string | null = null;
    while (current) {
      if (current !== current.page().mainFrame()) {
        if (
          this.opaqueFrames.has(current) ||
          (await this.isFrameSandboxOpaque(current))
        ) {
          this.opaqueFrames.add(current);
          return null;
        }
      }

      const origin = browserOriginFromPageUrl(current.url());
      if (origin) {
        if (effectiveOrigin && origin !== effectiveOrigin) return null;
        effectiveOrigin ??= origin;
      } else if (current.url() !== 'about:blank' && current.url() !== 'about:srcdoc') {
        return null;
      }
      current = current.parentFrame();
    }
    return effectiveOrigin;
  }

  private async captureOpaqueFrame(frame: Frame): Promise<void> {
    if (await this.isFrameSandboxOpaque(frame)) {
      this.opaqueFrames.add(frame);
    }
  }

  private async isFrameSandboxOpaque(frame: Frame): Promise<boolean> {
    try {
      const frameElement = await frame.frameElement();
      try {
        const sandbox = await frameElement.getAttribute('sandbox');
        return (
          sandbox !== null &&
          !sandbox
            .toLowerCase()
            .split(/\s+/u)
            .filter(Boolean)
            .includes('allow-same-origin')
        );
      } finally {
        await frameElement.dispose().catch(() => undefined);
      }
    } catch {
      return true;
    }
  }

  private async observe(
    state: PageState,
    signal: AbortSignal,
    depth = DEFAULT_BROWSER_SNAPSHOT_DEPTH,
    includeBoxes = false
  ): Promise<BrowserObservation> {
    if (state.page.isClosed()) {
      throw new BrowserRuntimeError('browser_page_not_found', 'Browser page is closed');
    }
    this.throwIfBlockedNavigation(state);
    const rawSnapshot = await state.page.ariaSnapshot({
      mode: 'ai',
      depth,
      boxes: includeBoxes,
      timeout: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      signal,
    });
    this.throwIfBlockedNavigation(state);
    const tabs = await this.pageSummaries();
    const origin = browserOriginFromPageUrl(state.page.url()) ?? 'null';
    const title = sanitizeBrowserText(
      await state.page.title().catch(() => ''),
      MAX_BROWSER_TITLE_BYTES
    );
    const record = this.snapshots.issue({
      pageId: state.id,
      pageGeneration: state.generation,
      origin,
      snapshot: rawSnapshot,
      depth,
      includeBoxes,
      maxBytes: Math.min(MAX_BROWSER_SNAPSHOT_BYTES, 32 * 1024),
    });
    return {
      pageId: state.id,
      snapshotId: record.snapshotId,
      url: projectBrowserUrl(state.page.url()),
      origin,
      title,
      tabs,
      snapshot: record.snapshot,
      truncated: record.truncated,
    };
  }

  private async pageResult(): Promise<BrowserPageResult> {
    return {
      tabs: await this.pageSummaries(),
      ...(this.selectedPageId ? { selectedPageId: this.selectedPageId } : {}),
    };
  }

  private async pageSummaries() {
    return Promise.all(
      [...this.pages.values()]
        .filter((state) => !state.page.isClosed())
        .sort((left, right) => left.createdSequence - right.createdSequence)
        .map(async (state) => ({
          pageId: state.id,
          selected: state.id === this.selectedPageId,
          url: projectBrowserUrl(state.page.url()),
          origin: browserOriginFromPageUrl(state.page.url()) ?? 'null',
          title: sanitizeBrowserText(
            await state.page.title().catch(() => ''),
            MAX_BROWSER_TITLE_BYTES
          ),
        }))
    );
  }

  private invalidatePage(state: PageState): void {
    state.generation++;
    this.snapshots.invalidate(state.id);
  }

  private assertIdentifier(value: string, label: string): void {
    if (!value || byteLength(value) > MAX_BROWSER_ID_BYTES) {
      throw new BrowserRuntimeError(
        'browser_unsupported',
        `Browser ${label} is invalid`
      );
    }
  }

  private assertIntegerRange(
    value: number,
    minimum: number,
    maximum: number,
    label: string
  ): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new BrowserRuntimeError(
        'browser_unsupported',
        `Browser ${label} must be an integer from ${minimum} to ${maximum}`
      );
    }
  }

  private validateAction(action: BrowserAction): void {
    if (action.kind === 'fill' || action.kind === 'type') {
      if (byteLength(action.value) > MAX_BROWSER_INPUT_BYTES) {
        throw new BrowserRuntimeError(
          'browser_unsupported',
          'Browser input exceeds the supported size'
        );
      }
      return;
    }
    if (action.kind === 'scroll') {
      this.assertIntegerRange(
        action.amount,
        1,
        MAX_BROWSER_SCROLL_AMOUNT,
        'scroll amount'
      );
      return;
    }
    if (action.kind !== 'select') return;
    if (
      action.values.length === 0 ||
      action.values.length > MAX_BROWSER_SELECT_VALUES ||
      action.values.some(
        (value) => byteLength(value) > MAX_BROWSER_SELECT_VALUE_BYTES
      ) ||
      byteLength(action.values.join('')) > MAX_BROWSER_INPUT_BYTES
    ) {
      throw new BrowserRuntimeError(
        'browser_unsupported',
        'Browser select values exceed the supported size'
      );
    }
  }

  private removePage(state: PageState): void {
    if (this.pages.get(state.id) !== state) return;
    this.pages.delete(state.id);
    this.snapshots.invalidate(state.id);
    if (this.selectedPageId === state.id) {
      const replacement = [...this.pages.values()].sort(
        (left, right) => left.createdSequence - right.createdSequence
      )[0];
      this.selectedPageId = replacement?.id;
    }
  }

  private async resetContext(): Promise<void> {
    this.runtimeGeneration++;
    this.generationController.abort(
      new BrowserRuntimeError(
        'browser_disconnected',
        'Browser Context was explicitly reset',
        { retryable: true }
      )
    );
    this.generationController = new AbortController();
    const lease = this.lease;
    this.lease = undefined;
    this.clearContextProjection(true);
    await lease?.release();
  }

  private clearContextProjection(clearDiagnostics: boolean): void {
    this.snapshots.clear();
    this.pages.clear();
    this.blockedPopups.length = 0;
    this.selectedPageId = undefined;
    this.context = undefined;
    if (clearDiagnostics) {
      this.consoleEntries.length = 0;
      this.pageErrorEntries.length = 0;
      this.networkEntries.length = 0;
    }
  }

  private async executeAction(
    page: Page,
    locator: ReturnType<Page['locator']> | undefined,
    action: BrowserAction,
    timeout: number,
    signal: AbortSignal
  ): Promise<void> {
    if (action.kind === 'scroll') {
      const distance =
        action.direction === 'up' || action.direction === 'left'
          ? -action.amount
          : action.amount;
      const deltaX =
        action.direction === 'left' || action.direction === 'right' ? distance : 0;
      const deltaY =
        action.direction === 'up' || action.direction === 'down' ? distance : 0;
      await raceWithAbort(page.mouse.wheel(deltaX, deltaY), signal);
      return;
    }
    if (!locator) {
      throw new BrowserRuntimeError(
        'browser_unsupported',
        'Browser action requires a snapshot ref'
      );
    }
    switch (action.kind) {
      case 'click':
        await locator.click({ timeout, signal });
        break;
      case 'hover':
        await locator.hover({ timeout, signal });
        break;
      case 'fill':
        await locator.fill(action.value, { timeout, signal });
        break;
      case 'type':
        await locator.pressSequentially(action.value, { timeout, signal });
        break;
      case 'press':
        await locator.press(action.key, { timeout, signal });
        break;
      case 'select':
        await locator.selectOption(
          action.values.map((value) => ({ value })),
          { timeout, signal }
        );
        break;
      case 'check':
        await locator.check({ timeout, signal });
        break;
      case 'uncheck':
        await locator.uncheck({ timeout, signal });
        break;
    }
  }

  private uncertainInteraction(
    state: PageState,
    generation: number,
    error: unknown
  ): BrowserInteractionResult {
    let errorCode:
      | 'browser_cross_origin_navigation'
      | 'browser_disconnected'
      | 'browser_timeout'
      | 'browser_action_uncertain' = 'browser_action_uncertain';
    if (state.blockedCandidateOrigin) {
      errorCode = 'browser_cross_origin_navigation';
    } else if (generation !== this.runtimeGeneration || isBrowserClosedError(error)) {
      errorCode = 'browser_disconnected';
    } else if (isTimeoutError(error)) {
      errorCode = 'browser_timeout';
    }
    return {
      outcome: 'uncertain',
      pageId: state.id,
      actionApplied: 'unknown',
      sideEffectsUncertain: true,
      errorCode,
      ...(state.blockedCandidateOrigin
        ? { candidateOrigin: state.blockedCandidateOrigin }
        : {}),
    };
  }

  private recordConsole(state: PageState, message: ConsoleMessage): void {
    this.addConsole({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'console',
      level: sanitizeBrowserText(message.type(), 64),
      text: sanitizeBrowserText(message.text(), MAX_BROWSER_DIAGNOSTIC_TEXT_BYTES),
    });
  }

  private recordRequest(state: PageState, request: Request): void {
    this.addNetwork({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'request',
      method: sanitizeBrowserText(request.method(), 32),
      resourceType: sanitizeBrowserText(request.resourceType(), 64),
      url: projectBrowserUrl(request.url()),
    });
  }

  private recordResponse(state: PageState, response: Response): void {
    this.addNetwork({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'response',
      status: response.status(),
      url: projectBrowserUrl(response.url()),
    });
  }

  private recordRequestFailure(state: PageState, request: Request): void {
    this.addNetwork({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'request-failure',
      method: sanitizeBrowserText(request.method(), 32),
      resourceType: sanitizeBrowserText(request.resourceType(), 64),
      url: projectBrowserUrl(request.url()),
      text: sanitizeBrowserText(
        request.failure()?.errorText ?? 'request failed',
        MAX_BROWSER_DIAGNOSTIC_TEXT_BYTES
      ),
    });
  }

  private async dismissDialog(state: PageState, dialog: Dialog): Promise<void> {
    this.addPageError({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'dialog',
      text: sanitizeBrowserText(
        `${dialog.type()}: ${dialog.message()}`,
        MAX_BROWSER_DIAGNOSTIC_TEXT_BYTES
      ),
    });
    const action = state.nextDialogAction;
    state.nextDialogAction = undefined;
    if (action === 'accept') {
      await dialog.accept().catch(() => undefined);
    } else {
      await dialog.dismiss().catch(() => undefined);
    }
  }

  private async cancelDownload(state: PageState, download: Download): Promise<void> {
    state.downloadBlocked = true;
    this.addPageError({
      sequence: ++this.diagnosticSequence,
      pageId: state.id,
      kind: 'download',
      text: 'Browser download was blocked',
    });
    await download.cancel().catch(() => undefined);
  }

  private trackDownloadCancellation(state: PageState, download: Download): void {
    if (this.downloadCancellations.has(download)) return;
    const cancellation = this.cancelDownload(state, download);
    this.downloadCancellations.set(download, cancellation);
    this.pendingDownloadCancellations.add(cancellation);
    void cancellation
      .finally(() => this.pendingDownloadCancellations.delete(cancellation))
      .catch(() => undefined);
  }

  private async settleDownloadCancellations(signal: AbortSignal): Promise<void> {
    const pending = [...this.pendingDownloadCancellations];
    if (pending.length === 0) return;
    await raceWithAbort(
      Promise.allSettled(pending).then(() => undefined),
      signal
    );
  }

  private addConsole(entry: BrowserDiagnosticEntry): void {
    this.consoleEntries.push(entry);
    this.trimRing(this.consoleEntries);
  }

  private addPageError(entry: BrowserDiagnosticEntry): void {
    this.pageErrorEntries.push(entry);
    this.trimRing(this.pageErrorEntries);
  }

  private addNetwork(entry: BrowserDiagnosticEntry): void {
    this.networkEntries.push(entry);
    this.trimRing(this.networkEntries);
  }

  private trimRing(entries: BrowserDiagnosticEntry[]): void {
    if (entries.length > MAX_BROWSER_DIAGNOSTIC_ENTRIES) {
      entries.splice(0, entries.length - MAX_BROWSER_DIAGNOSTIC_ENTRIES);
    }
  }

  private handleDisconnected(): void {
    this.runtimeGeneration++;
    this.generationController.abort(
      new BrowserRuntimeError(
        'browser_disconnected',
        'Chromium disconnected; Browser state was discarded',
        { retryable: true }
      )
    );
    this.generationController = new AbortController();
    this.lease = undefined;
    this.clearContextProjection(false);
  }

  private throwIfDisconnected(error: unknown, signal: AbortSignal): void {
    if (signal.aborted && signal.reason instanceof BrowserRuntimeError) {
      throw signal.reason;
    }
    if (isBrowserClosedError(error)) {
      throw new BrowserRuntimeError(
        'browser_disconnected',
        'Chromium disconnected during the Browser operation',
        { retryable: true }
      );
    }
  }
}
