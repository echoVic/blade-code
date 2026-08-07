import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { applyAtMentionSuggestion, useAtMention } from '@/hooks/useAtMention';
import { useInputHistory } from '@/hooks/useInputHistory';
import { applySlashCommandSuggestion, useSlashCommand } from '@/hooks/useSlashCommand';
import { type TranslationKey, useT } from '@/i18n';
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '@/lib/composerDraft';
import {
  type ImageAttachmentLimitReason,
  inlineImageBytes,
  validateImageAttachmentBatch,
} from '@/lib/imageAttachments';
import {
  type PermissionMode,
  PermissionModeEnum,
  useConfigStore,
} from '@/store/ConfigStore';
import { useSessionStore } from '@/store/session';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENT_COUNT,
} from '@api/attachmentLimits';
import {
  AlertCircle,
  ChevronDown,
  Info,
  Loader2,
  Paperclip,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SuggestionPopover } from './SuggestionPopover';

export interface ComposerImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

interface ChatInputProps {
  onSend: (payload: {
    content: string;
    modelId?: string;
    attachments: ComposerImageAttachment[];
  }) => boolean | void | Promise<boolean | void>;
  onAbort?: () => void | Promise<unknown>;
  disabled?: boolean;
  submitDisabled?: boolean;
  isStreaming?: boolean;
  isStopping?: boolean;
  pendingSteeringCount?: number;
  pendingInputDelivery?: 'current_turn' | 'next_turn' | null;
  recoveredSteeringCount?: number;
  variant?: 'chat' | 'task';
  draft?: string;
  draftAttachments?: ComposerImageAttachment[];
  draftRevision?: number;
  draftKey?: string;
  placeholder?: string;
  workspacePath?: string | null;
}

