import { sessionService, type Message } from '@/services'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/store/session'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SubagentProgress } from './SubagentProgress'
import { ThinkingBlock, ThinkingContent } from './ThinkingBlock'
import { InlineTodoList } from './TodoList'

export type { Message }

interface ChatMessageProps {
  message: Message
  showAvatar?: boolean
}

function AIAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg bg-[#22C55E]">
      <span className="text-sm font-bold text-black">B</span>
    </div>
  )
}

function UserAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full bg-[#E5E7EB] dark:bg-white">
      <span className="text-sm font-medium text-[#111827] dark:text-zinc-800">U</span>
    </div>
  )
}

function extractUserContent(content: string): string {
  let result = content
  result = result.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  result = result.replace(/<file path="[^"]*">[\s\S]*?<\/file>/g, '')
  result = result.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, '')
  result = result.trim()
  return result
}

function AssistantMessageContent({ message }: { message: Message }) {
  const { currentThinkingContent, todos, subagentProgress } = useSessionStore()
  const metadata = message.metadata as Record<string, unknown> | undefined
  const kind = metadata?.kind as string | undefined

  if (kind === 'tool_call') return <ToolCallBlock metadata={metadata} />
  if (kind === 'tool_result') return <ToolResultBlock metadata={metadata} content={message.content} />
  if (kind === 'tool_batch') return <ToolBatchBlock metadata={metadata} />
  if (kind === 'confirmation') return <ConfirmationBlock metadata={metadata} />

  return (
    <>
      {currentThinkingContent && <ThinkingBlock />}
      {currentThinkingContent && <ThinkingContent />}
      {todos.length > 0 && <InlineTodoList todos={todos} />}
      {subagentProgress && <SubagentProgress />}
      {message.content && <MarkdownRenderer content={message.content} />}
    </>
  )
}

export function ChatMessage({ message, showAvatar = true }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex w-full justify-center p-2">
        <div className="text-xs text-[#6B7280] dark:text-[#71717a] bg-[#F3F4F6] dark:bg-[#18181b] px-3 py-1 rounded-full font-mono">
          {message.content}
        </div>
      </div>
    )
  }

  if (isUser) {
    const displayContent = extractUserContent(message.content)
    return (
      <div className="flex w-full gap-4 p-4 justify-end">
        <div className="bg-[#F3F4F6] dark:bg-[#27272a] rounded-lg px-4 py-3 max-w-[85%]">
          <p className="text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono leading-relaxed whitespace-pre-wrap">
            {displayContent}
          </p>
        </div>
        <UserAvatar />
      </div>
    )
  }

  return (
    <div className={cn("flex w-full gap-4 justify-start", showAvatar ? "p-4" : "px-4 pb-3 pt-0")}>
      {showAvatar ? <AIAvatar /> : <div className="w-8 shrink-0" />}
      <div className="flex-1 min-w-0 overflow-hidden">
        <AssistantMessageContent message={message} />
      </div>
    </div>
  )
}

type ToolCallMetadata = {
  kind?: 'tool_call'
  toolCallId?: string
  toolName?: string
  arguments?: string | Record<string, unknown>
  toolKind?: string
  status?: 'running' | 'success' | 'error'
}

type ToolBatchItem = {
  toolCallId: string
  toolName: string
  arguments?: string
  toolKind?: string
  status: 'running' | 'success' | 'error'
  summary?: string
  output?: string
}

type ToolBatchMetadata = {
  kind?: 'tool_batch'
  batchId?: string
  tools?: ToolBatchItem[]
  isComplete?: boolean
}

function ToolCallBlock({ metadata }: { metadata?: Record<string, unknown> }) {
  const meta = metadata as ToolCallMetadata | undefined
  const args = formatToolArguments(meta?.arguments)

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-transparent">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Tool Call</span>
          {meta?.toolKind && (
            <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa] font-mono">
              {meta.toolKind}
            </span>
          )}
        </div>
        <StatusPill status={meta?.status} />
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">
          {meta?.toolName || 'Unknown tool'}
        </div>
        <div className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">Arguments</div>
        <pre className="text-[12px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono">
          {args || '{}'}
        </pre>
      </div>
    </div>
  )
}

