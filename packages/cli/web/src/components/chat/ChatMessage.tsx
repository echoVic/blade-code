import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import { BladeMark } from '@/components/layout/BladeMark';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { type SubagentSession, sessionService } from '@/services';
import { useAppStore } from '@/store/AppStore';
import type {
  AgentResponseContent,
  Message,
  MessageContent,
  ToolCallInfo,
} from '@/store/session';
import { useSessionStore } from '@/store/session';
import {
  getAgentTimeline,
  getSubagents,
  getTimelineText,
} from '@/store/session/utils/agentTimeline';
import { aggregateMessages } from '@/store/session/utils/aggregateMessages';
import { CodeReviewReport, parseCodeReviewReport } from './CodeReviewReport';
import { McpElicitationSection } from './McpElicitationSection';
import {
  parseStructuredOutputReport,
  StructuredOutputReport,
} from './StructuredOutputReport';

export type { Message };

interface ChatMessageProps {
  message: Message;
  showAvatar?: boolean;
}

const MarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((module) => ({
    default: module.MarkdownRenderer,
  }))
);

/**
 * Hover-revealed copy affordance for a message. Mirrors the pattern used by
 * production coding agents (Claude Code, ChatGPT): unobtrusive until hover,
 * with a transient checkmark confirming the copy.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard may be unavailable (insecure context); fail silently.
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={handleCopy}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[hsl(var(--deck-accent))]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function AIAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] shadow-[0_1px_0_hsl(var(--deck-hairline))]">
      <BladeMark size={20} pulse={false} />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas-veil))]">
      <span className="font-mono text-[11px] font-medium text-[hsl(var(--deck-ink))]">
        U
      </span>
    </div>
  );
}

function extractUserContent(content: string): string {
  let result = content;
  result = result.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  result = result.replace(/<file path="[^"]*">[\s\S]*?<\/file>/g, '');
  result = result.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '');
  result = result.trim();
  return result;
}

function getUserMessageParts(content: MessageContent) {
  if (typeof content === 'string') {
    return { text: extractUserContent(content), images: [] as string[] };
  }

  const text = content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n');
  const images = content
    .filter(
      (part): part is Extract<typeof part, { type: 'image_url' }> =>
        part.type === 'image_url'
    )
    .map((part) => part.image_url.url);

  return {
    text: extractUserContent(text),
    images,
  };
}

function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n');
}

/** Assemble the copyable prose of an assistant message (excludes tool noise). */
function getAssistantCopyText(message: Message): string {
  const agent = message.agentContent;
  if (agent) {
    return getTimelineText(agent);
  }
  return getTextContent(message.content);
}

function MarkdownBlock({
  content,
  syntaxHighlight = true,
}: {
  content: string;
  syntaxHighlight?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <pre className="text-[14px] text-[hsl(var(--deck-ink))] font-mono whitespace-pre-wrap">
          {content}
        </pre>
      }
    >
      <MarkdownRenderer content={content} syntaxHighlight={syntaxHighlight} />
    </Suspense>
  );
}

function StatusPill({
  status,
}: {
  status?: 'running' | 'success' | 'error' | 'pending' | 'info';
}) {
  if (!status) return null;
  const styles = {
    running: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#F59E0B]/20 dark:text-[#FBBF24]',
    success: 'bg-[#DCFCE7] text-[#15803D] dark:bg-[#22C55E]/20 dark:text-[#22C55E]',
    error: 'bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5]',
    pending: 'bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]',
    info: 'bg-[#DBEAFE] text-[#1D4ED8] dark:bg-[#3B82F6]/20 dark:text-[#60A5FA]',
  };
  const labels = {
    running: 'Running',
    success: 'Success',
    error: 'Error',
    pending: 'Pending',
    info: 'Info',
  };
  return (
    <span
      className={cn('text-[11px] px-2 py-0.5 rounded-full font-mono', styles[status])}
    >
      {labels[status]}
    </span>
  );
}

function formatToolArguments(args?: string | Record<string, unknown>): string {
  if (!args) return '';
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

const TOOL_OUTPUT_MAX_CHARS = 500;

function safeOutputHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, maxChars);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function safeOutputTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let start = Math.max(0, value.length - maxChars);
  if (/[\uDC00-\uDFFF]/.test(value.charAt(start))) start += 1;
  return value.slice(start);
}

function fitOutputSegment(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return '';
  const marker = '\n... (display clipped) ...\n';
  const available = maxChars - marker.length;
  if (available <= 0) return safeOutputTail(value, maxChars);
  const headChars = Math.floor(available / 3);
  return `${safeOutputHead(value, headChars)}${marker}${safeOutputTail(
    value,
    available - headChars
  )}`;
}

