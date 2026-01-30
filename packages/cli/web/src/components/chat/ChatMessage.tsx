import { cn } from '@/lib/utils'
import { sessionService } from '@/services'
import { useAppStore } from '@/store/AppStore'
import type { AgentResponseContent, Message, ToolCallInfo } from '@/store/session'
import { useSessionStore } from '@/store/session'
import { ChevronDown, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'

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

function StatusPill({ status }: { status?: 'running' | 'success' | 'error' | 'pending' | 'info' }) {
  if (!status) return null
  const styles = {
    running: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#F59E0B]/20 dark:text-[#FBBF24]',
    success: 'bg-[#DCFCE7] text-[#15803D] dark:bg-[#22C55E]/20 dark:text-[#22C55E]',
    error: 'bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5]',
    pending: 'bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]',
    info: 'bg-[#DBEAFE] text-[#1D4ED8] dark:bg-[#3B82F6]/20 dark:text-[#60A5FA]',
  }
  const labels = { running: 'Running', success: 'Success', error: 'Error', pending: 'Pending', info: 'Info' }
  return (
    <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-mono', styles[status])}>
      {labels[status]}
    </span>
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

function ToolCallItem({ tool }: { tool: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false)
  const args = formatToolArguments(tool.arguments)

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#F9FAFB] dark:bg-transparent hover:bg-[#F3F4F6] dark:hover:bg-[#1f1f23] transition-colors"
      >
        <div className="flex gap-2 items-center min-w-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a] shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a] shrink-0" />
          )}
          <span className="text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono shrink-0">{tool.toolName}</span>
          {tool.summary && (
            <span className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono truncate">
              {tool.summary}
            </span>
          )}
        </div>
        <StatusPill status={tool.status} />
      </button>

      {expanded && (
        <div className="px-3 py-2 space-y-2 border-t border-[#E5E7EB] dark:border-[#27272a]">
          {args && (
            <div className="space-y-1">
              <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">Arguments</div>
              <pre className="text-[11px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[120px] overflow-y-auto">
                {args}
              </pre>
            </div>
          )}
          {tool.output && (
            <div className="space-y-1">
              <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">Output</div>
              <pre className="text-[11px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[120px] overflow-y-auto">
                {tool.output.length > 500 ? tool.output.slice(0, 500) + '...' : tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolCallsList({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  if (toolCalls.length === 0) return null

  return (
    <div className="space-y-2">
      {toolCalls.map((tool) => (
        <ToolCallItem key={tool.toolCallId} tool={tool} />
      ))}
    </div>
  )
}

function ThinkingSection({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!content) return null

  return (
    <div className="bg-[#F9FAFB] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#F3F4F6] dark:hover:bg-[#1f1f23] transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[#9CA3AF] dark:text-[#71717a]" />
        )}
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">Thought</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-[#E5E7EB] dark:border-[#27272a]">
          <pre className="text-[11px] text-[#6B7280] dark:text-[#a1a1aa] whitespace-pre-wrap font-mono">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

function TodoSection({ todos }: { todos: AgentResponseContent['todos'] }) {
  if (todos.length === 0) return null

  const completedCount = todos.filter((t) => t.status === 'completed').length
  const allDone = completedCount === todos.length

  return (
    <div className="bg-[#F9FAFB] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg px-3 py-2">
      <div className="flex gap-2 items-center">
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
          {allDone ? '✓ All todos done' : `Todos: ${completedCount}/${todos.length}`}
        </span>
      </div>
    </div>
  )
}

function ChangedFilesSection({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const { setFilePreviewOpen } = useAppStore()

  const changedFiles = useMemo(() => {
    const files = new Map<string, { path: string; toolName: string }>()
    const editTools = ['Write', 'SearchReplace', 'Edit']
    for (const tc of toolCalls) {
      if (tc.status !== 'success') continue
      const meta = tc.metadata as Record<string, unknown> | undefined
      const filePath = meta?.file_path as string | undefined
      if (filePath && editTools.includes(tc.toolName)) {
        files.set(filePath, { path: filePath, toolName: tc.toolName })
      }
    }
    return Array.from(files.values())
  }, [toolCalls])

  if (changedFiles.length === 0) return null

  const handleFileClick = () => {
    setFilePreviewOpen(true)
  }

  return (
    <div className="bg-[#F9FAFB] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg px-3 py-2">
      <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono mb-1.5">
        Changed files ({changedFiles.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {changedFiles.map(({ path }) => {
          const fileName = path.split('/').pop() || path
          return (
            <button
              key={path}
              onClick={handleFileClick}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono bg-[#E5E7EB] dark:bg-[#27272a] text-[#374151] dark:text-[#d4d4d8] rounded hover:bg-[#D1D5DB] dark:hover:bg-[#3f3f46] transition-colors"
              title={path}
            >
              <FileText className="w-3 h-3" />
              {fileName}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SubagentSection({ subagent }: { subagent: AgentResponseContent['subagent'] }) {
  if (!subagent) return null

  return (
    <div className="bg-[#F9FAFB] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg px-3 py-2">
      <div className="flex gap-2 items-center">
        {subagent.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-[#6B7280]" />}
        <span className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
          {subagent.type}: {subagent.description}
        </span>
        <StatusPill status={subagent.status === 'completed' ? 'success' : subagent.status === 'failed' ? 'error' : 'running'} />
      </div>
    </div>
  )
}

function ConfirmationSection({ confirmation, messageId }: { confirmation: AgentResponseContent['confirmation'], messageId: string }) {
  const [submitting, setSubmitting] = useState(false)
  const { currentSessionId, setConfirmation } = useSessionStore()

  if (!confirmation) return null

  const handleResponse = async (approved: boolean, scope?: 'once' | 'session') => {
    if (!currentSessionId || submitting) return
    setSubmitting(true)
    try {
      await sessionService.respondPermission(currentSessionId, confirmation.toolCallId, { approved, scope })
      setConfirmation(messageId, {
        ...confirmation,
        status: approved ? 'approved' : 'denied',
      })
    } catch (error) {
      setConfirmation(messageId, {
        ...confirmation,
        status: approved ? 'approved' : 'denied',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (confirmation.status !== 'pending') {
    return null
  }

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-4 space-y-3">
      <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">
        Permission required: {confirmation.toolName}
      </div>
      <div className="text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
        {confirmation.description}
      </div>
      {confirmation.diff && (
        <pre className="text-[11px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
          {confirmation.diff}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(true, 'once')}
          disabled={submitting}
          className="px-3 py-1.5 text-[12px] font-mono bg-[#22C55E] text-white rounded-md hover:bg-[#16A34A] disabled:opacity-50"
        >
          Once
        </button>
        <button
          onClick={() => handleResponse(true, 'session')}
          disabled={submitting}
          className="px-3 py-1.5 text-[12px] font-mono bg-[#3B82F6] text-white rounded-md hover:bg-[#2563EB] disabled:opacity-50"
        >
          Session
        </button>
        <button
          onClick={() => handleResponse(false)}
          disabled={submitting}
          className="px-3 py-1.5 text-[12px] font-mono bg-[#EF4444] text-white rounded-md hover:bg-[#DC2626] disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function QuestionSection({ question }: { question: AgentResponseContent['question'] }) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const { currentSessionId } = useSessionStore()

  if (!question) return null

  const handleSubmit = async () => {
    if (!currentSessionId || submitting) return
    setSubmitting(true)
    try {
      await sessionService.respondToQuestion(currentSessionId, question.toolCallId, answers)
    } finally {
      setSubmitting(false)
    }
  }

  if (question.status !== 'pending') {
    return (
      <div className="bg-[#F9FAFB] dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg px-3 py-2">
        <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
          Questions answered
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-[#18181b] border border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-4 space-y-4">
      {question.questions.map((q, idx) => (
        <div key={idx} className="space-y-2">
          <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">{q.question}</div>
          <div className="space-y-1">
            {q.options.map((opt, optIdx) => (
              <button
                key={optIdx}
                onClick={() => {
                  if (q.multiSelect) {
                    const current = (answers[q.header] as string[]) || []
                    const updated = current.includes(opt.label)
                      ? current.filter((l) => l !== opt.label)
                      : [...current, opt.label]
                    setAnswers({ ...answers, [q.header]: updated })
                  } else {
                    setAnswers({ ...answers, [q.header]: opt.label })
                  }
                }}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md border text-[12px] font-mono transition-colors',
                  'border-[#E5E7EB] dark:border-[#27272a]',
                  (q.multiSelect
                    ? ((answers[q.header] as string[]) || []).includes(opt.label)
                    : answers[q.header] === opt.label)
                    ? 'bg-[#DCFCE7] text-[#166534] dark:bg-[#22C55E]/20 dark:text-[#E5E5E5]'
                    : 'bg-[#F9FAFB] text-[#6B7280] dark:bg-[#111113] dark:text-[#a1a1aa]'
                )}
              >
                <div>{opt.label}</div>
                <div className="text-[11px] text-[#9CA3AF] dark:text-[#71717a] mt-1">{opt.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="px-3 py-1.5 text-[12px] font-mono bg-[#22C55E] text-white rounded-md hover:bg-[#16A34A] disabled:opacity-50"
      >
        Submit
      </button>
    </div>
  )
}

function AgentMessageContent({ message }: { message: Message }) {
  const agentContent = message.agentContent
  const { isStreaming, currentAssistantMessageId } = useSessionStore()
  const isCurrentMessage = currentAssistantMessageId === message.id

  if (!agentContent) {
    return message.content ? <MarkdownRenderer content={message.content} /> : null
  }

  const { textBefore, toolCalls, textAfter, thinkingContent, todos, subagent, confirmation, question } = agentContent
  const hasContent = textBefore || toolCalls.length > 0 || textAfter || thinkingContent || todos.length > 0 || subagent || confirmation || question

  if (!hasContent && isCurrentMessage && isStreaming) {
    return (
      <div className="flex items-center gap-2 text-[#6B7280] dark:text-[#71717a]">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-[12px] font-mono">Thinking...</span>
      </div>
    )
  }

  const allToolsCompleted = toolCalls.length > 0 && toolCalls.every((tc) => tc.status === 'success' || tc.status === 'error')
  const showChangedFiles = allToolsCompleted && (!isCurrentMessage || !isStreaming)

  return (
    <div className="space-y-3">
      {thinkingContent && <ThinkingSection content={thinkingContent} />}
      {textBefore && <MarkdownRenderer content={textBefore} />}
      {todos.length > 0 && <TodoSection todos={todos} />}
      {subagent && <SubagentSection subagent={subagent} />}
      <ToolCallsList toolCalls={toolCalls} />
      {confirmation && <ConfirmationSection confirmation={confirmation} messageId={message.id} />}
      {question && <QuestionSection question={question} />}
      {showChangedFiles && <ChangedFilesSection toolCalls={toolCalls} />}
      {textAfter && <MarkdownRenderer content={textAfter} />}
    </div>
  )
}

export function ChatMessage({ message, showAvatar = true }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center p-2 w-full">
        <div className="text-xs text-[#6B7280] dark:text-[#71717a] bg-[#F3F4F6] dark:bg-[#18181b] px-3 py-1 rounded-full font-mono">
          {message.content}
        </div>
      </div>
    )
  }

  if (isUser) {
    const displayContent = extractUserContent(message.content)
    return (
      <div className="flex gap-4 justify-end p-4 w-full">
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
    <div className={cn('flex gap-4 justify-start w-full', showAvatar ? 'p-4' : 'px-4 pt-0 pb-3')}>
      {showAvatar ? <AIAvatar /> : <div className="w-8 shrink-0" />}
      <div className="overflow-hidden flex-1 min-w-0">
        <AgentMessageContent message={message} />
      </div>
    </div>
  )
}