function ToolBatchBlock({ metadata }: { metadata?: Record<string, unknown> }) {
  const meta = metadata as ToolBatchMetadata | undefined
  const tools = meta?.tools || []
  const [expanded, setExpanded] = useState(false)
  
  const runningCount = tools.filter((t) => t.status === 'running').length
  const successCount = tools.filter((t) => t.status === 'success').length
  const errorCount = tools.filter((t) => t.status === 'error').length
  const totalCount = tools.length
  
  const overallStatus = runningCount > 0 ? 'running' : errorCount > 0 ? 'error' : 'success'
  
  const toolNames = tools.map((t) => t.toolName)
  const uniqueToolNames = [...new Set(toolNames)]
  const summaryText = uniqueToolNames.length <= 3 
    ? uniqueToolNames.join(', ')
    : `${uniqueToolNames.slice(0, 2).join(', ')} +${uniqueToolNames.length - 2}`

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-4 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-transparent hover:bg-[#F3F4F6] dark:hover:bg-[#1f1f23] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
            ) : (
              <ChevronRight className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
            )}
          </div>
          <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
            {totalCount} Tool{totalCount > 1 ? 's' : ''}
          </span>
          <span className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono truncate max-w-[200px]">
            {summaryText}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {runningCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa] font-mono">
              {runningCount} running
            </span>
          )}
          {successCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#DCFCE7] text-[#15803D] dark:bg-[#22C55E]/20 dark:text-[#22C55E] font-mono">
              {successCount} done
            </span>
          )}
          {errorCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5] font-mono">
              {errorCount} failed
            </span>
          )}
          <StatusPill status={overallStatus} />
        </div>
      </button>
      
      {expanded && (
        <div className="divide-y divide-[#E5E7EB] dark:divide-[#27272a]">
          {tools.map((tool) => (
            <ToolBatchItem key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolBatchItem({ tool }: { tool: ToolBatchItem }) {
  const [showDetails, setShowDetails] = useState(false)
  const args = formatToolArguments(tool.arguments)
  
  return (
    <div className="px-4 py-2">
      <button
        onClick={() => setShowDetails((prev) => !prev)}
        className="w-full flex items-center justify-between hover:bg-[#F3F4F6] dark:hover:bg-[#1f1f23] -mx-2 px-2 py-1 rounded transition-colors"
      >
        <div className="flex items-center gap-2">
          {showDetails ? (
            <ChevronDown className="h-3 w-3 text-[#9CA3AF] dark:text-[#71717a]" />
          ) : (
            <ChevronRight className="h-3 w-3 text-[#9CA3AF] dark:text-[#71717a]" />
          )}
          <span className="text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono">{tool.toolName}</span>
          {tool.summary && (
            <span className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono truncate max-w-[300px]">
              {tool.summary}
            </span>
          )}
        </div>
        <StatusPill status={tool.status} />
      </button>
      
      {showDetails && (
        <div className="mt-2 ml-5 space-y-2">
          {args && (
            <div className="space-y-1">
              <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">Arguments</div>
              <pre className="text-[11px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[150px] overflow-y-auto">
                {args}
              </pre>
            </div>
          )}
          {tool.output && (
            <div className="space-y-1">
              <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">Output</div>
              <pre className="text-[11px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[150px] overflow-y-auto">
                {tool.output.length > 500 ? tool.output.slice(0, 500) + '...' : tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type ToolResultMetadata = {
  kind?: 'tool_result'
  toolCallId?: string
  toolName?: string
  success?: boolean
  summary?: string
  output?: string
  metadata?: Record<string, unknown>
}

function getToolResultStatus(meta?: ToolResultMetadata): 'running' | 'success' | 'error' | 'info' | undefined {
  if (meta?.success === undefined) return undefined
  if (meta.success) return 'success'
  const innerMeta = meta.metadata as Record<string, unknown> | undefined
  if (innerMeta?.requiresRead) return 'info'
  return 'error'
}

function ToolResultBlock({ metadata, content }: { metadata?: Record<string, unknown>; content?: string }) {
  const meta = metadata as ToolResultMetadata | undefined
  const rawOutput = meta?.output || content || ''
  const { diff, cleanedOutput } = useMemo(() => extractDiffBlock(rawOutput), [rawOutput])
  const output = cleanedOutput.trim()
  const [expanded, setExpanded] = useState(false)
  const lines = output ? output.split('\n') : []
  const isLong = lines.length > 14 || output.length > 900
  const visibleLines = expanded || !isLong ? lines : lines.slice(0, 12)
  const displayOutput = visibleLines.join('\n')
  const status = getToolResultStatus(meta)

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-transparent">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Tool Output</span>
          <span className="text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono">{meta?.toolName || 'Unknown tool'}</span>
        </div>
        <StatusPill status={status} />
      </div>
      <div className="px-4 py-3 space-y-3">
        {meta?.summary && (
          <div className="text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">{meta.summary}</div>
        )}
        {diff && <DiffViewer diff={diff} />}
        {output && (
          <div className="space-y-2">
            <pre className="text-[12px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono">
              {displayOutput}
              {!expanded && isLong && '\n…'}
            </pre>
            {isLong && (
              <button
                onClick={() => setExpanded((prev) => !prev)}
                className="flex items-center gap-1 text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono hover:text-[#111827] dark:hover:text-[#E5E5E5] transition-colors"
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {expanded ? 'Collapse' : 'Expand'}
              </button>
            )}
          </div>
        )}
        {!output && !diff && (
          <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">No output returned.</div>
        )}
      </div>
    </div>
  )
}

type ConfirmationMetadata = {
  kind?: 'confirmation'
  requestId?: string
  details?: Record<string, unknown>
  status?: 'pending' | 'approved' | 'denied'
  answers?: Record<string, string | string[]>
}

type QuestionOption = {
  label: string
  description: string
}

type Question = {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

type ConfirmationDetails = {
  type?: string
  kind?: string
  toolName?: string
  args?: Record<string, unknown>
  title?: string
  message?: string
  details?: string
  risks?: string[]
  affectedFiles?: string[]
  planContent?: string
  questions?: Question[]
}

function ConfirmationBlock({ metadata }: { metadata?: Record<string, unknown> }) {
  const meta = metadata as ConfirmationMetadata | undefined
  const details = meta?.details as ConfirmationDetails | undefined

  if (!details) {
    return (
      <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-4 text-[13px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
        Awaiting confirmation…
      </div>
    )
  }

  if (details.type === 'askUserQuestion' && details.questions) {
    return (
      <QuestionPrompt
        requestId={meta?.requestId}
        questions={details.questions}
        status={meta?.status}
        answers={meta?.answers}
      />
    )
  }

  return (
    <PermissionPrompt
      requestId={meta?.requestId}
      status={meta?.status}
      details={details}
    />
  )
}

function PermissionPrompt({
  requestId,
  status,
  details,
}: {
  requestId?: string
  status?: ConfirmationMetadata['status']
  details: ConfirmationDetails
}) {
  const [submitting, setSubmitting] = useState(false)
  const { currentSessionId } = useSessionStore()
  const argsText = details.args ? JSON.stringify(details.args, null, 2) : ''
  const title = details.title || (details.toolName ? `Permission: ${details.toolName}` : 'Permission required')
  const canRespond = status === 'pending' || status === undefined
  const allowActions = canRespond && !!requestId && !submitting && !!currentSessionId

  const respond = async (payload: { approved: boolean; scope?: 'once' | 'session' }) => {
    if (!requestId || !currentSessionId || submitting) return
    setSubmitting(true)
    try {
      await sessionService.respondPermission(currentSessionId, requestId, payload)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-transparent">
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Confirmation</span>
        <StatusPill status={status === 'approved' ? 'success' : status === 'denied' ? 'error' : 'running'} />
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">{title}</div>
        {details.message && (
          <div className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono whitespace-pre-wrap">
            {details.message}
          </div>
        )}
        {details.details && (
          <div className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono whitespace-pre-wrap">
            {details.details}
          </div>
        )}
        {details.planContent && (
          <div className="bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-3">
            <MarkdownRenderer content={details.planContent} />
          </div>
        )}
        {details.risks && details.risks.length > 0 && (
          <div className="space-y-1">
            <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Risks</div>
            <ul className="space-y-1">
              {details.risks.map((risk, index) => (
                <li key={`${risk}-${index}`} className="text-[12px] text-[#DC2626] dark:text-[#fca5a5] font-mono">• {risk}</li>
              ))}
            </ul>
          </div>
        )}
        {details.affectedFiles && details.affectedFiles.length > 0 && (
          <div className="space-y-1">
            <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Affected files</div>
            <ul className="space-y-1">
              {details.affectedFiles.map((file, index) => (
                <li key={`${file}-${index}`} className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">{file}</li>
              ))}
            </ul>
          </div>
        )}
        {argsText && (
          <div className="space-y-1">
            <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Arguments</div>
            <pre className="text-[12px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono">
              {argsText}
            </pre>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {details.type === 'enterPlanMode' || details.type === 'maxTurnsExceeded' ? (
            <>
              <button
                onClick={() => respond({ approved: true })}
                disabled={!allowActions}
                className={cn(
                  'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
                  allowActions
                    ? 'bg-[#16A34A] text-white hover:bg-[#15803D] border-[#16A34A]'
                    : 'bg-[#E5E7EB] text-[#9CA3AF] border-[#E5E7EB] dark:bg-[#27272a] dark:text-[#71717a] dark:border-[#27272a]'
                )}
              >
                Continue
              </button>
              <button
                onClick={() => respond({ approved: false })}
                disabled={!allowActions}
                className={cn(
                  'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
                  allowActions
                    ? 'bg-transparent text-[#DC2626] hover:bg-[#FEE2E2] border-[#E5E7EB] dark:text-[#fca5a5] dark:hover:bg-[#27272a] dark:border-[#27272a]'
                    : 'text-[#9CA3AF] border-[#E5E7EB] dark:text-[#71717a] dark:border-[#27272a]'
                )}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => respond({ approved: true, scope: 'once' })}
                disabled={!allowActions}
                className={cn(
                  'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
                  allowActions
                    ? 'bg-[#16A34A] text-white hover:bg-[#15803D] border-[#16A34A]'
                    : 'bg-[#E5E7EB] text-[#9CA3AF] border-[#E5E7EB] dark:bg-[#27272a] dark:text-[#71717a] dark:border-[#27272a]'
                )}
              >
                Allow once
              </button>
              <button
                onClick={() => respond({ approved: true, scope: 'session' })}
                disabled={!allowActions}
                className={cn(
                  'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
                  allowActions
                    ? 'bg-[#E5E7EB] text-[#111827] hover:bg-[#D1D5DB] border-[#E5E7EB] dark:bg-[#27272a] dark:text-[#E5E5E5] dark:hover:bg-[#3f3f46] dark:border-[#27272a]'
                    : 'bg-[#E5E7EB] text-[#9CA3AF] border-[#E5E7EB] dark:bg-[#27272a] dark:text-[#71717a] dark:border-[#27272a]'
                )}
              >
                Allow session
              </button>
              <button
                onClick={() => respond({ approved: false })}
                disabled={!allowActions}
                className={cn(
                  'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
                  allowActions
                    ? 'bg-transparent text-[#DC2626] hover:bg-[#FEE2E2] border-[#E5E7EB] dark:text-[#fca5a5] dark:hover:bg-[#27272a] dark:border-[#27272a]'
                    : 'text-[#9CA3AF] border-[#E5E7EB] dark:text-[#71717a] dark:border-[#27272a]'
                )}
              >
                Deny
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function QuestionPrompt({
  requestId,
  questions,
  status,
  answers,
}: {
  requestId?: string
  questions: Question[]
  status?: ConfirmationMetadata['status']
  answers?: Record<string, string | string[]>
}) {
  const [submitting, setSubmitting] = useState(false)
  const { currentSessionId } = useSessionStore()
  const [selection, setSelection] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {}
    for (const question of questions) {
      initial[question.header] = []
    }
    return initial
  })
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const canRespond = status === 'pending' || status === undefined
  const allowActions = canRespond && !!requestId && !submitting && !!currentSessionId

  const toggleOption = (header: string, label: string, multi: boolean) => {
    setSelection((prev) => {
      const current = prev[header] || []
      if (multi) {
        return {
          ...prev,
          [header]: current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label],
        }
      }
      return { ...prev, [header]: [label] }
    })
  }

  const respond = async (approved: boolean) => {
    if (!requestId || !currentSessionId || submitting) return
    if (!approved) {
      setSubmitting(true)
      try {
        await sessionService.respondPermission(currentSessionId, requestId, { approved: false })
      } finally {
        setSubmitting(false)
      }
      return
    }

    const payloadAnswers: Record<string, string | string[]> = {}
    for (const question of questions) {
      const selected = selection[question.header] || []
      const includeOther = selected.includes('__other__')
      const otherValue = otherText[question.header]?.trim()
      if (question.multiSelect) {
        const values = selected.filter((item) => item !== '__other__')
        if (includeOther && otherValue) values.push(otherValue)
        if (values.length > 0) payloadAnswers[question.header] = values
      } else {
        let value = selected[0]
        if (value === '__other__') value = otherValue || ''
        if (value) payloadAnswers[question.header] = value
      }
    }

    setSubmitting(true)
    try {
      await sessionService.respondPermission(currentSessionId, requestId, { approved: true, answers: payloadAnswers })
    } finally {
      setSubmitting(false)
    }
  }

  if (status && status !== 'pending') {
    return (
      <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Questions</span>
          <StatusPill status={status === 'approved' ? 'success' : 'error'} />
        </div>
        {answers && (
          <div className="space-y-1">
            {Object.entries(answers).map(([header, answer]) => (
              <div key={header} className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                {header}: {Array.isArray(answer) ? answer.join(', ') : answer}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-transparent">
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Questions</span>
        <StatusPill status="running" />
      </div>
      <div className="px-4 py-3 space-y-4">
        {questions.map((question) => (
          <div key={question.header} className="space-y-2">
            <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono uppercase">{question.header}</div>
            <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">{question.question}</div>
            <div className="space-y-2">
              {question.options.map((option) => {
                const selected = selection[question.header] || []
                const isSelected = selected.includes(option.label)
                return (
                  <button
                    key={option.label}
                    onClick={() => toggleOption(question.header, option.label, question.multiSelect)}
                    disabled={!allowActions}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-md border transition-colors',
                      'border-[#E5E7EB] dark:border-[#27272a] font-mono text-[12px]',
                      isSelected
                        ? 'bg-[#DCFCE7] text-[#166534] dark:bg-[#22C55E]/20 dark:text-[#E5E5E5]'
                        : 'bg-[#F9FAFB] text-[#6B7280] dark:bg-[#111113] dark:text-[#a1a1aa]',
                      !allowActions && 'opacity-60'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span>{option.label}</span>
                      <span className="text-[11px] text-[#9CA3AF] dark:text-[#71717a]">
                        {question.multiSelect ? 'Select' : 'Choose'}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] mt-1">{option.description}</div>
                  </button>
                )
              })}
              <div className="space-y-2">
                <button
                  onClick={() => toggleOption(question.header, '__other__', question.multiSelect)}
                  disabled={!allowActions}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md border transition-colors',
                    'border-dashed border-[#E5E7EB] dark:border-[#27272a] font-mono text-[12px]',
                    (selection[question.header] || []).includes('__other__')
                      ? 'bg-[#E5E7EB] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5]'
                      : 'bg-transparent text-[#6B7280] dark:text-[#a1a1aa]',
                    !allowActions && 'opacity-60'
                  )}
                >
                  Other
                </button>
                {(selection[question.header] || []).includes('__other__') && (
                  <input
                    value={otherText[question.header] || ''}
                    onChange={(event) =>
                      setOtherText((prev) => ({ ...prev, [question.header]: event.target.value }))
                    }
                    placeholder="Type your answer"
                    disabled={!allowActions}
                    className="w-full bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md px-3 py-2 text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => respond(true)}
            disabled={!allowActions}
            className={cn(
              'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
              allowActions
                ? 'bg-[#16A34A] text-white hover:bg-[#15803D] border-[#16A34A]'
                : 'bg-[#E5E7EB] text-[#9CA3AF] border-[#E5E7EB] dark:bg-[#27272a] dark:text-[#71717a] dark:border-[#27272a]'
            )}
          >
            Submit answers
          </button>
          <button
            onClick={() => respond(false)}
            disabled={!allowActions}
            className={cn(
              'px-3 py-1.5 text-[12px] font-mono rounded-md border border-[#27272a] transition-colors',
              allowActions
                ? 'bg-transparent text-[#DC2626] hover:bg-[#FEE2E2] border-[#E5E7EB] dark:text-[#fca5a5] dark:hover:bg-[#27272a] dark:border-[#27272a]'
                : 'text-[#9CA3AF] border-[#E5E7EB] dark:text-[#71717a] dark:border-[#27272a]'
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status?: 'running' | 'success' | 'error' | 'info' }) {
  const label = status === 'success' ? 'Success' : status === 'error' ? 'Failed' : status === 'info' ? 'Info' : 'Running'
  const className = status === 'success'
    ? 'bg-[#22C55E] text-white'
    : status === 'error'
      ? 'bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5]'
      : status === 'info'
        ? 'bg-[#DBEAFE] text-[#1D4ED8] dark:bg-[#3B82F6]/20 dark:text-[#93C5FD]'
        : 'bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]'
  return (
    <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-mono', className)}>{label}</span>
  )
}

function formatToolArguments(args?: string | Record<string, unknown>): string {
  if (!args) return ''
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2)
    } catch {
      return args
    }
  }
  return JSON.stringify(args, null, 2)
}

type DiffData = {
  patch: string
  startLine?: number
  matchLine?: number
}

function extractDiffBlock(output: string): { diff?: DiffData; cleanedOutput: string } {
  if (!output) return { cleanedOutput: '' }
  const regex = /<<<DIFF>>>\s*([\s\S]*?)\s*<<<\/DIFF>>>/m
  const match = output.match(regex)
  if (!match) return { cleanedOutput: output }
  try {
    const diff = JSON.parse(match[1]) as DiffData
    const cleanedOutput = output.replace(match[0], '').trim()
    return { diff, cleanedOutput }
  } catch {
    return { cleanedOutput: output }
  }
}

function DiffViewer({ diff }: { diff: DiffData }) {
  const lines = diff.patch.split('\\n')
  let oldLine = 0
  let newLine = 0

  return (
    <div className="border border-[#E5E7EB] dark:border-[#27272a] rounded-md overflow-hidden bg-white dark:bg-[#111113]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-[#111113] text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
        <span>Patch</span>
        {diff.matchLine && <span>Line {diff.matchLine}</span>}
      </div>
      <div className="text-[12px] font-mono">
        {lines.map((line, index) => {
          if (line.startsWith('@@')) {
            const match = /@@ -(?<old>\d+),?(?<oldCount>\d*) \+(?<new>\d+),?(?<newCount>\d*) @@/.exec(line)
            if (match?.groups) {
              oldLine = parseInt(match.groups.old, 10)
              newLine = parseInt(match.groups.new, 10)
            }
            return (
              <DiffLine key={`${line}-${index}`} line={line} />
            )
          }

          if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:') || line.startsWith('===')) {
            return <DiffLine key={`${line}-${index}`} line={line} />
          }

          if (line.startsWith('+')) {
            const currentNew = newLine
            newLine += 1
            return <DiffLine key={`${line}-${index}`} line={line} oldLine={null} newLine={currentNew} />
          }

          if (line.startsWith('-')) {
            const currentOld = oldLine
            oldLine += 1
            return <DiffLine key={`${line}-${index}`} line={line} oldLine={currentOld} newLine={null} />
          }

          if (line.startsWith(' ')) {
            const currentOld = oldLine
            const currentNew = newLine
            oldLine += 1
            newLine += 1
            return <DiffLine key={`${line}-${index}`} line={line} oldLine={currentOld} newLine={currentNew} />
          }

          return <DiffLine key={`${line}-${index}`} line={line} />
        })}
      </div>
    </div>
  )
}

function DiffLine({
  line,
  oldLine,
  newLine,
}: {
  line: string
  oldLine?: number | null
  newLine?: number | null
}) {
  const isMeta =
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('Index:') ||
    line.startsWith('===')
  const isHunk = line.startsWith('@@')
  const sign = line[0]
  const content = isMeta || isHunk ? line : line.slice(1)
  const lineStyle = isMeta
    ? 'text-[#6B7280] dark:text-[#a1a1aa]'
    : sign === '+'
      ? 'text-[#166534] bg-[#22C55E]/10 dark:text-[#86efac] dark:bg-[#22C55E]/10'
      : sign === '-'
        ? 'text-[#b91c1c] bg-[#EF4444]/10 dark:text-[#fca5a5] dark:bg-[#EF4444]/10'
        : isHunk
          ? 'text-[#1d4ed8] bg-[#DBEAFE] dark:text-[#93c5fd] dark:bg-[#1e3a8a]/30'
          : 'text-[#374151] dark:text-[#d4d4d8]'

  return (
    <div className={cn('grid grid-cols-[40px_40px_1fr] gap-2 px-3 py-0.5', lineStyle)}>
      <span className="text-right text-[#9CA3AF] dark:text-[#71717a]">
        {oldLine ? String(oldLine).padStart(2, ' ') : ''}
      </span>
      <span className="text-right text-[#9CA3AF] dark:text-[#71717a]">
        {newLine ? String(newLine).padStart(2, ' ') : ''}
      </span>
      <span className="whitespace-pre">{content}</span>
    </div>
  )
}
