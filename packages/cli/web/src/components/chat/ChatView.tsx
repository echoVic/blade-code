import type {
  CommunicationStyle,
  ReasoningEffort,
  ResponseVerbosity,
  ServiceTier,
} from '@api/schemas';
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TaskArtifactBar } from '@/components/tasks/TaskArtifactBar';
import { useT } from '@/i18n';
import { focusBladeComposer } from '@/lib/composerFocus';
import { taskFailureIsRetryable, taskFailureMessageKey } from '@/lib/taskFailure';
import { useAppStore } from '@/store/AppStore';
import { useSessionStore } from '@/store/session';
import { rejectHistorySurfaceAction } from '@/store/session/historySurfaceGuard';
import { sameSessionRef, sessionRefKey } from '@/store/session/sessionIdentity';
import type { ComposerImageAttachment } from './ChatInput';
import { ChatInput } from './ChatInput';
import { ChatList } from './ChatList';
import { GoalControlBar } from './GoalControlBar';
import { PendingInteractionBar } from './PendingInteractionBar';
import { SideConversationPanel } from './SideConversationPanel';
import { StatusBar } from './StatusBar';
import { TeamPanel } from './TeamPanel';

interface RecoveryDraft {
  revision: number;
  content: string;
  attachments: ComposerImageAttachment[];
}

function recoverLastUserDraft(
  messages: ReturnType<typeof useSessionStore.getState>['messages']
): Omit<RecoveryDraft, 'revision'> | null {
  const message = [...messages]
    .reverse()
    .find((candidate) => candidate.role === 'user');
  if (!message) return null;
  if (typeof message.content === 'string') {
    return { content: message.content, attachments: [] };
  }
  const content = message.content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n');
  const attachments = message.content
    .filter(
      (part): part is Extract<typeof part, { type: 'image_url' }> =>
        part.type === 'image_url'
    )
    .map((part, index) => {
      const mimeType =
        part.image_url.url.match(/^data:([^;,]+)[;,]/)?.[1] ??
        'application/octet-stream';
      return {
        id: `recovery-${message.id}-${index}`,
        name: `attachment-${index + 1}`,
        mimeType,
        dataUrl: part.image_url.url,
      };
    });
  return { content, attachments };
}

function PreviewActivityDisclosure({
  messages,
  isLoading,
  isStreaming,
  isStopping,
  errorMessage,
}: {
  messages: ReturnType<typeof useSessionStore.getState>['messages'];
  isLoading: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  errorMessage?: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const label = errorMessage
    ? t('status.phase.error')
    : isStopping
      ? t('chat.input.action.stopping')
      : isStreaming
        ? t('status.phase.running')
        : t('preview.files.status.ready');

  return (
    <details
      data-preview-status-disclosure
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group hidden"
    >
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--deck-accent))]">
        {isStreaming && <span className="deck-pulse-dot" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      {expanded && (
        <div
          data-preview-activity-details
          className="flex h-[min(44vh,420px)] min-h-0 flex-col border-t border-[hsl(var(--deck-hairline))]"
        >
          {errorMessage && (
            <div
              role="alert"
              className="border-b border-red-200/60 bg-red-50/80 px-3 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
            >
              {errorMessage}
            </div>
          )}
          <ChatList messages={messages} isLoading={isLoading} />
          <StatusBar />
        </div>
      )}
    </details>
  );
}

