import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { registerMonacoTheme } from '@/lib/monacoTheme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/AppStore'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/SettingsStore'
import type { Monaco } from '@monaco-editor/react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'

type DiffData = {
  patch: string
  startLine?: number
  matchLine?: number
}

type FullDiffPayload = {
  diff: DiffData
  filePath?: string
  summary?: string
  oldContent?: string
  newContent?: string
}

type LogEntry = {
  id: string
  title: string
  subtitle?: string
  status?: 'success' | 'error' | 'running'
  content?: string
  timestamp?: number
}

type TreeNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

const MonacoDiffEditor = lazy(async () => {
  const module = await import('@monaco-editor/react')
  return { default: module.DiffEditor }
})

const MonacoEditorLazy = lazy(async () => {
  const module = await import('@monaco-editor/react')
  return { default: module.Editor }
})

export function FilePreview() {
  const { toggleFilePreview } = useAppStore()
  const { messages, currentSessionId } = useSessionStore()
  const [activeTab, setActiveTab] = useState<'diff' | 'files' | 'logs'>('diff')
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([])
  const [childrenCache, setChildrenCache] = useState<Record<string, TreeNode[]>>({})
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({})
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [filePreviewLoading, setFilePreviewLoading] = useState(false)
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null)
  const [filePreviewTruncated, setFilePreviewTruncated] = useState(false)

  const loadTreeNodes = async (dirPath: string = '') => {
    try {
      const url = dirPath ? `/suggestions/files/tree?path=${encodeURIComponent(dirPath)}` : '/suggestions/files/tree'
      const response = await fetch(url)
      if (!response.ok) throw new Error('Failed to load tree')
      const data = (await response.json()) as Array<{ name: string; path: string; type: 'dir' | 'file' }>
      return data.map((item) => ({ ...item, children: item.type === 'dir' ? [] : undefined }))
    } catch {
      return []
    }
  }

  useEffect(() => {
    let isMounted = true
    const loadRoot = async () => {
      setFileLoading(true)
      setFileError(null)
      try {
        const nodes = await loadTreeNodes()
        if (isMounted) setRootNodes(nodes)
      } catch (err) {
        if (isMounted) setFileError((err as Error).message)
      } finally {
        if (isMounted) setFileLoading(false)
      }
    }
    loadRoot()
    return () => { isMounted = false }
  }, [currentSessionId])

  useEffect(() => {
    setSelectedFile(null)
    setFileContent('')
    setFilePreviewError(null)
    setFilePreviewTruncated(false)
    setExpandedDirs({})
    setChildrenCache({})
  }, [currentSessionId])

  const allDiffs = useMemo(() => findAllDiffs(messages), [messages])
  const logs = useMemo(() => buildLogs(messages), [messages])
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({})

  const toggleDiffExpand = (filePath: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [filePath]: !prev[filePath] }))
  }

  const openFile = async (path: string) => {
    setSelectedFile(path)
    setFileContent('')
    setFilePreviewLoading(true)
    setFilePreviewError(null)
    setFilePreviewTruncated(false)
    try {
      const response = await fetch(`/suggestions/files/content?path=${encodeURIComponent(path)}`)
      if (!response.ok) {
        throw new Error('Failed to load file')
      }
      const data = (await response.json()) as { content: string; truncated?: boolean }
      setFileContent(data.content || '')
      setFilePreviewTruncated(Boolean(data.truncated))
    } catch (err) {
      setFilePreviewError((err as Error).message)
    } finally {
      setFilePreviewLoading(false)
    }
  }

  const toggleDir = async (dirPath: string) => {
    const isExpanding = !expandedDirs[dirPath]
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: isExpanding }))
    
    if (isExpanding && !childrenCache[dirPath]) {
      const children = await loadTreeNodes(dirPath)
      setChildrenCache((prev) => ({ ...prev, [dirPath]: children }))
    }
  }

  const toggleLog = (id: string) => {
    setExpandedLogs((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div className="w-[55%] min-w-[420px] max-w-[860px] border-l border-[#E5E7EB] dark:border-zinc-800 bg-white dark:bg-[#09090b] flex flex-col h-full shadow-xl shrink-0">
      <div className="flex items-center justify-between px-4 h-12 border-b border-[#E5E7EB] dark:border-zinc-800 shrink-0">
        <span className="font-normal text-[13px] text-[#6B7280] dark:text-zinc-400 font-mono">Preview</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleFilePreview}
          className="h-8 w-8 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB]/60 dark:text-zinc-500 dark:hover:text-zinc-300 dark:hover:bg-zinc-800/50"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value: string) => setActiveTab(value as typeof activeTab)}
        className="flex flex-col flex-1 min-h-0"
      >
        <div className="px-4 py-3 border-b border-[#E5E7EB] dark:border-zinc-800">
          <TabsList className="bg-white dark:bg-[#111113] border border-[#E5E7EB] dark:border-[#27272a] h-9 p-1 rounded-md w-full justify-start">
            <TabsTrigger
              value="diff"
              className="text-[12px] font-mono px-3 text-[#6B7280] dark:text-[#a1a1aa] data-[state=active]:bg-[#E5E7EB] data-[state=active]:text-[#111827] dark:data-[state=active]:bg-[#27272a] dark:data-[state=active]:text-white"
            >
              Diff
            </TabsTrigger>
            <TabsTrigger
              value="files"
              className="text-[12px] font-mono px-3 text-[#6B7280] dark:text-[#a1a1aa] data-[state=active]:bg-[#E5E7EB] data-[state=active]:text-[#111827] dark:data-[state=active]:bg-[#27272a] dark:data-[state=active]:text-white"
            >
              Files
            </TabsTrigger>
            <TabsTrigger
              value="logs"
              className="text-[12px] font-mono px-3 text-[#6B7280] dark:text-[#a1a1aa] data-[state=active]:bg-[#E5E7EB] data-[state=active]:text-[#111827] dark:data-[state=active]:bg-[#27272a] dark:data-[state=active]:text-white"
            >
              Logs
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="diff" className="overflow-hidden flex-1 mt-0">
          <div className="overflow-y-auto px-4 py-4 space-y-3 h-full">
            {allDiffs.length === 0 ? (
              <EmptyState title="No patch yet" subtitle="Run a tool that changes files to see diffs here." />
            ) : (
              <>
                <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono mb-2">
                  {allDiffs.length} changed file{allDiffs.length > 1 ? 's' : ''}
                </div>
                {allDiffs.map((diffItem) => {
                  const fileName = diffItem.filePath?.split('/').pop() || 'unknown'
                  const isExpanded = expandedDiffs[diffItem.filePath || ''] !== false
                  return (
                    <div
                      key={diffItem.filePath}
                      className="border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden"
                    >
                      <button
                        onClick={() => toggleDiffExpand(diffItem.filePath || '')}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-[#F9FAFB] dark:bg-[#111113] hover:bg-[#F3F4F6] dark:hover:bg-[#18181b] transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-[#6B7280] dark:text-[#71717a]" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-[#6B7280] dark:text-[#71717a]" />
                        )}
                        <FileText className="w-4 h-4 text-[#6B7280] dark:text-[#71717a]" />
                        <span className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono flex-1 text-left truncate">
                          {fileName}
                        </span>
                        {diffItem.summary && (
                          <span className="text-[11px] text-[#6B7280] dark:text-[#a1a1aa] font-mono">
                            {diffItem.summary}
                          </span>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-[#E5E7EB] dark:border-[#27272a]">
                          <div className="px-3 py-1 text-[11px] text-[#9CA3AF] dark:text-[#52525b] font-mono truncate">
                            {diffItem.filePath}
                          </div>
                          <DiffViewer diff={diffItem.diff} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="files" className="overflow-hidden flex-1 mt-0">
          <div className="px-4 py-4 h-full">
            {fileLoading && <EmptyState title="Loading files…" subtitle="Fetching workspace tree." />}
            {!fileLoading && fileError && (
              <EmptyState title="Failed to load files" subtitle={fileError} />
            )}
            {!fileLoading && !fileError && rootNodes.length === 0 && (
              <EmptyState title="No files yet" subtitle="Start a session to load the workspace tree." />
            )}
            {!fileLoading && !fileError && rootNodes.length > 0 && (
              <div className="h-full grid grid-cols-[220px_1fr] gap-4 min-h-0">
                <div className="border border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-2 overflow-y-auto min-h-0">
                  {rootNodes.map((node) => (
                    <LazyTreeNode
                      key={node.path}
                      node={node}
                      depth={0}
                      expandedDirs={expandedDirs}
                      childrenCache={childrenCache}
                      toggleDir={toggleDir}
                      selectedPath={selectedFile}
                      onSelectFile={openFile}
                    />
                  ))}
                </div>
                <div className="border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden flex flex-col min-h-0">
                  <div className="px-3 py-2 bg-[#F9FAFB] dark:bg-[#111113] border-b border-[#E5E7EB] dark:border-[#27272a] text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono flex items-center justify-between">
                    <span>{selectedFile || 'Select a file to preview'}</span>
                    {selectedFile && (
                      <span className="text-[11px] text-[#9CA3AF] dark:text-[#a1a1aa] font-mono">
                        {filePreviewLoading ? 'Loading…' : filePreviewTruncated ? 'Truncated' : 'Ready'}
                      </span>
                    )}
                  </div>
                  {filePreviewTruncated && !filePreviewLoading && (
                    <div className="px-3 py-2 bg-[#FEF3C7] dark:bg-[#111113] border-b border-[#E5E7EB] dark:border-[#27272a] text-[11px] text-[#b45309] dark:text-[#facc15] font-mono">
                      Preview truncated to 200k characters.
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    {!selectedFile && (
                      <div className="h-full flex items-center justify-center text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
                        Pick a file from the tree to preview.
                      </div>
                    )}
                    {selectedFile && filePreviewError && (
                      <div className="h-full flex items-center justify-center text-[12px] text-[#DC2626] dark:text-[#fca5a5] font-mono">
                        {filePreviewError}
                      </div>
                    )}
                    {selectedFile && !filePreviewError && (
                      <div className="h-full">
                        {filePreviewLoading ? (
                          <MonacoFallback />
                        ) : (
                          <Suspense fallback={<MonacoFallback />}>
                            <MonacoEditorView
                              content={fileContent}
                              filename={selectedFile}
                            />
                          </Suspense>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="logs" className="overflow-hidden flex-1 mt-0">
          <div className="overflow-y-auto px-4 py-4 space-y-3 h-full">
            {logs.length === 0 ? (
              <EmptyState title="No logs yet" subtitle="Tool runs will appear here." />
            ) : (
              logs.map((log) => {
                const isExpanded = expandedLogs[log.id]
                const contentLines = (log.content || '').split('\n')
                const isLong = contentLines.length > 10 || (log.content?.length || 0) > 800
                const visible = isExpanded || !isLong ? contentLines : contentLines.slice(0, 8)
                return (
                  <div key={log.id} className="border border-[#E5E7EB] dark:border-[#27272a] rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-[#F9FAFB] dark:bg-[#111113] border-b border-[#E5E7EB] dark:border-[#27272a]">
                      <div className="space-y-0.5">
                        <div className="text-[12px] text-[#111827] dark:text-[#E5E5E5] font-mono">{log.title}</div>
                        {log.subtitle && (
                          <div className="text-[11px] text-[#6B7280] dark:text-[#71717a] font-mono">{log.subtitle}</div>
                        )}
                      </div>
                      <StatusPill status={log.status} />
                    </div>
                    {log.content && (
                      <div className="px-3 py-3 space-y-2">
                        <pre className="text-[12px] text-[#374151] dark:text-[#d4d4d8] bg-[#F3F4F6] dark:bg-[#09090b] border border-[#E5E7EB] dark:border-[#27272a] rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono">
                          {visible.join('\n')}
                          {!isExpanded && isLong && '\n…'}
                        </pre>
                        {isLong && (
                          <button
                            onClick={() => toggleLog(log.id)}
                            className="flex items-center gap-1 text-[12px] text-[#6B7280] dark:text-[#a1a1aa] font-mono hover:text-[#111827] dark:hover:text-[#E5E5E5] transition-colors"
                          >
                            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            {isExpanded ? 'Collapse' : 'Expand'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border border-dashed border-[#E5E7EB] dark:border-[#27272a] rounded-lg p-6 text-center">
      <div className="text-[13px] text-[#111827] dark:text-[#E5E5E5] font-mono">{title}</div>
      <div className="text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono mt-1">{subtitle}</div>
    </div>
  )
}

function StatusPill({ status }: { status?: 'success' | 'error' | 'running' }) {
  const label = status === 'success' ? 'Success' : status === 'error' ? 'Failed' : 'Running'
  const className = status === 'success'
    ? 'bg-[#22C55E] text-white'
    : status === 'error'
      ? 'bg-[#FEE2E2] text-[#b91c1c] dark:bg-[#EF4444]/20 dark:text-[#fca5a5]'
      : 'bg-[#E5E7EB] text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]'
  return (
    <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-mono', className)}>{label}</span>
  )
}

function LazyTreeNode({
  node,
  depth,
  expandedDirs,
  childrenCache,
  toggleDir,
  onSelectFile,
  selectedPath,
}: {
  node: TreeNode
  depth: number
  expandedDirs: Record<string, boolean>
  childrenCache: Record<string, TreeNode[]>
  toggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  selectedPath: string | null
}) {
  const isDir = node.type === 'dir'
  const isExpanded = expandedDirs[node.path]
  const isSelected = !isDir && selectedPath === node.path
  const children = childrenCache[node.path] || []

  return (
    <div>
      <button
        onClick={() => {
          if (isDir) {
            toggleDir(node.path)
          } else {
            onSelectFile(node.path)
          }
        }}
        className={cn(
          'flex items-center gap-2 w-full text-left text-[12px] font-mono px-2 py-1 rounded-md transition-colors',
          isSelected
            ? 'bg-[#16A34A]/10 text-[#111827] dark:bg-[#22C55E]/10 dark:text-[#E5E5E5]'
            : 'hover:bg-[#F3F4F6] text-[#6B7280] dark:hover:bg-[#111113] dark:text-[#a1a1aa]',
          isDir && 'cursor-pointer',
          isSelected && 'border border-[#16A34A]/30 dark:border-[#22C55E]/30'
        )}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {isDir ? (
          <>
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#111827] dark:text-[#E5E5E5]" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[#6B7280] dark:text-[#a1a1aa]" />
            )}
            <span className="text-[#111827] dark:text-[#E5E5E5] truncate">{node.name}</span>
          </>
        ) : (
          <>
            <FileText className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF] dark:text-[#71717a]" />
            <span className="text-[#111827] dark:text-[#E5E5E5] truncate">{node.name}</span>
          </>
        )}
      </button>
      {isDir && isExpanded && (
        <div>
          {children.map((child) => (
            <LazyTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              childrenCache={childrenCache}
              toggleDir={toggleDir}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  )
}



function buildLogs(
  messages: Array<{
    id: string
    metadata?: Record<string, unknown>
    timestamp?: number
    agentContent?: {
      toolCalls?: Array<{
        toolCallId: string
        toolName: string
        arguments?: string
        toolKind?: string
        status: string
        summary?: string
        output?: string
      }>
    }
  }>
): LogEntry[] {
  return messages.flatMap((message) => {
    const logs: LogEntry[] = []

    if (message.agentContent?.toolCalls) {
      for (const toolCall of message.agentContent.toolCalls) {
        const args = formatArguments(toolCall.arguments)
        const output = toolCall.output
        const cleaned = output ? (extractDiffBlock(output)?.diff ? removeDiffBlock(output) : output) : undefined

        logs.push({
          id: `${message.id}-${toolCall.toolCallId}`,
          title: toolCall.toolName || 'Tool',
          subtitle: toolCall.summary,
          status: toolCall.status === 'success' ? 'success' : toolCall.status === 'error' ? 'error' : 'running',
          content: cleaned || (args ? `Arguments:\n${args}` : undefined),
          timestamp: message.timestamp,
        })
      }
    }

    const meta = message.metadata as Record<string, unknown> | undefined
    if (meta) {
      if (meta.kind === 'tool_call') {
        const toolName = (meta.toolName as string) || 'Tool'
        const args = formatArguments(meta.arguments as string | Record<string, unknown> | undefined)
        logs.push({
          id: message.id,
          title: `Tool Call · ${toolName}`,
          subtitle: meta.toolKind ? String(meta.toolKind) : undefined,
          status: meta.status === 'success' ? 'success' : meta.status === 'error' ? 'error' : 'running',
          content: args ? `Arguments:\n${args}` : undefined,
          timestamp: message.timestamp,
        })
      }
      if (meta.kind === 'tool_result') {
        const toolName = (meta.toolName as string) || 'Tool'
        const success = meta.success as boolean | undefined
        const summary = meta.summary as string | undefined
        const output = meta.output as string | undefined
        const cleaned = output ? (extractDiffBlock(output)?.diff ? removeDiffBlock(output) : output) : undefined
        logs.push({
          id: message.id,
          title: `Tool Result · ${toolName}`,
          subtitle: summary,
          status: success === undefined ? 'running' : success ? 'success' : 'error',
          content: cleaned,
          timestamp: message.timestamp,
        })
      }
    }

    return logs
  })
}

function findAllDiffs(
  messages: Array<{
    metadata?: Record<string, unknown>
    content?: string
    agentContent?: { toolCalls?: Array<{ output?: string; metadata?: Record<string, unknown>; toolName?: string; summary?: string; toolCallId?: string }> }
  }>
): FullDiffPayload[] {
  const diffs: FullDiffPayload[] = []
  const seenFiles = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (message.agentContent?.toolCalls) {
      for (let j = message.agentContent.toolCalls.length - 1; j >= 0; j -= 1) {
        const toolCall = message.agentContent.toolCalls[j]
        const toolMeta = toolCall.metadata
        const output = toolCall.output || ''
        const diffCandidate = extractDiffBlock(output) || extractDiffBlock((toolMeta?.diff_snippet as string) || '')
        if (diffCandidate?.diff) {
          const filePath = (toolMeta?.file_path as string) || toolCall.toolName || 'unknown'
          if (!seenFiles.has(filePath)) {
            seenFiles.add(filePath)
            const oldContent = typeof toolMeta?.oldContent === 'string' ? toolMeta.oldContent : undefined
            const newContent = typeof toolMeta?.newContent === 'string' ? toolMeta.newContent : undefined
            diffs.push({
              diff: diffCandidate.diff,
              filePath,
              summary: toolCall.summary,
              oldContent,
              newContent,
            })
          }
        }
      }
    }

    const meta = message.metadata as Record<string, unknown> | undefined
    if (!meta || meta.kind !== 'tool_result') continue
    const toolMeta = meta.metadata as Record<string, unknown> | undefined
    const output = (meta.output as string) || message.content || ''
    const diffCandidate = extractDiffBlock(output) || extractDiffBlock((toolMeta?.diff_snippet as string) || '')
    if (diffCandidate?.diff) {
      const filePath = (toolMeta?.file_path as string) || (meta.toolName as string) || 'unknown'
      if (!seenFiles.has(filePath)) {
        seenFiles.add(filePath)
        const oldContent = typeof toolMeta?.oldContent === 'string' ? (toolMeta.oldContent as string) : undefined
        const newContent = typeof toolMeta?.newContent === 'string' ? (toolMeta.newContent as string) : undefined
        diffs.push({
          diff: diffCandidate.diff,
          filePath,
          summary: meta.summary as string | undefined,
          oldContent,
          newContent,
        })
      }
    }
  }
  return diffs.reverse()
}

function extractDiffBlock(output: string): { diff?: DiffData } | null {
  if (!output) return null
  const regex = /<<<DIFF>>>\s*([\s\S]*?)\s*<<<\/DIFF>>>/m
  const match = output.match(regex)
  if (!match) return null
  try {
    const diff = JSON.parse(match[1]) as DiffData
    return { diff }
  } catch {
    return null
  }
}

function removeDiffBlock(output: string): string {
  if (!output) return ''
  return output.replace(/<<<DIFF>>>[\s\S]*?<<<\/DIFF>>>/m, '').trim()
}

function formatArguments(args?: string | Record<string, unknown>): string {
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

function MonacoFallback() {
  return (
    <div className="h-full flex items-center justify-center text-[12px] text-[#6B7280] dark:text-[#71717a] font-mono">
      Loading editor…
    </div>
  )
}

function MonacoEditorView({ content, filename }: { content: string; filename: string }) {
  const { theme } = useSettingsStore()
  const monacoRef = useRef<Monaco | null>(null)
  const [monacoTheme, setMonacoTheme] = useState('vs-dark')
  const language = getLanguageFromFilename(filename)

  const handleEditorWillMount = (monaco: Monaco) => {
    monacoRef.current = monaco
    const registeredTheme = registerMonacoTheme(monaco, theme)
    setMonacoTheme(registeredTheme)
  }

  useEffect(() => {
    if (monacoRef.current) {
      const registeredTheme = registerMonacoTheme(monacoRef.current, theme)
      setMonacoTheme(registeredTheme)
    }
  }, [theme])

  return (
    <MonacoEditorLazy
      key={filename}
      value={content}
      language={language}
      theme={monacoTheme}
      height="100%"
      beforeMount={handleEditorWillMount}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  )
}

function _MonacoDiffView({ original, modified }: { original: string; modified: string }) {
  const { theme } = useSettingsStore()
  const monacoRef = useRef<Monaco | null>(null)
  const [monacoTheme, setMonacoTheme] = useState('vs-dark')

  const handleEditorWillMount = (monaco: Monaco) => {
    monacoRef.current = monaco
    const registeredTheme = registerMonacoTheme(monaco, theme)
    setMonacoTheme(registeredTheme)
  }

  useEffect(() => {
    if (monacoRef.current) {
      const registeredTheme = registerMonacoTheme(monacoRef.current, theme)
      setMonacoTheme(registeredTheme)
    }
  }, [theme])

  return (
    <MonacoDiffEditor
      key={`${original.length}-${modified.length}`}
      original={original}
      modified={modified}
      theme={monacoTheme}
      height="100%"
      beforeMount={handleEditorWillMount}
      options={{
        readOnly: true,
        renderSideBySide: false,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  )
}

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    go: 'go',
    rs: 'rust',
    py: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    sh: 'shell',
    zsh: 'shell',
    toml: 'toml',
    xml: 'xml',
  }
  return map[ext] || 'plaintext'
}

function DiffViewer({ diff }: { diff: DiffData }) {
  const lines = diff.patch.split('\n')
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
            return <DiffLine key={`${line}-${index}`} line={line} />
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
