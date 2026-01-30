import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { applyAtMentionSuggestion, useAtMention } from '@/hooks/useAtMention'
import { useInputHistory } from '@/hooks/useInputHistory'
import { applySlashCommandSuggestion, useSlashCommand } from '@/hooks/useSlashCommand'
import { PermissionModeEnum, useConfigStore, type PermissionMode } from '@/store/ConfigStore'
import { useSessionStore } from '@/store/session'
import { ChevronDown, Paperclip, Send, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SuggestionPopover } from './SuggestionPopover'

interface ChatInputProps {
  onSend: (message: string) => void
  onAbort?: () => void
  disabled?: boolean
  isStreaming?: boolean
}

const MODES: { value: PermissionMode; label: string }[] = [
  { value: PermissionModeEnum.DEFAULT, label: 'Default' },
  { value: PermissionModeEnum.AUTO_EDIT, label: 'Auto Edit' },
  { value: PermissionModeEnum.PLAN, label: 'Plan' },
  { value: PermissionModeEnum.SPEC, label: 'Spec' },
]

export function ChatInput({ onSend, onAbort, disabled, isStreaming }: ChatInputProps) {
  const [input, setInput] = useState("")
  const [cursorPosition, setCursorPosition] = useState<number | undefined>(undefined)
  const [modelOpen, setModelOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  
  const { currentModelId, configuredModels, loadModels, setCurrentModel, currentMode, setMode } = useConfigStore()
  const { setMaxContextTokens } = useSessionStore()

  const slashCommand = useSlashCommand(input, cursorPosition)
  const atMention = useAtMention(input, cursorPosition)
  const inputHistory = useInputHistory()

  const showSlashSuggestions = slashCommand.hasQuery && slashCommand.suggestions.length > 0
  const showAtSuggestions = atMention.hasQuery && atMention.suggestions.length > 0
  const showAnySuggestions = showSlashSuggestions || showAtSuggestions

  useEffect(() => {
    loadModels()
  }, [loadModels])

  useEffect(() => {
    if (configuredModels.length === 0) return
    const modelInfo = configuredModels.find(m => m.id === currentModelId)
    if (modelInfo) {
      const hasConfiguredTokens = !!modelInfo.maxContextTokens
      const maxTokens = modelInfo.maxContextTokens || 128000
      setMaxContextTokens(maxTokens, !hasConfiguredTokens)
    }
  }, [currentModelId, configuredModels, setMaxContextTokens])

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return
    inputHistory.addToHistory(input)
    onSend(input)
    setInput("")
    setCursorPosition(undefined)
  }, [input, disabled, onSend, inputHistory])

  const handleSlashSelect = useCallback((index: number) => {
    const suggestion = slashCommand.suggestions[index]
    if (!suggestion) return

    const { newInput, newCursorPos } = applySlashCommandSuggestion(
      input,
      slashCommand,
      suggestion
    )
    setInput(newInput)
    setCursorPosition(newCursorPos)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    })
  }, [input, slashCommand])

  const handleAtSelect = useCallback((index: number) => {
    const suggestion = atMention.suggestions[index]
    if (!suggestion) return

    const { newInput, newCursorPos } = applyAtMentionSuggestion(
      input,
      atMention,
      suggestion
    )
    setInput(newInput)
    setCursorPosition(newCursorPos)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    })
  }, [input, atMention])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSlashSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        slashCommand.selectNext()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        slashCommand.selectPrevious()
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        handleSlashSelect(slashCommand.selectedIndex)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCursorPosition(undefined)
        return
      }
    }

    if (showAtSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        atMention.selectNext()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        atMention.selectPrevious()
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        handleAtSelect(atMention.selectedIndex)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCursorPosition(undefined)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }

    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const textarea = e.target as HTMLTextAreaElement
      const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
      const isSingleLine = !input.includes('\n')
      
      if (isAtStart || isSingleLine) {
        const prev = inputHistory.getPrevious(input)
        if (prev !== null) {
          e.preventDefault()
          setInput(prev)
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.setSelectionRange(prev.length, prev.length)
            }
          })
        }
      }
      return
    }

    if (e.key === 'ArrowDown' && !e.shiftKey) {
      const textarea = e.target as HTMLTextAreaElement
      const isAtEnd = textarea.selectionStart === input.length && textarea.selectionEnd === input.length
      const isSingleLine = !input.includes('\n')
      
      if ((isAtEnd || isSingleLine) && inputHistory.historyIndex !== -1) {
        const next = inputHistory.getNext()
        if (next !== null) {
          e.preventDefault()
          setInput(next)
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.setSelectionRange(next.length, next.length)
            }
          })
        }
      }
    }
  }, [
    showSlashSuggestions,
    showAtSuggestions,
    slashCommand,
    atMention,
    handleSlashSelect,
    handleAtSelect,
    handleSend,
    input,
    inputHistory,
  ])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    setCursorPosition(e.target.selectionStart)
  }, [])

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement
    setCursorPosition(target.selectionStart)
  }, [])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'inherit'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [input])

  const currentModelInfo = configuredModels.find(m => m.id === currentModelId)
  const displayModelName = currentModelInfo?.model || currentModelId || 'Select Model'
  const currentModeLabel = MODES.find(m => m.value === currentMode)?.label || 'Default'

  return (
    <div className="py-4 border-t border-[#E5E7EB] dark:border-zinc-800 bg-white dark:bg-[#09090b]">
      <div className="px-4 w-full md:px-6">
        <div className="relative border border-[#E5E7EB] dark:border-zinc-800 rounded-lg shadow-sm bg-white dark:bg-zinc-950/50 focus-within:border-[#D1D5DB] dark:focus-within:border-zinc-600 focus-within:ring-1 focus-within:ring-[#D1D5DB] dark:focus-within:ring-zinc-600 transition-all duration-200 flex flex-col min-h-[88px]">
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
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onClick={handleSelect}
            placeholder="Type @ for files, / for commands..."
            className="flex-1 w-full resize-none border-0 bg-transparent py-4 px-4 focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none text-[#111827] dark:text-zinc-300 placeholder:text-[#9CA3AF] dark:placeholder:text-zinc-600"
            disabled={disabled || isStreaming}
          />
        
          <div className="flex justify-between items-center p-3 mt-auto">
            <div className="flex gap-2 items-center">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-[#9CA3AF] hover:text-[#111827] hover:bg-[#E5E7EB] dark:text-zinc-500 dark:hover:text-zinc-300 dark:hover:bg-zinc-800/50">
                <Paperclip className="w-4 h-4" />
              </Button>
                 
              <Popover open={modelOpen} onOpenChange={setModelOpen}>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#111827] px-2 py-1 rounded hover:bg-[#E5E7EB] dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/50 cursor-pointer transition-colors">
                    {displayModelName}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-2 bg-white dark:bg-zinc-900 border border-[#E5E7EB] dark:border-zinc-700" align="start">
                  <div className="overflow-y-auto max-h-72">
                    {configuredModels.length === 0 ? (
                      <div className="text-xs text-[#6B7280] dark:text-zinc-500 px-2 py-2">No models configured</div>
                    ) : (
                      Object.entries(
                        configuredModels.reduce((acc, model) => {
                          const provider = model.provider || 'unknown'
                          if (!acc[provider]) acc[provider] = []
                          acc[provider].push(model)
                          return acc
                        }, {} as Record<string, typeof configuredModels>)
                      ).map(([provider, models]) => (
                        <div key={provider} className="mb-2">
                          <div className="text-xs text-[#6B7280] dark:text-zinc-500 px-2 py-1 capitalize">{provider.replace(/-/g, ' ')}</div>
                          {models.map((model) => (
                            <button
                              key={model.id}
                              className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-[#E5E7EB] dark:hover:bg-zinc-800 transition-colors ${
                                model.id === currentModelId ? 'bg-[#E5E7EB] text-[#111827] dark:bg-zinc-800 dark:text-zinc-100' : 'text-[#6B7280] dark:text-zinc-400'
                              }`}
                              onClick={() => {
                                setCurrentModel(model.id)
                                setModelOpen(false)
                              }}
                            >
                              {model.model}
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
                <PopoverContent className="w-40 p-1 bg-white dark:bg-zinc-900 border border-[#E5E7EB] dark:border-zinc-700" align="start">
                  <div className="flex flex-col gap-0.5">
                    {MODES.map((mode) => (
                      <button
                        key={mode.value}
                        className={`w-full text-left px-2 py-1.5 text-xs rounded hover:bg-[#E5E7EB] dark:hover:bg-zinc-800 transition-colors ${
                          currentMode === mode.value ? 'bg-[#E5E7EB] text-[#111827] dark:bg-zinc-800 dark:text-zinc-100' : 'text-[#6B7280] dark:text-zinc-400'
                        }`}
                        onClick={() => {
                          setMode(mode.value)
                          setModeOpen(false)
                        }}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {isStreaming ? (
              <Button 
                size="icon" 
                onClick={onAbort}
                className="w-8 h-8 text-white bg-red-500 hover:bg-red-600"
              >
                <Square className="w-3 h-3" />
              </Button>
            ) : (
              <Button 
                size="icon" 
                onClick={handleSend} 
                disabled={!input.trim() || disabled || showAnySuggestions}
                className="h-8 w-8 bg-[#111827] text-white hover:bg-[#0F172A] disabled:bg-[#E5E7EB] disabled:text-[#9CA3AF] dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
              >
                <Send className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="text-center text-xs text-[#6B7280] dark:text-zinc-600 mt-3 font-mono">
          Blade can make mistakes. Please check important information.
        </div>
      </div>
    </div>
  )
}