export function ChatView() {
  const t = useT();
  const messages = useSessionStore((state) => state.messages);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isStopping = useSessionStore((state) => state.isStopping);
  const sessionEventConnectionState = useSessionStore(
    (state) => state.sessionEventConnectionState
  );
  const pendingSteeringCount = useSessionStore((state) => state.pendingSteeringCount);
  const pendingInputDelivery = useSessionStore((state) => state.pendingInputDelivery);
  const recoveredSteeringCount = useSessionStore(
    (state) => state.recoveredSteeringCount
  );
  const isLoading = useSessionStore((state) => state.isLoading);
  const error = useSessionStore((state) => state.error);
  const errorContext = useSessionStore((state) => state.errorContext);
  const sessions = useSessionStore((state) => state.sessions);
  const sendMessage = useSessionStore((state) => state.sendMessage);
  const abortSession = useSessionStore((state) => state.abortSession);
  const retryTask = useSessionStore((state) => state.retryTask);
  const retryingTaskKeys = useSessionStore((state) => state.retryingTaskKeys);
  const openSettings = useAppStore((state) => state.openSettings);
  const reconnectSessionEvents = useSessionStore(
    (state) => state.reconnectSessionEvents
  );
  const clearError = useSessionStore((state) => state.clearError);
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(null);
  const currentSession = currentSessionRef
    ? sessions.find(
        (session) =>
          session.sessionId === currentSessionRef.sessionId &&
          session.projectPath === currentSessionRef.projectPath
      )
    : undefined;
  const errorIsVisible =
    Boolean(error) &&
    (errorContext?.kind === 'navigation' ||
      !errorContext?.sessionRef ||
      sameSessionRef(errorContext.sessionRef, currentSessionRef));
  const failureCode = errorContext?.failureCode ?? currentSession?.taskFailure?.code;
  const errorMessage =
    (errorContext?.kind === 'execution' || errorContext?.failureCode) && failureCode
      ? t(taskFailureMessageKey(failureCode))
      : error === 'queue_full'
        ? t('chat.error.queueFull')
        : error === 'turn_unavailable' || error === 'turn_active'
          ? t('chat.error.turnChanged')
          : error;
  const isReconnecting =
    sessionEventConnectionState === 'connecting' ||
    sessionEventConnectionState === 'reconnecting';
  const liveUpdatesUnavailable =
    isStreaming && sessionEventConnectionState !== 'connected';
  const composerDraftKey = currentSessionRef
    ? `session:${sessionRefKey(currentSessionRef)}`
    : 'session:temporary';
  const recoverableDraft = useMemo(() => recoverLastUserDraft(messages), [messages]);
  const currentSessionKey = currentSessionRef
    ? sessionRefKey(currentSessionRef)
    : 'temporary-session';
  const canRetryTask =
    Boolean(
      currentSessionRef &&
        currentSession?.taskRetryAvailable &&
        (!failureCode || taskFailureIsRetryable(failureCode))
    ) &&
    (errorContext?.kind === 'execution' || errorContext?.kind === 'task_action');
  const shouldConfigureModel =
    errorContext?.kind === 'execution' &&
    (failureCode === 'authentication' ||
      failureCode === 'permission' ||
      failureCode === 'model_unavailable');
  const isRetryingTask = currentSessionRef
    ? retryingTaskKeys.includes(sessionRefKey(currentSessionRef))
    : false;

  useEffect(() => {
    setRecoveryDraft(null);
  }, [currentSessionKey]);

  const handleSend = async (payload: {
    content: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
    serviceTier?: ServiceTier;
    responseVerbosity?: ResponseVerbosity;
    communicationStyle?: CommunicationStyle;
    attachments: ComposerImageAttachment[];
    outputSchema?: Record<string, unknown>;
  }) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return false;
    return sendMessage({
      content: payload.content,
      modelId: payload.modelId,
      reasoningEffort: payload.reasoningEffort,
      serviceTier: payload.serviceTier,
      responseVerbosity: payload.responseVerbosity,
      communicationStyle: payload.communicationStyle,
      ...(payload.outputSchema ? { outputSchema: payload.outputSchema } : {}),
      attachments: payload.attachments.map((attachment) => ({
        type: 'image' as const,
        content: attachment.dataUrl,
        mimeType: attachment.mimeType,
        name: attachment.name,
      })),
    });
  };

  const handleAbort = () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    return abortSession();
  };
  const recoverFromError = async () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (shouldConfigureModel) {
      clearError();
      openSettings('models');
      return;
    }
    if (canRetryTask && currentSessionRef) {
      clearError();
      await retryTask(currentSessionRef).catch(() => undefined);
      return;
    }
    if (errorContext?.kind === 'execution' && recoverableDraft) {
      setRecoveryDraft({
        ...recoverableDraft,
        revision: Date.now(),
      });
      clearError();
      return;
    }
    clearError();
    requestAnimationFrame(() => focusBladeComposer());
  };
  const recoveryActionLabel = canRetryTask
    ? isRetryingTask
      ? t('chat.error.action.retryingTask')
      : t('chat.error.action.retryTask')
    : shouldConfigureModel
      ? t('chat.error.action.checkModels')
      : errorContext?.kind === 'execution' && recoverableDraft
        ? t('chat.error.action.editResend')
        : errorContext?.kind === 'submission'
          ? t('chat.error.action.returnDraft')
          : null;

  return (
    <div data-chat-view className="flex h-full flex-col bg-[hsl(var(--deck-canvas))]">
      <div data-chat-history className="contents">
        {errorIsVisible && (
          <div
            role="alert"
            data-blade-session-error
            className="flex min-h-11 flex-wrap items-center gap-2 border-b border-red-200/60 bg-red-50/80 px-4 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300 sm:px-5"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              <span className="font-semibold">
                {t(
                  errorContext?.kind === 'submission'
                    ? 'chat.error.title.submission'
                    : errorContext?.kind === 'execution'
                      ? 'chat.error.title.execution'
                      : errorContext?.kind === 'navigation'
                        ? 'chat.error.title.navigation'
                        : 'chat.error.title.generic'
                )}
              </span>{' '}
              {errorMessage}
            </span>
            {recoveryActionLabel && (
              <button
                type="button"
                onClick={() => void recoverFromError()}
                disabled={isRetryingTask}
                className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border border-red-300/70 bg-white/65 px-2.5 font-medium transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60 dark:border-red-800 dark:bg-red-950/45 dark:hover:bg-red-900/60"
              >
                {canRetryTask ? (
                  isRetryingTask ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )
                ) : (
                  <Pencil className="h-3 w-3" />
                )}
                {recoveryActionLabel}
              </button>
            )}
            <button
              type="button"
              onClick={clearError}
              aria-label={t('chat.error.dismiss')}
              className="p-1 text-red-500 rounded transition-colors hover:bg-red-100/60 hover:text-red-700 dark:hover:bg-red-950/60 dark:hover:text-red-100"
            >
              ✕
            </button>
          </div>
        )}
        {(isReconnecting || sessionEventConnectionState === 'offline') && (
          <div
            role={sessionEventConnectionState === 'offline' ? 'alert' : 'status'}
            aria-live="polite"
            className="flex min-h-10 flex-wrap items-center gap-2 border-b border-amber-300/60 bg-amber-50/80 px-4 py-2 font-mono text-[11px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-200 sm:px-5"
          >
            {isReconnecting ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1">
              {isReconnecting
                ? t('chat.connection.reconnecting')
                : t('chat.connection.offline')}
            </span>
            {sessionEventConnectionState === 'offline' && (
              <button
                type="button"
                onClick={() => {
                  if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
                  void reconnectSessionEvents().catch(() => undefined);
                }}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-amber-400/70 bg-white/60 px-2.5 font-medium transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700 dark:bg-amber-950/50 dark:hover:bg-amber-900/50"
              >
                <RefreshCw className="h-3 w-3" />
                {t('chat.connection.retry')}
              </button>
            )}
          </div>
        )}
        <TaskArtifactBar />
        <ChatList
          key={
            currentSessionRef ? sessionRefKey(currentSessionRef) : 'temporary-session'
          }
          messages={messages}
          isLoading={isLoading}
        />
        <TeamPanel />
        <SideConversationPanel />
      </div>
      <div data-chat-composer-dock className="contents">
        <PreviewActivityDisclosure
          key={currentSessionKey}
          messages={messages}
          isLoading={isLoading}
          isStreaming={isStreaming}
          isStopping={isStopping}
          errorMessage={errorIsVisible ? errorMessage : null}
        />
        <PendingInteractionBar />
        <GoalControlBar />
        <ChatInput
          key={composerDraftKey}
          draftKey={composerDraftKey}
          draft={recoveryDraft?.content}
          draftAttachments={recoveryDraft?.attachments}
          draftRevision={recoveryDraft?.revision}
          onSend={handleSend}
          onAbort={handleAbort}
          disabled={isLoading || liveUpdatesUnavailable}
          isStreaming={isStreaming}
          isStopping={isStopping}
          pendingSteeringCount={pendingSteeringCount}
          pendingInputDelivery={pendingInputDelivery}
          recoveredSteeringCount={recoveredSteeringCount}
          workspacePath={currentSessionRef?.projectPath}
        />
        <div data-chat-primary-status className="contents">
          <StatusBar />
        </div>
      </div>
    </div>
  );
}