function fitToolOutputForCard(output: string): {
  body: string;
  notice?: string;
  truncated: boolean;
} {
  const lines = output.split('\n');
  const lastLine = lines.at(-1);
  const notice = lastLine?.startsWith('Output truncated') ? lastLine : undefined;
  const body = notice ? lines.slice(0, -1).join('\n') : output;
  const noticeText = notice ? `\n${notice}` : '';
  const bodyBudget = Math.max(0, TOOL_OUTPUT_MAX_CHARS - noticeText.length);
  const stderrMarker = '\nstderr:\n';
  const stderrIndex = body.indexOf(stderrMarker);
  let fittedBody: string;

  if (stderrIndex >= 0 && body.includes('\nstdout:\n')) {
    const first = body.slice(0, stderrIndex);
    const second = body.slice(stderrIndex + 1);
    const available = Math.max(0, bodyBudget - 1);
    const firstBudget = Math.floor(available / 2);
    fittedBody = `${fitOutputSegment(first, firstBudget)}\n${fitOutputSegment(
      second,
      available - firstBudget
    )}`;
  } else {
    fittedBody = fitOutputSegment(body, bodyBudget);
  }

  return {
    body: safeOutputHead(fittedBody, bodyBudget),
    ...(notice ? { notice } : {}),
    truncated: Boolean(notice) || output.length > TOOL_OUTPUT_MAX_CHARS,
  };
}

