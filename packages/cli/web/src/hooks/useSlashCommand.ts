import { useCallback, useEffect, useMemo, useState } from 'react'

export interface CommandSuggestion {
  command: string
  description: string
  argumentHint?: string
  matchScore?: number
}

interface SlashCommandMatch {
  hasQuery: boolean
  query: string
  startIndex: number
  endIndex: number
}

interface UseSlashCommandResult extends SlashCommandMatch {
  suggestions: CommandSuggestion[]
  selectedIndex: number
  loading: boolean
  setSelectedIndex: (index: number) => void
  selectNext: () => void
  selectPrevious: () => void
}

const extractSlashCommand = (input: string, cursorPosition: number): SlashCommandMatch => {
  if (!input.startsWith('/')) {
    return { hasQuery: false, query: '', startIndex: -1, endIndex: -1 }
  }

  const spaceIndex = input.indexOf(' ')
  const commandEnd = spaceIndex === -1 ? input.length : spaceIndex

  if (cursorPosition <= commandEnd) {
    return {
      hasQuery: true,
      query: input.slice(1, cursorPosition),
      startIndex: 0,
      endIndex: cursorPosition,
    }
  }

  return { hasQuery: false, query: '', startIndex: -1, endIndex: -1 }
}

export const useSlashCommand = (
  input: string,
  cursorPosition: number | undefined,
  options: { debounceDelay?: number } = {}
): UseSlashCommandResult => {
  const { debounceDelay = 150 } = options

  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  const match = useMemo(() => {
    if (cursorPosition === undefined) {
      return { hasQuery: false, query: '', startIndex: -1, endIndex: -1 }
    }
    return extractSlashCommand(input, cursorPosition)
  }, [input, cursorPosition])

  useEffect(() => {
    if (!match.hasQuery) {
      setSuggestions([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    const fetchSuggestions = async () => {
      try {
        const response = await fetch(`/suggestions/commands?q=${encodeURIComponent(match.query)}`)
        if (!response.ok) throw new Error('Failed to fetch suggestions')
        const data = await response.json()
        if (!cancelled) {
          setSuggestions(data)
        }
      } catch (error) {
        console.error('Failed to fetch command suggestions:', error)
        if (!cancelled) {
          setSuggestions([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    const timer = setTimeout(fetchSuggestions, debounceDelay)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [match.hasQuery, match.query, debounceDelay])

  useEffect(() => {
    setSelectedIndex(0)
  }, [suggestions])

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => (prev + 1) % Math.max(suggestions.length, 1))
  }, [suggestions.length])

  const selectPrevious = useCallback(() => {
    setSelectedIndex((prev) => (prev - 1 + suggestions.length) % Math.max(suggestions.length, 1))
  }, [suggestions.length])

  return {
    ...match,
    suggestions,
    selectedIndex,
    loading,
    setSelectedIndex,
    selectNext,
    selectPrevious,
  }
}

export const applySlashCommandSuggestion = (
  input: string,
  match: SlashCommandMatch,
  suggestion: CommandSuggestion
): { newInput: string; newCursorPos: number } => {
  if (!match.hasQuery) {
    return { newInput: input, newCursorPos: input.length }
  }

  const after = input.slice(match.endIndex)
  const newInput = suggestion.command + ' ' + after.trimStart()
  const newCursorPos = suggestion.command.length + 1

  return { newInput, newCursorPos }
}