const MODES: { value: PermissionMode; labelKey: TranslationKey }[] = [
  { value: PermissionModeEnum.DEFAULT, labelKey: 'chat.input.mode.default' },
  { value: PermissionModeEnum.AUTO_EDIT, labelKey: 'chat.input.mode.autoEdit' },
  { value: PermissionModeEnum.PLAN, labelKey: 'chat.input.mode.plan' },
];

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function ChatInput({
  onSend,
  onAbort,
  disabled,
  submitDisabled = false,
  isStreaming,
  isStopping = false,
  pendingSteeringCount = 0,
  pendingInputDelivery = null,
  recoveredSteeringCount = 0,
  variant = 'chat',
  draft,
  draftAttachments,
  draftRevision,
  draftKey,
  placeholder,
  workspacePath,
}: ChatInputProps) {
  const t = useT();
  const initialDraft = useRef(readComposerDraft(draftKey));
  const [input, setInput] = useState(initialDraft.current.content);
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>(
    initialDraft.current.attachments
  );
  const inputRef = useRef(input);
  const attachmentsRef = useRef(attachments);
  const [cursorPosition, setCursorPosition] = useState<number | undefined>(undefined);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const attachmentCapabilityErrorRef = useRef<string | null>(null);
  const isSubmittingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    currentModelId,
    configuredModels,
    hasLoaded: modelsLoaded,
    loadModels,
    setCurrentModel,
    currentMode,
    setMode,
  } = useConfigStore();
  const setMaxContextTokens = useSessionStore((state) => state.setMaxContextTokens);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const persistedSessionModelId = useSessionStore(
    (state) =>
      state.sessions.find(
        (session) =>
          session.sessionId === currentSessionRef?.sessionId &&
          session.projectPath === currentSessionRef?.projectPath
      )?.selectedModelId
  );
  const [sessionModelOverride, setSessionModelOverride] = useState<string | null>(null);
  const persistedModelAvailable = configuredModels.some(
    (model) => model.id === persistedSessionModelId
  );
  const effectiveModelId = currentSessionRef
    ? (sessionModelOverride ??
      (persistedModelAvailable ? persistedSessionModelId : currentModelId))
    : currentModelId;
  const currentModelInfo = configuredModels.find((m) => m.id === effectiveModelId);
  const displayModelName =
    currentModelInfo?.displayName ||
    currentModelInfo?.model ||
    effectiveModelId ||
    t('chat.input.model.placeholder');
  const imageInputSupported = currentModelInfo?.input?.includes('image') === true;
  const imageCapabilityMessage = currentModelInfo
    ? t('chat.input.attachment.modelUnsupported', {
        model: displayModelName,
      })
    : t('chat.input.attachment.modelRequired');
  const attachmentsIncompatible = attachments.length > 0 && !imageInputSupported;

  const slashCommand = useSlashCommand(input, cursorPosition, { workspacePath });
  const atMention = useAtMention(input, cursorPosition, { workspacePath });
  const inputHistory = useInputHistory();

  const showSlashSuggestions =
    slashCommand.hasQuery && slashCommand.suggestions.length > 0;
  const showAtSuggestions = atMention.hasQuery && atMention.suggestions.length > 0;
  const showAnySuggestions = showSlashSuggestions || showAtSuggestions;

  useEffect(() => {
    if (!modelsLoaded) void loadModels();
  }, [loadModels, modelsLoaded]);

  useEffect(() => {
    if (isStreaming) setModelOpen(false);
  }, [isStreaming]);

  useEffect(() => {
    setAttachmentNotice(null);
  }, [effectiveModelId]);

  useEffect(() => {
    if (draft !== undefined) {
      const nextAttachments = draftAttachments ?? attachmentsRef.current;
      inputRef.current = draft;
      attachmentsRef.current = nextAttachments;
      setInput(draft);
      setAttachments(nextAttachments);
      setAttachmentError(null);
      setAttachmentNotice(null);
      setCursorPosition(draft.length);
      writeComposerDraft(draftKey, {
        content: draft,
        attachments: nextAttachments,
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [draft, draftAttachments, draftKey, draftRevision]);

  useEffect(() => {
    return () => {
      writeComposerDraft(draftKey, {
        content: inputRef.current,
        attachments: attachmentsRef.current,
      });
    };
  }, [draftKey]);

  useEffect(() => {
    if (!currentModelInfo) return;
    const hasConfiguredTokens = Boolean(currentModelInfo.contextWindow);
    setMaxContextTokens(currentModelInfo.contextWindow || 0, !hasConfiguredTokens);
  }, [currentModelInfo, setMaxContextTokens]);

  useEffect(() => {
    if (!imageInputSupported) return;
    setAttachmentError((current) => {
      if (current !== attachmentCapabilityErrorRef.current) return current;
      attachmentCapabilityErrorRef.current = null;
      return null;
    });
  }, [imageInputSupported]);

  const handleSend = useCallback(async () => {
    if (
      (!input.trim() && attachments.length === 0) ||
      disabled ||
      submitDisabled ||
      attachmentsIncompatible ||
      isSubmittingRef.current
    ) {
      return;
    }
    if (input.trim()) {
      inputHistory.addToHistory(input);
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    const submittedDraftKey = draftKey;
    try {
      const accepted = await onSend({
        content: input,
        modelId: effectiveModelId ?? undefined,
        attachments,
      });
      if (accepted === false) return;
      clearComposerDraft(submittedDraftKey);
      inputRef.current = '';
      attachmentsRef.current = [];
      setInput('');
      setAttachments([]);
      setAttachmentError(null);
      setAttachmentNotice(null);
      attachmentCapabilityErrorRef.current = null;
      setCursorPosition(undefined);
    } catch {
      // The parent owns the error surface; retain the draft for retry.
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    attachments,
    attachmentsIncompatible,
    draftKey,
    input,
    disabled,
    effectiveModelId,
    submitDisabled,
    onSend,
    inputHistory,
  ]);

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachmentError(null);
      setAttachmentNotice(null);
      attachmentCapabilityErrorRef.current = null;
      setAttachments((prev) => {
        const next = prev.filter((attachment) => attachment.id !== id);
        attachmentsRef.current = next;
        writeComposerDraft(draftKey, {
          content: inputRef.current,
          attachments: next,
        });
        return next;
      });
    },
    [draftKey]
  );

  const readImageFile = useCallback((file: File) => {
    return new Promise<ComposerImageAttachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Failed to read image'));
          return;
        }
        resolve({
          id:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: file.type,
          dataUrl: reader.result,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }, []);

  const appendImageFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (!imageInputSupported) {
        attachmentCapabilityErrorRef.current = imageCapabilityMessage;
        setAttachmentNotice(null);
        setAttachmentError(imageCapabilityMessage);
        return;
      }
      const validation = validateImageAttachmentBatch(attachmentsRef.current, files);
      const limitMessage = (reason: ImageAttachmentLimitReason): string =>
        reason === 'count'
          ? t('chat.input.attachment.countLimit', {
              count: MAX_INLINE_ATTACHMENT_COUNT,
            })
          : t('chat.input.attachment.sizeLimit', {
              size: formatAttachmentBytes(MAX_INLINE_ATTACHMENT_BYTES),
            });
      if (!validation.accepted) {
        attachmentCapabilityErrorRef.current = null;
        setAttachmentNotice(null);
        setAttachmentError(limitMessage(validation.reason ?? 'bytes'));
        return;
      }

      try {
        const nextAttachments = await Promise.all(
          files.map((file) => readImageFile(file))
        );
        const seenDataUrls = new Set(
          attachmentsRef.current.map((attachment) => attachment.dataUrl)
        );
        const uniqueAttachments = nextAttachments.filter((attachment) => {
          if (seenDataUrls.has(attachment.dataUrl)) return false;
          seenDataUrls.add(attachment.dataUrl);
          return true;
        });
        if (uniqueAttachments.length === 0) {
          setAttachmentError(null);
          setAttachmentNotice(null);
          attachmentCapabilityErrorRef.current = null;
          return;
        }
        const next = [...attachmentsRef.current, ...uniqueAttachments];
        if (inlineImageBytes(next) > MAX_INLINE_ATTACHMENT_BYTES) {
          attachmentCapabilityErrorRef.current = null;
          setAttachmentNotice(null);
          setAttachmentError(limitMessage('bytes'));
          return;
        }
        attachmentsRef.current = next;
        setAttachments(next);
        setAttachmentError(null);
        setAttachmentNotice(null);
        attachmentCapabilityErrorRef.current = null;
        writeComposerDraft(draftKey, {
          content: inputRef.current,
          attachments: next,
        });
      } catch {
        attachmentCapabilityErrorRef.current = null;
        setAttachmentNotice(null);
        setAttachmentError(t('chat.input.attachment.readFailed'));
      }
    },
    [draftKey, imageCapabilityMessage, imageInputSupported, readImageFile, t]
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []).filter((file) =>
        file.type.startsWith('image/')
      );
      await appendImageFiles(files);
      e.target.value = '';
    },
    [appendImageFiles]
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.items)
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (files.length === 0) return;

      e.preventDefault();
      await appendImageFiles(files);
    },
    [appendImageFiles]
  );

  const handleSlashSelect = useCallback(
    (index: number) => {
      const suggestion = slashCommand.suggestions[index];
      if (!suggestion) return;

      const { newInput, newCursorPos } = applySlashCommandSuggestion(
        input,
        slashCommand,
        suggestion
      );
      inputRef.current = newInput;
      setInput(newInput);
      setCursorPosition(newCursorPos);
      writeComposerDraft(draftKey, {
        content: newInput,
        attachments: attachmentsRef.current,
      });

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      });
    },
    [draftKey, input, slashCommand]
  );

  const handleAtSelect = useCallback(
    (index: number) => {
      const suggestion = atMention.suggestions[index];
      if (!suggestion) return;

      const { newInput, newCursorPos } = applyAtMentionSuggestion(
        input,
        atMention,
        suggestion
      );
      inputRef.current = newInput;
      setInput(newInput);
      setCursorPosition(newCursorPos);
      writeComposerDraft(draftKey, {
        content: newInput,
        attachments: attachmentsRef.current,
      });

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      });
    },
    [atMention, draftKey, input]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashSuggestions) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashCommand.selectNext();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashCommand.selectPrevious();
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          handleSlashSelect(slashCommand.selectedIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setCursorPosition(undefined);
          return;
        }
      }

      if (showAtSuggestions) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          atMention.selectNext();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          atMention.selectPrevious();
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          handleAtSelect(atMention.selectedIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setCursorPosition(undefined);
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (e.key === 'ArrowUp' && !e.shiftKey) {
        const textarea = e.target as HTMLTextAreaElement;
        const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
        const isSingleLine = !input.includes('\n');

        if (isAtStart || isSingleLine) {
          const prev = inputHistory.getPrevious(input);
          if (prev !== null) {
            e.preventDefault();
            inputRef.current = prev;
            setInput(prev);
            writeComposerDraft(draftKey, {
              content: prev,
              attachments: attachmentsRef.current,
            });
            requestAnimationFrame(() => {
              if (textareaRef.current) {
                textareaRef.current.setSelectionRange(prev.length, prev.length);
              }
            });
          }
        }
        return;
      }

      if (e.key === 'ArrowDown' && !e.shiftKey) {
        const textarea = e.target as HTMLTextAreaElement;
        const isAtEnd =
          textarea.selectionStart === input.length &&
          textarea.selectionEnd === input.length;
        const isSingleLine = !input.includes('\n');

        if ((isAtEnd || isSingleLine) && inputHistory.historyIndex !== -1) {
          const next = inputHistory.getNext();
          if (next !== null) {
            e.preventDefault();
            inputRef.current = next;
            setInput(next);
            writeComposerDraft(draftKey, {
              content: next,
              attachments: attachmentsRef.current,
            });
            requestAnimationFrame(() => {
              if (textareaRef.current) {
                textareaRef.current.setSelectionRange(next.length, next.length);
              }
            });
          }
        }
      }
    },
    [
      showSlashSuggestions,
      showAtSuggestions,
      slashCommand,
      atMention,
      handleSlashSelect,
      handleAtSelect,
      handleSend,
      draftKey,
      input,
      inputHistory,
    ]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      inputRef.current = next;
      setInput(next);
      setCursorPosition(e.target.selectionStart);
      writeComposerDraft(draftKey, {
        content: next,
        attachments: attachmentsRef.current,
      });
    },
    [draftKey]
  );

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    setCursorPosition(target.selectionStart);
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const currentModeLabelKey =
    MODES.find((m) => m.value === currentMode)?.labelKey ?? 'chat.input.mode.default';
  const currentModeLabel = t(currentModeLabelKey);
  const canSend = !!input.trim() || attachments.length > 0;
  const attachmentLimitReached = attachments.length >= MAX_INLINE_ATTACHMENT_COUNT;
  const attachmentBytes = inlineImageBytes(attachments);
  const visibleAttachmentError =
    attachmentError || (attachmentsIncompatible ? imageCapabilityMessage : null);
  const visibleAttachmentNotice = visibleAttachmentError ? null : attachmentNotice;
  const attachmentInteractionBlocked = Boolean(disabled) || isSubmitting;
  const attachmentControlDisabled =
    attachmentInteractionBlocked || attachmentLimitReached || !imageInputSupported;
  const attachmentControlLabel = !imageInputSupported
    ? imageCapabilityMessage
    : attachmentLimitReached
      ? t('chat.input.attachment.countLimit', {
          count: MAX_INLINE_ATTACHMENT_COUNT,
        })
      : t('chat.input.attachment.add');
  const handleUnavailableAttachment = () => {
    if (attachmentInteractionBlocked) return;
    setAttachmentNotice(attachmentControlLabel);
    if (
      !imageInputSupported &&
      !isStreaming &&
      configuredModels.some((model) => model.input?.includes('image'))
    ) {
      setModelOpen(true);
    }
  };

  return (
    <div
      className={
        variant === 'task'
          ? 'bg-transparent'
          : 'py-4 border-t border-[hsl(var(--deck-hairline))] bg-[hsl(var(--deck-canvas))]'
      }
    >
      <div className={variant === 'task' ? 'w-full' : 'px-4 w-full md:px-6'}>
        <div
          className={`relative border rounded-lg bg-[hsl(var(--deck-surface))] transition-all duration-200 flex flex-col ${
            variant === 'task'
              ? 'min-h-[148px] border-[hsl(var(--deck-border))] shadow-[0_18px_60px_-24px_hsl(var(--deck-accent)/0.4)] focus-within:border-[hsl(var(--deck-accent)/0.6)] focus-within:ring-1 focus-within:ring-[hsl(var(--deck-accent)/0.25)]'
              : 'min-h-[88px] border-[hsl(var(--deck-border))] shadow-sm focus-within:border-[hsl(var(--deck-border-strong))] focus-within:ring-1 focus-within:ring-[hsl(var(--deck-border-strong))]'
          }`}
        >
          <SuggestionPopover
            type="command"
            suggestions={slashCommand.suggestions}
            selectedIndex={slashCommand.selectedIndex}
            loading={slashCommand.loading}
            onSelect={handleSlashSelect}
            onHover={slashCommand.setSelectedIndex}
            visible={showSlashSuggestions}
          />

          <SuggestionPopover
            type="file"
            suggestions={atMention.suggestions}
            selectedIndex={atMention.selectedIndex}
            loading={atMention.loading}
            onSelect={handleAtSelect}
            onHover={atMention.setSelectedIndex}
            visible={showAtSuggestions && !showSlashSuggestions}
          />

          <Textarea
            ref={textareaRef}
            data-blade-composer
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={handleSelect}
            onClick={handleSelect}
            placeholder={
              placeholder ??
              (isStreaming
                ? t('chat.input.placeholder.steering')
                : t('chat.input.placeholder.default'))
            }
            className={`flex-1 w-full resize-none border-0 bg-transparent px-4 focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none text-[#111827] dark:text-zinc-300 placeholder:text-[#9CA3AF] dark:placeholder:text-zinc-600 ${
              variant === 'task' ? 'min-h-[84px] py-4 text-[15px]' : 'py-4'
            }`}
            disabled={disabled || isSubmitting}
            aria-busy={isSubmitting}
          />

          {isStreaming && (
            <div className="px-4 pb-2 text-[11px] font-mono text-amber-600 dark:text-amber-400">
              {pendingSteeringCount > 0 && pendingInputDelivery === 'next_turn' ? (
                t('chat.input.followUp.queued', { count: pendingSteeringCount })
              ) : pendingSteeringCount > 0 ? (
                t('chat.input.steering.queued', {
                  count: pendingSteeringCount,
                })
              ) : (
                <>
                  {t('chat.input.steering.status')}
                  {t('chat.input.steering.enterHint')}
                </>
              )}
            </div>
          )}
          {recoveredSteeringCount > 0 && (
            <div className="px-4 pb-2 text-[11px] font-mono text-cyan-600 dark:text-cyan-400">
              {recoveredSteeringCount === 1
                ? t('chat.input.steering.recoveredOne', {
                    count: recoveredSteeringCount,
                  })
                : t('chat.input.steering.recoveredMany', {
                    count: recoveredSteeringCount,
                  })}
            </div>
          )}

          {visibleAttachmentError && (
            <div
              role="alert"
              className="mx-4 mb-2 flex min-h-8 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{visibleAttachmentError}</span>
              {attachmentError && (
                <button
                  type="button"
                  aria-label={t('chat.error.dismiss')}
                  onClick={() => {
                    setAttachmentError(null);
                    attachmentCapabilityErrorRef.current = null;
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-red-500 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 dark:hover:bg-red-950"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {visibleAttachmentNotice && (
            <div
              role="status"
              aria-live="polite"
              className="mx-4 mb-2 flex min-h-8 items-center gap-2 rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-2.5 py-1.5 text-[11px] text-[hsl(var(--deck-ink-muted))]"
            >
              <Info className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-accent))]" />
              <span className="min-w-0 flex-1">{visibleAttachmentNotice}</span>
              <button
                type="button"
                aria-label={t('chat.notice.dismiss')}
                onClick={() => setAttachmentNotice(null)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="px-4 pb-2">
              <div className="mb-1.5 font-mono text-[9.5px] text-[hsl(var(--deck-ink-faint))]">
                {t('chat.input.attachment.usage', {
                  count: attachments.length,
                  limit: MAX_INLINE_ATTACHMENT_COUNT,
                  used: formatAttachmentBytes(attachmentBytes),
                  budget: formatAttachmentBytes(MAX_INLINE_ATTACHMENT_BYTES),
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    title={attachment.name}
                    className="relative overflow-hidden rounded-md border border-[#E5E7EB] bg-[#F9FAFB] dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name}
                      className="h-20 w-20 object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`${t('chat.input.attachment.remove')} ${attachment.name}`}
                      title={`${t('chat.input.attachment.remove')} ${attachment.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-black/75 text-white transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between items-center p-3 mt-auto">
            <div className="flex gap-2 items-center">
              {attachmentControlDisabled ? (
                <button
                  type="button"
                  disabled={attachmentInteractionBlocked}
                  aria-disabled="true"
                  aria-label={attachmentControlLabel}
                  title={attachmentControlLabel}
                  onClick={handleUnavailableAttachment}
                  className="flex h-8 w-8 cursor-help items-center justify-center rounded-md text-[#9CA3AF] opacity-55 transition-colors hover:bg-[hsl(var(--deck-surface-2))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))] disabled:cursor-not-allowed dark:text-zinc-500"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              ) : (
                <label
                  title={attachmentControlLabel}
                  className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[#9CA3AF] transition-colors hover:bg-[#E5E7EB] hover:text-[#111827] focus-within:ring-1 focus-within:ring-[hsl(var(--deck-accent))] dark:text-zinc-500 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-300"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    aria-label={attachmentControlLabel}
                    className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                    onChange={handleFileChange}
                  />
                  <Paperclip className="h-4 w-4" />
                </label>
              )}

              <Popover
                open={modelOpen}
                onOpenChange={(open) => {
                  if (!isStreaming && !isSubmitting) setModelOpen(open);
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={isStreaming || isSubmitting}
                    title={
                      isStreaming
                        ? t('chat.input.model.locked')
                        : t('chat.input.model.change')
                    }
                    className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-[#6B7280] transition-colors hover:bg-[#E5E7EB] hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-55 dark:text-zinc-500 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200"
                  >
                    {displayModelName}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-64 p-2 bg-white dark:bg-zinc-900 border border-[#E5E7EB] dark:border-zinc-700"
                  align="start"
                >
                  <div className="overflow-y-auto max-h-72">
                    {configuredModels.length === 0 ? (
                      <div className="text-xs text-[#6B7280] dark:text-zinc-500 px-2 py-2">
                        {t('chat.input.model.empty')}
                      </div>
                    ) : (
                      Object.entries(
                        configuredModels.reduce(
                          (acc, model) => {
                            const provider = model.provider || 'unknown';
                            if (!acc[provider]) acc[provider] = [];
                            acc[provider].push(model);
                            return acc;
                          },
                          {} as Record<string, typeof configuredModels>
                        )
                      ).map(([provider, models]) => (
                        <div key={provider} className="mb-2">
                          <div className="text-xs text-[#6B7280] dark:text-zinc-500 px-2 py-1 capitalize">
                            {provider.replace(/-/g, ' ')}
                          </div>
                          {models.map((model) => (
                            <button
                              key={model.id}
                              className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-[#E5E7EB] dark:hover:bg-zinc-800 transition-colors ${
                                model.id === effectiveModelId
                                  ? 'bg-[#E5E7EB] text-[#111827] dark:bg-zinc-800 dark:text-zinc-100'
                                  : 'text-[#6B7280] dark:text-zinc-400'
                              }`}
                              onClick={() => {
                                setAttachmentNotice(null);
                                if (currentSessionRef) {
                                  setSessionModelOverride(model.id);
                                  setModelOpen(false);
                                  return;
                                }
                                void setCurrentModel(model.id)
                                  .then(() => setModelOpen(false))
                                  .catch(() => undefined);
                              }}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 flex-1 truncate">
                                  {model.displayName || model.model}
                                </span>
                                {model.input?.includes('image') && (
                                  <span className="shrink-0 rounded bg-[hsl(var(--deck-accent-soft))] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-[hsl(var(--deck-accent))]">
                                    {t('chat.input.model.vision')}
                                  </span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              <Popover open={modeOpen} onOpenChange={setModeOpen}>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#111827] px-2 py-1 rounded hover:bg-[#E5E7EB] dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors">
                    {currentModeLabel}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-40 p-1 bg-white dark:bg-zinc-900 border border-[#E5E7EB] dark:border-zinc-700"
                  align="start"
                >
                  <div className="flex flex-col gap-0.5">
                    {MODES.map((mode) => (
                      <button
                        key={mode.value}
                        className={`w-full text-left px-2 py-1.5 text-xs rounded hover:bg-[#E5E7EB] dark:hover:bg-zinc-800 transition-colors ${
                          currentMode === mode.value
                            ? 'bg-[#E5E7EB] text-[#111827] dark:bg-zinc-800 dark:text-zinc-100'
                            : 'text-[#6B7280] dark:text-zinc-400'
                        }`}
                        onClick={() => {
                          setMode(mode.value);
                          setModeOpen(false);
                        }}
                      >
                        {t(mode.labelKey)}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex gap-2 items-center">
              {isStreaming && (
                <Button
                  size="icon"
                  onClick={() => {
                    void onAbort?.();
                  }}
                  disabled={isStopping}
                  title={
                    isStopping
                      ? t('chat.input.action.stopping')
                      : t('chat.input.action.stop')
                  }
                  aria-label={
                    isStopping
                      ? t('chat.input.action.stopping')
                      : t('chat.input.action.stop')
                  }
                  className="w-8 h-8 text-white bg-red-500 hover:bg-red-600"
                >
                  {isStopping ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="w-3 h-3" />
                  )}
                </Button>
              )}
              <Button
                size="icon"
                onClick={handleSend}
                disabled={
                  !canSend ||
                  disabled ||
                  submitDisabled ||
                  attachmentsIncompatible ||
                  isSubmitting ||
                  showAnySuggestions
                }
                title={
                  isSubmitting
                    ? t('chat.input.action.submitting')
                    : isStreaming
                      ? t('chat.input.action.steer')
                      : t('chat.input.action.send')
                }
                aria-label={
                  isSubmitting
                    ? t('chat.input.action.submitting')
                    : isStreaming
                      ? t('chat.input.action.steer')
                      : t('chat.input.action.send')
                }
                className="h-8 w-8 bg-[#111827] text-white hover:bg-[#0F172A] disabled:bg-[#E5E7EB] disabled:text-[#9CA3AF] dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
        {variant === 'chat' && (
          <div className="text-center text-xs text-[#6B7280] dark:text-zinc-600 mt-3 font-mono">
            {t('chat.footer.disclaimer')}
          </div>
        )}
      </div>
    </div>
  );
}