function ToolCallItem({ tool }: { tool: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const args = formatToolArguments(tool.arguments);
  const projectedOutput = tool.output ? fitToolOutputForCard(tool.output) : undefined;

  return (
    <div
      data-tool-name={tool.toolName}
      data-tool-status={tool.status}
      data-tool-truncated={projectedOutput?.truncated ? 'true' : 'false'}
      className="bg-white dark:bg-[#18181b] border border-[hsl(var(--deck-border))] rounded-lg overflow-hidden"
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-tool-call-id={tool.toolCallId}
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[hsl(var(--deck-surface-2))] hover:bg-[hsl(var(--deck-surface))] transition-colors"
      >
        <div className="flex gap-2 items-center min-w-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-[hsl(var(--deck-ink-faint))] shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[hsl(var(--deck-ink-faint))] shrink-0" />
          )}
          <span className="text-[12px] text-[hsl(var(--deck-ink))] font-mono shrink-0">
            {tool.toolName}
          </span>
          {tool.summary && (
            <span className="text-[11px] text-[hsl(var(--deck-ink-muted))] font-mono truncate">
              {tool.summary}
            </span>
          )}
        </div>
        <StatusPill status={tool.status} />
      </button>

      {tool.status === 'running' && tool.progressMessage && (
        <div className="border-t border-[hsl(var(--deck-border))] px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-3 font-mono text-[10px] text-[hsl(var(--deck-ink-muted))]">
            <span className="truncate">{tool.progressMessage}</span>
            {tool.progressTotal !== undefined && tool.progress !== undefined && (
              <span className="shrink-0">
                {Math.max(
                  0,
                  Math.min(100, Math.round((tool.progress / tool.progressTotal) * 100))
                )}
                %
              </span>
            )}
          </div>
          {tool.progressTotal !== undefined && tool.progress !== undefined && (
            <div
              role="progressbar"
              aria-label={`${tool.toolName} progress`}
              aria-valuemin={0}
              aria-valuemax={tool.progressTotal}
              aria-valuenow={Math.min(tool.progress, tool.progressTotal)}
              className="h-1 overflow-hidden rounded-full bg-[hsl(var(--deck-border))]"
            >
              <div
                className="h-full rounded-full bg-amber-500 transition-[width] duration-150"
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, (tool.progress / tool.progressTotal) * 100)
                  )}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="px-3 py-2 space-y-2 border-t border-[hsl(var(--deck-border))]">
          {args && (
            <div className="space-y-1">
              <div className="text-[11px] text-[hsl(var(--deck-ink-muted))] font-mono">
                Arguments
              </div>
              <pre className="text-[11px] text-[hsl(var(--deck-ink))] bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[120px] overflow-y-auto">
                {args}
              </pre>
            </div>
          )}
          {projectedOutput && (
            <div className="space-y-1">
              <div className="text-[11px] text-[hsl(var(--deck-ink-muted))] font-mono">
                Output
              </div>
              <pre
                data-tool-output
                className="text-[11px] text-[hsl(var(--deck-ink))] bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[120px] overflow-y-auto"
              >
                {projectedOutput.body}
                {projectedOutput.notice && (
                  <>
                    {'\n'}
                    <span data-tool-truncation-notice>{projectedOutput.notice}</span>
                  </>
                )}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallsList({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="space-y-2">
      {toolCalls.map((tool) => (
        <ToolCallItem key={tool.toolCallId} tool={tool} />
      ))}
    </div>
  );
}

function ToolCallsGroup({
  toolCalls,
  toolCallIds,
}: {
  toolCalls: ToolCallInfo[];
  toolCallIds: string[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const toolsById = useMemo(
    () => new Map(toolCalls.map((tool) => [tool.toolCallId, tool])),
    [toolCalls]
  );
  const groupedTools = toolCallIds.flatMap((toolCallId) => {
    const tool = toolsById.get(toolCallId);
    return tool ? [tool] : [];
  });
  if (groupedTools.length === 0) return null;

  const running = groupedTools.filter((tool) => tool.status === 'running').length;
  const errors = groupedTools.filter((tool) => tool.status === 'error').length;
  const activeProgress = [...groupedTools]
    .reverse()
    .find((tool) => tool.status === 'running' && Boolean(tool.progressMessage));
  const label =
    running > 0
      ? t(
          groupedTools.length === 1
            ? 'chat.timeline.tools.runningOne'
            : 'chat.timeline.tools.running',
          { count: groupedTools.length }
        )
      : errors > 0
        ? t(
            groupedTools.length === 1
              ? 'chat.timeline.tools.completedOneWithError'
              : 'chat.timeline.tools.completedWithErrors',
            {
              count: groupedTools.length,
              errors,
            }
          )
        : t(
            groupedTools.length === 1
              ? 'chat.timeline.tools.completedOne'
              : 'chat.timeline.tools.completed',
            { count: groupedTools.length }
          );

  return (
    <div data-agent-tool-group className="py-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="group flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left font-mono text-[11.5px] text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))]/65 hover:text-[hsl(var(--deck-ink-muted))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {running > 0 && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[hsl(var(--deck-accent))]" />
        )}
        <span>{label}</span>
        {activeProgress?.progressMessage && (
          <span className="min-w-0 truncate text-[10.5px] text-[hsl(var(--deck-ink-muted))]">
            {activeProgress.progressMessage}
            {activeProgress.progress !== undefined &&
              activeProgress.progressTotal !== undefined &&
              ` · ${Math.max(
                0,
                Math.min(
                  100,
                  Math.round(
                    (activeProgress.progress / activeProgress.progressTotal) * 100
                  )
                )
              )}%`}
          </span>
        )}
      </button>
      {activeProgress?.progress !== undefined &&
        activeProgress.progressTotal !== undefined && (
          <div
            role="progressbar"
            aria-label={`${activeProgress.toolName} progress`}
            aria-valuemin={0}
            aria-valuemax={activeProgress.progressTotal}
            aria-valuenow={Math.min(
              activeProgress.progress,
              activeProgress.progressTotal
            )}
            className="mx-1.5 h-0.5 overflow-hidden rounded-full bg-[hsl(var(--deck-border))]"
          >
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-150"
              style={{
                width: `${Math.max(
                  0,
                  Math.min(
                    100,
                    (activeProgress.progress / activeProgress.progressTotal) * 100
                  )
                )}%`,
              }}
            />
          </div>
        )}
      {expanded && (
        <div data-agent-tool-group-details className="mt-2 space-y-2 pl-1">
          <ToolCallsList toolCalls={groupedTools} />
        </div>
      )}
    </div>
  );
}

function ThinkingSection({ content }: { content: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;

  return (
    <div data-agent-thinking className="py-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left font-mono text-[11.5px] text-[hsl(var(--deck-ink-faint))] transition-colors hover:bg-[hsl(var(--deck-surface))]/65 hover:text-[hsl(var(--deck-ink-muted))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--deck-accent))]"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-[hsl(var(--deck-ink-faint))]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[hsl(var(--deck-ink-faint))]" />
        )}
        <span>{t('chat.timeline.thinking')}</span>
      </button>
      {expanded && (
        <div className="ml-1 mt-1 border-l border-[hsl(var(--deck-border))] py-1 pl-3">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-[hsl(var(--deck-ink-muted))]">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function TaskSection({ tasks }: { tasks: AgentResponseContent['tasks'] }) {
  if (tasks.length === 0) return null;

  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const allDone = completedCount === tasks.length;

  return (
    <div className="bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-lg px-3 py-2">
      <div className="flex gap-2 items-center">
        <span className="text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
          {allDone ? '✓ All tasks done' : `Tasks: ${completedCount}/${tasks.length}`}
        </span>
      </div>
    </div>
  );
}

function ChangedFilesSection({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const openFilePreview = useAppStore((state) => state.openFilePreview);

  const changedFiles = useMemo(() => {
    const files = new Map<string, { path: string; toolName: string }>();
    const editTools = ['Write', 'SearchReplace', 'Edit', 'ApplyPatch'];
    for (const tc of toolCalls) {
      if (tc.status !== 'success') continue;
      const meta = tc.metadata as Record<string, unknown> | undefined;
      if (tc.toolName === 'ApplyPatch' && Array.isArray(meta?.changes)) {
        for (const change of meta.changes) {
          if (
            change &&
            typeof change === 'object' &&
            'path' in change &&
            typeof change.path === 'string'
          ) {
            files.set(change.path, {
              path: change.path,
              toolName: tc.toolName,
            });
          }
        }
        continue;
      }
      const filePath = meta?.file_path as string | undefined;
      if (filePath && editTools.includes(tc.toolName)) {
        files.set(filePath, { path: filePath, toolName: tc.toolName });
      }
    }
    return Array.from(files.values());
  }, [toolCalls]);

  if (changedFiles.length === 0) return null;

  return (
    <div className="bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-lg px-3 py-2">
      <div className="text-[11px] text-[hsl(var(--deck-ink-muted))] font-mono mb-1.5">
        Changed files ({changedFiles.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {changedFiles.map(({ path }) => {
          const fileName = path.split('/').pop() || path;
          return (
            <button
              key={path}
              onClick={() => openFilePreview({ tab: 'diff', targetPath: path })}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono bg-[#E5E7EB] dark:bg-[#27272a] text-[hsl(var(--deck-ink))] rounded hover:bg-[#D1D5DB] dark:hover:bg-[#3f3f46] transition-colors"
              title={path}
            >
              <FileText className="w-3 h-3" />
              {fileName}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubagentSection({ subagent }: { subagent: AgentResponseContent['subagent'] }) {
  const t = useT();
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedToolCalls, setLoadedToolCalls] = useState<ToolCallInfo[] | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumePrompt, setResumePrompt] = useState('');
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumedChild, setResumedChild] = useState<SubagentSession | null>(null);
  const [sourceSession, setSourceSession] = useState<SubagentSession | null>(null);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const isStreaming = useSessionStore((state) => state.isStreaming);
  const isTemporarySession = useSessionStore((state) => state.isTemporarySession);

  if (!subagent) return null;

  const isRunning = subagent.status === 'running';
  const expanded = manualToggle !== null ? manualToggle : isRunning;
  const toolCalls = subagent.toolCalls || loadedToolCalls || [];
  const hasContent =
    subagent.output || subagent.thinking || toolCalls.length > 0 || subagent.sessionId;
  const resumeSession =
    resumedChild && resumedChild.status !== 'running' ? resumedChild : sourceSession;
  const resumeTarget = resumeSession?.id ?? subagent.sessionId;
  const recoveryFailed = resumeSession?.restartRecovery?.outcome === 'failed';
  const canResume =
    !isRunning &&
    !isStreaming &&
    !isTemporarySession &&
    !recoveryFailed &&
    resumedChild?.status !== 'running' &&
    Boolean(resumeTarget && currentSessionRef);

  useEffect(() => {
    if (
      !expanded ||
      isRunning ||
      !subagent.sessionId ||
      !currentSessionRef?.projectPath ||
      loadedToolCalls !== null ||
      (subagent.toolCalls && subagent.toolCalls.length > 0)
    )
      return;
    let mounted = true;
    setLoading(true);
    sessionService
      .getMessages({
        sessionId: subagent.sessionId,
        projectPath: currentSessionRef.projectPath,
      })
      .then((rawMessages) => {
        if (!mounted) return;
        const aggregated = aggregateMessages(rawMessages);
        const toolCallsMap = new Map<string, ToolCallInfo>();
        for (const message of aggregated) {
          if (message.agentContent?.toolCalls?.length) {
            for (const tc of message.agentContent.toolCalls) {
              if (!toolCallsMap.has(tc.toolCallId)) {
                toolCallsMap.set(tc.toolCallId, tc);
              }
            }
          }
        }
        setLoadedToolCalls(Array.from(toolCallsMap.values()));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [
    expanded,
    isRunning,
    subagent.sessionId,
    subagent.toolCalls,
    loadedToolCalls,
    currentSessionRef?.projectPath,
  ]);

  useEffect(() => {
    if (!subagent.sessionId || !currentSessionRef) return;
    let mounted = true;
    const lineageRoot = subagent.rootAgentId ?? subagent.sessionId;
    const currentDepth = subagent.resumeDepth ?? 0;
    sessionService
      .listSubagents(currentSessionRef)
      .then((sessions) => {
        if (!mounted) return;
        setSourceSession(
          sessions.find((session) => session.id === subagent.sessionId) ?? null
        );
        const latest = sessions
          .filter(
            (session) =>
              session.id !== subagent.sessionId &&
              session.rootAgentId === lineageRoot &&
              session.resumeDepth > currentDepth
          )
          .sort(
            (left, right) =>
              right.resumeDepth - left.resumeDepth ||
              right.lastActiveAt - left.lastActiveAt
          )[0];
        if (latest) setResumedChild(latest);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [
    currentSessionRef?.sessionId,
    currentSessionRef?.projectPath,
    subagent.sessionId,
    subagent.rootAgentId,
    subagent.resumeDepth,
  ]);

  useEffect(() => {
    if (!resumedChild || resumedChild.status !== 'running' || !currentSessionRef) {
      return;
    }
    let mounted = true;
    const refresh = async () => {
      try {
        const sessions = await sessionService.listSubagents(currentSessionRef);
        const current = sessions.find((session) => session.id === resumedChild.id);
        if (mounted && current) setResumedChild(current);
      } catch {
        // The live SSE card remains usable when status polling is unavailable.
      }
    };
    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [currentSessionRef, resumedChild?.id, resumedChild?.status]);

  const handleResume = async () => {
    if (
      !currentSessionRef ||
      !resumeTarget ||
      !resumePrompt.trim() ||
      resumeSubmitting
    ) {
      return;
    }
    setResumeSubmitting(true);
    setResumeError(null);
    try {
      const result = await sessionService.resumeSubagent(
        currentSessionRef,
        resumeTarget,
        resumePrompt.trim()
      );
      setResumedChild(result.session);
      setResumePrompt('');
      setResumeOpen(false);
      setManualToggle(true);
    } catch (error) {
      setResumeError(
        error instanceof Error ? error.message : t('chat.subagent.resumeFailed')
      );
    } finally {
      setResumeSubmitting(false);
    }
  };

  return (
    <div
      data-subagent-id={subagent.id}
      className="bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-lg px-3 py-2"
    >
      <button
        type="button"
        onClick={() => setManualToggle(!expanded)}
        className="flex gap-2 justify-between items-center w-full transition-opacity cursor-pointer hover:opacity-80"
      >
        <div className="flex gap-2 items-center">
          {isRunning && (
            <Loader2 className="h-3 w-3 animate-spin text-[hsl(var(--deck-ink-muted))]" />
          )}
          <span className="text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
            {subagent.type}: {subagent.description}
          </span>
          <StatusPill
            status={
              subagent.status === 'completed'
                ? 'success'
                : subagent.status === 'failed'
                  ? 'error'
                  : 'running'
            }
          />
          {subagent.type === 'verification' && subagent.verificationVerdict && (
            <span
              data-verification-verdict={subagent.verificationVerdict}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                subagent.verificationVerdict === 'pass'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : subagent.verificationVerdict === 'fail'
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                    : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              )}
            >
              {subagent.verificationVerdict}
            </span>
          )}
          {subagent.resumedFrom && (
            <span
              className="rounded bg-[#EDE9FE] px-1.5 py-0.5 text-[10px] font-mono text-[#6D28D9] dark:bg-[#2E1065] dark:text-[#C4B5FD]"
              title={t('chat.subagent.resumedFromTitle', {
                id: subagent.resumedFrom,
              })}
            >
              {t('chat.subagent.resumedDepth', {
                depth: subagent.resumeDepth ?? 1,
              })}
            </span>
          )}
        </div>
        {hasContent && (
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-[hsl(var(--deck-ink-muted))] transition-transform',
              expanded && 'rotate-180'
            )}
          />
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {(subagent.output || subagent.thinking) && (
            <>
              {subagent.output && (
                <pre className="text-[11px] text-[hsl(var(--deck-ink))] bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[160px] overflow-y-auto">
                  {subagent.output}
                </pre>
              )}
              {subagent.thinking && (
                <pre className="text-[11px] text-[hsl(var(--deck-ink-muted))] bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[120px] overflow-y-auto">
                  {subagent.thinking}
                </pre>
              )}
            </>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-[11px] text-[hsl(var(--deck-ink-muted))] font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('chat.subagent.loadingLogs')}
            </div>
          )}
          {!loading && toolCalls.length > 0 && <ToolCallsList toolCalls={toolCalls} />}
          {resumedChild && (
            <div className="rounded-md border border-[#DDD6FE] bg-[#F5F3FF] p-2 text-[11px] font-mono text-[#5B21B6] dark:border-[#4C1D95] dark:bg-[#1E1B4B] dark:text-[#C4B5FD]">
              <div>
                {t('chat.subagent.resumedAs', {
                  id: resumedChild.id,
                  status: resumedChild.status,
                  depth: resumedChild.resumeDepth ?? 1,
                })}
              </div>
              {(resumedChild.result?.message || resumedChild.result?.error) && (
                <div className="mt-1 whitespace-pre-wrap text-[hsl(var(--deck-ink))]">
                  {resumedChild.result.message || resumedChild.result.error}
                </div>
              )}
            </div>
          )}
          {recoveryFailed && resumeSession?.result?.error && (
            <div role="alert" className="text-[11px] text-red-600">
              {resumeSession.result.error}
            </div>
          )}
          {canResume && (
            <div className="space-y-2">
              {!resumeOpen ? (
                <button
                  type="button"
                  aria-label={t('chat.subagent.resumeAria')}
                  onClick={() => setResumeOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border border-[#D1D5DB] px-2 py-1 text-[11px] font-medium text-[#374151] transition-colors hover:bg-[#F3F4F6] dark:border-[#3f3f46] dark:text-[#d4d4d8] dark:hover:bg-[#27272a]"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t('chat.subagent.resume')}
                </button>
              ) : (
                <div className="space-y-2 rounded-md border border-[#E5E7EB] bg-white p-2 dark:border-[#27272a] dark:bg-[#111113]">
                  <textarea
                    aria-label={t('chat.subagent.followUpAria')}
                    value={resumePrompt}
                    onChange={(event) => setResumePrompt(event.target.value)}
                    placeholder={t('chat.subagent.followUpPlaceholder')}
                    rows={3}
                    className="w-full resize-y rounded border border-[#D1D5DB] bg-white p-2 text-[11px] text-[#111827] outline-none focus:border-[#8B5CF6] dark:border-[#3f3f46] dark:bg-[#18181b] dark:text-[#f4f4f5]"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setResumeOpen(false);
                        setResumeError(null);
                      }}
                      className="rounded px-2 py-1 text-[11px] text-[#6B7280] hover:bg-[#F3F4F6] dark:hover:bg-[#27272a]"
                    >
                      {t('chat.subagent.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleResume()}
                      disabled={!resumePrompt.trim() || resumeSubmitting}
                      className="flex items-center gap-1 rounded bg-[#7C3AED] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      {resumeSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                      {t('chat.subagent.resumeAgent')}
                    </button>
                  </div>
                </div>
              )}
              {resumeError && (
                <div role="alert" className="text-[11px] text-red-600">
                  {resumeError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmationSection({
  confirmation,
  messageId,
}: {
  confirmation: AgentResponseContent['confirmation'];
  messageId: string;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const setConfirmation = useSessionStore((state) => state.setConfirmation);

  if (!confirmation) return null;

  const handleResponse = async (
    approved: boolean,
    scope?: 'once' | 'session' | 'project'
  ) => {
    if (!currentSessionRef || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await sessionService.respondPermission(
        currentSessionRef,
        confirmation.toolCallId,
        { approved, scope }
      );
      setConfirmation(messageId, {
        ...confirmation,
        status: approved ? 'approved' : 'denied',
      });
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t('interaction.permission.failed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (confirmation.status !== 'pending') {
    return null;
  }

  return (
    <div
      data-pending-interaction="permission"
      tabIndex={-1}
      role="alert"
      className="space-y-3 rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800/70 dark:bg-amber-950/25"
    >
      <div className="text-[13px] text-[hsl(var(--deck-ink))] font-mono">
        {t('interaction.permission.title', { tool: confirmation.toolName })}
      </div>
      <div className="text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
        {confirmation.description}
      </div>
      {confirmation.diff && (
        <pre className="text-[11px] text-[hsl(var(--deck-ink))] bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
          {confirmation.diff}
        </pre>
      )}
      {submitError && (
        <div
          role="alert"
          className="rounded-md border border-red-300/70 bg-red-50 px-2.5 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300"
        >
          {submitError}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleResponse(true, 'once')}
          disabled={submitting}
          className="min-h-8 px-3 py-1.5 text-[12px] font-mono bg-[#22C55E] text-white rounded-md hover:bg-[#16A34A] disabled:cursor-wait disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t('interaction.permission.once')
          )}
        </button>
        {confirmation.allowRemember !== false && (
          <>
            <button
              type="button"
              onClick={() => void handleResponse(true, 'session')}
              disabled={submitting}
              className="min-h-8 px-3 py-1.5 text-[12px] font-mono bg-[#3B82F6] text-white rounded-md hover:bg-[#2563EB] disabled:cursor-wait disabled:opacity-50"
            >
              {t('interaction.permission.session')}
            </button>
            <button
              type="button"
              onClick={() => void handleResponse(true, 'project')}
              disabled={submitting}
              className="min-h-8 px-3 py-1.5 text-[12px] font-mono bg-[#6366F1] text-white rounded-md hover:bg-[#4F46E5] disabled:cursor-wait disabled:opacity-50"
            >
              {t('interaction.permission.project')}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => void handleResponse(false)}
          disabled={submitting}
          className="min-h-8 px-3 py-1.5 text-[12px] font-mono bg-[#EF4444] text-white rounded-md hover:bg-[#DC2626] disabled:cursor-wait disabled:opacity-50"
        >
          {t('interaction.permission.deny')}
        </button>
      </div>
    </div>
  );
}

function QuestionSection({
  question,
  messageId,
}: {
  question: AgentResponseContent['question'];
  messageId: string;
}) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const currentSessionRef = useSessionStore((state) => state.currentSessionRef);
  const setQuestion = useSessionStore((state) => state.setQuestion);

  const resolvedAnswers = useMemo<Record<string, string | string[]>>(() => {
    if (!question) return {};
    return question.questions.reduce<Record<string, string | string[]>>(
      (resolved, item) => {
        const custom = customAnswers[item.header]?.trim();
        const selected = answers[item.header];
        if (item.multiSelect) {
          const values = Array.isArray(selected) ? [...selected] : [];
          if (custom) values.push(custom);
          if (values.length > 0) resolved[item.header] = values;
          return resolved;
        }
        const value = custom || (typeof selected === 'string' ? selected : '');
        if (value) resolved[item.header] = value;
        return resolved;
      },
      {}
    );
  }, [answers, customAnswers, question]);
  const allAnswered =
    question?.questions.every((item) => item.header in resolvedAnswers) ?? false;

  if (!question) return null;

  const handleSubmit = async () => {
    if (!currentSessionRef || submitting || !allAnswered) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await sessionService.respondToQuestion(
        currentSessionRef,
        question.toolCallId,
        resolvedAnswers
      );
      setQuestion(messageId, {
        ...question,
        status: 'answered',
        answers: resolvedAnswers,
      });
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : t('interaction.question.failed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (question.status !== 'pending') {
    return (
      <div className="bg-[hsl(var(--deck-surface-2))] border border-[hsl(var(--deck-border))] rounded-lg px-3 py-2">
        <div className="text-[12px] text-[hsl(var(--deck-ink-muted))] font-mono">
          {t('interaction.question.answered')}
        </div>
      </div>
    );
  }

  return (
    <div
      data-pending-interaction="question"
      tabIndex={-1}
      role="alert"
      className="space-y-4 rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800/70 dark:bg-amber-950/25"
    >
      {question.questions.map((q, idx) => (
        <div key={idx} className="space-y-2">
          <div className="text-[13px] text-[hsl(var(--deck-ink))] font-mono">
            {q.question}
          </div>
          <div className="space-y-1">
            {q.options.map((opt, optIdx) => (
              <button
                key={optIdx}
                type="button"
                onClick={() => {
                  if (q.multiSelect) {
                    const current = (answers[q.header] as string[]) || [];
                    const updated = current.includes(opt.label)
                      ? current.filter((l) => l !== opt.label)
                      : [...current, opt.label];
                    setAnswers({ ...answers, [q.header]: updated });
                  } else {
                    setAnswers({ ...answers, [q.header]: opt.label });
                    setCustomAnswers({ ...customAnswers, [q.header]: '' });
                  }
                }}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md border text-[12px] font-mono transition-colors',
                  'border-[hsl(var(--deck-border))]',
                  (
                    q.multiSelect
                      ? ((answers[q.header] as string[]) || []).includes(opt.label)
                      : answers[q.header] === opt.label
                  )
                    ? 'bg-[#DCFCE7] text-[#166534] dark:bg-[#22C55E]/20 dark:text-[#E5E5E5]'
                    : 'bg-[hsl(var(--deck-surface-2))] text-[hsl(var(--deck-ink-muted))]'
                )}
              >
                <div>{opt.label}</div>
                <div className="text-[11px] text-[hsl(var(--deck-ink-faint))] mt-1">
                  {opt.description}
                </div>
              </button>
            ))}
            <input
              aria-label={`${q.header} other response`}
              value={customAnswers[q.header] ?? ''}
              onChange={(event) =>
                setCustomAnswers({
                  ...customAnswers,
                  [q.header]: event.target.value,
                })
              }
              placeholder={t('interaction.question.other')}
              className="w-full rounded-md border border-[#E5E7EB] bg-white px-3 py-2 text-[12px] text-[#111827] outline-none focus:border-[#22C55E] dark:border-[#27272a] dark:bg-[#111113] dark:text-[#E5E5E5]"
            />
          </div>
        </div>
      ))}
      {submitError && (
        <div
          role="alert"
          className="rounded-md border border-red-300/70 bg-red-50 px-2.5 py-2 font-mono text-[11px] text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300"
        >
          {submitError}
        </div>
      )}
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting || !allAnswered}
        className="inline-flex min-h-8 items-center gap-1.5 px-3 py-1.5 text-[12px] font-mono bg-[#22C55E] text-white rounded-md hover:bg-[#16A34A] disabled:cursor-wait disabled:opacity-50"
      >
        {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('interaction.question.submit')}
      </button>
    </div>
  );
}

function AgentMessageContent({ message }: { message: Message }) {
  const agentContent = message.agentContent;
  const isCurrentStreamingMessage = useSessionStore(
    (state) => state.isStreaming && state.currentAssistantMessageId === message.id
  );

  if (!agentContent) {
    const content = getTextContent(message.content);
    return content ? <MarkdownBlock content={content} /> : null;
  }

  const { toolCalls, tasks, confirmation, question, elicitation } = agentContent;
  const subagents = getSubagents(agentContent);
  const timeline = getAgentTimeline(agentContent);
  const hasContent =
    timeline.length > 0 ||
    tasks.length > 0 ||
    subagents.length > 0 ||
    confirmation ||
    question ||
    elicitation;

  if (!hasContent && isCurrentStreamingMessage) {
    return (
      <div className="flex items-center gap-2 text-[hsl(var(--deck-ink-muted))]">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-[12px] font-mono">Thinking...</span>
      </div>
    );
  }

  const allToolsCompleted =
    toolCalls.length > 0 &&
    toolCalls.every((tc) => tc.status === 'success' || tc.status === 'error');
  const showChangedFiles = allToolsCompleted && !isCurrentStreamingMessage;
  const syntaxHighlight = !isCurrentStreamingMessage;

  return (
    <div className="space-y-3">
      {timeline.map((block) => {
        if (block.type === 'thinking') {
          return (
            <div key={block.id} data-agent-timeline-block="thinking">
              <ThinkingSection content={block.content} />
            </div>
          );
        }
        if (block.type === 'text') {
          return (
            <div key={block.id} data-agent-timeline-block="text">
              <MarkdownBlock
                content={block.content}
                syntaxHighlight={syntaxHighlight}
              />
            </div>
          );
        }
        return (
          <div key={block.id} data-agent-timeline-block="tool_group">
            <ToolCallsGroup toolCalls={toolCalls} toolCallIds={block.toolCallIds} />
          </div>
        );
      })}
      {tasks.length > 0 && <TaskSection tasks={tasks} />}
      {subagents.map((subagent) => (
        <SubagentSection key={subagent.id} subagent={subagent} />
      ))}
      {confirmation && (
        <ConfirmationSection confirmation={confirmation} messageId={message.id} />
      )}
      {question && <QuestionSection question={question} messageId={message.id} />}
      {elicitation && (
        <McpElicitationSection elicitation={elicitation} messageId={message.id} />
      )}
      {showChangedFiles && <ChangedFilesSection toolCalls={toolCalls} />}
    </div>
  );
}

function ChatMessageComponent({ message, showAvatar = true }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    const content = getTextContent(message.content);
    return (
      <div
        data-chat-message-id={message.id}
        data-chat-role="system"
        className="flex justify-center p-2 w-full"
      >
        <div className="text-xs text-[hsl(var(--deck-ink-muted))] bg-[#F3F4F6] dark:bg-[#18181b] px-3 py-1 rounded-full font-mono">
          {content}
        </div>
      </div>
    );
  }

  if (isUser) {
    const shell =
      message.metadata?.userShellCommand &&
      typeof message.metadata.userShellCommand === 'object'
        ? (message.metadata.userShellCommand as Record<string, unknown>)
        : message.metadata?.userShellExecution &&
            typeof message.metadata.userShellExecution === 'object'
          ? (message.metadata.userShellExecution as Record<string, unknown>)
          : undefined;
    if (shell) {
      const command = typeof shell.command === 'string' ? shell.command : '';
      const status =
        shell.status === 'running'
          ? 'running'
          : shell.status === 'completed'
            ? 'success'
            : 'error';
      const output =
        typeof shell.output === 'string'
          ? shell.output
          : [
              typeof shell.stdout === 'string' ? shell.stdout : '',
              typeof shell.stderr === 'string' && shell.stderr
                ? `stderr:\n${shell.stderr}`
                : '',
            ]
              .filter(Boolean)
              .join('\n');
      return (
        <div
          data-chat-message-id={message.id}
          data-chat-role="user"
          data-user-shell-command
          className="flex w-full justify-end p-4"
        >
          <div className="w-full max-w-[85%] overflow-hidden rounded-lg border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]">
            <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 py-2">
              <div className="min-w-0 truncate font-mono text-[12px] text-[hsl(var(--deck-ink))]">
                <span className="mr-2 text-amber-600 dark:text-amber-400">$</span>
                {command}
              </div>
              <StatusPill status={status} />
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
              {output || '(no output)'}
            </pre>
            {typeof shell.exitCode === 'number' && (
              <div className="border-t border-[hsl(var(--deck-border))] px-3 py-1.5 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]">
                exit {shell.exitCode}
                {typeof shell.durationMs === 'number'
                  ? ` · ${(shell.durationMs / 1000).toFixed(3)}s`
                  : ''}
                {shell.truncated === true ? ' · truncated' : ''}
              </div>
            )}
          </div>
        </div>
      );
    }
    const { text, images } = getUserMessageParts(message.content);
    return (
      <div
        data-chat-message-id={message.id}
        data-chat-role="user"
        className="group flex gap-2 justify-end p-4 w-full items-start"
      >
        <div className="mt-1 flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <CopyButton text={text} label="Copy message" />
        </div>
        <div className="bg-[hsl(var(--deck-surface-2))] rounded-lg px-4 py-3 max-w-[85%]">
          {text && (
            <p className="text-[14px] text-[hsl(var(--deck-ink))] font-mono leading-relaxed whitespace-pre-wrap">
              {text}
            </p>
          )}
          {images.length > 0 && (
            <div
              className={cn(
                'grid gap-2',
                images.length === 1 ? 'grid-cols-1 mt-0' : 'grid-cols-2 mt-3'
              )}
            >
              {images.map((src: string, index: number) => (
                <img
                  key={`${src}-${index}`}
                  src={src}
                  alt={`attachment-${index + 1}`}
                  className="object-cover w-full max-h-64 rounded-md"
                />
              ))}
            </div>
          )}
        </div>
        <UserAvatar />
      </div>
    );
  }

  const assistantText = getAssistantCopyText(message);
  const codeReviewReport = parseCodeReviewReport(message.metadata?.codeReview);
  const structuredOutputReport = parseStructuredOutputReport(
    message.metadata?.structuredOutput
  );
  return (
    <div
      data-chat-message-id={message.id}
      data-chat-role="assistant"
      className={cn(
        'group flex gap-4 justify-start w-full',
        showAvatar ? 'p-4' : 'px-4 pt-0 pb-3'
      )}
    >
      {showAvatar ? <AIAvatar /> : <div className="w-8 shrink-0" />}
      <div className="overflow-hidden flex-1 min-w-0">
        {codeReviewReport ? (
          <CodeReviewReport report={codeReviewReport} />
        ) : structuredOutputReport ? (
          <StructuredOutputReport report={structuredOutputReport} />
        ) : (
          <AgentMessageContent message={message} />
        )}
        {!structuredOutputReport && assistantText.trim() && (
          <div className="mt-1.5 flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <CopyButton text={assistantText} label="Copy response" />
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatMessage = memo(ChatMessageComponent);
