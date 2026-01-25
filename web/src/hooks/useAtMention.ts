import { useCallback, useEffect, useMemo, useState } from 'react'

interface AtMentionMatch {
  hasQuery: boolean
  query: string
  startIndex: number
  endIndex: number
  quoted: boolean
}

interface UseAtMentionResult extends AtMentionMatch {
  suggestions: string[]
  selectedIndex: number
  loading: boolean
  setSelectedIndex: (index: number) => void
  selectNext: () => void
  selectPrevious: () => void
}

const extractAtMention = (input: string, cursorPosition: number): AtMentionMatch => {
  const atMatches = [...input.matchAll(/(?:^|\s)(@(?:"[^"]*"|(?:[^\\ ]|\\ )*))/g)]

  for (const match of atMatches) {
    const fullMatch = match[1]
    const matchStart = match.index! + (match[0].length - fullMatch.length)
    const matchEnd = matchStart + fullMatch.length

    if (cursorPosition >= matchStart && cursorPosition <= matchEnd) {
      let query = fullMatch.slice(1)
      let quoted = false

      if (query.startsWith('"')) {
        quoted = true
        query = query.slice(1)
        if (query.endsWith('"')) {
          query = query.slice(0, -1)
        }
      }

      return {
        hasQuery: true,
        query,
        startIndex: matchStart,
        endIndex: matchEnd,
        quoted,
      }
    }
  }

  return {
    hasQuery: false,
    query: '',
    startIndex: -1,
    endIndex: -1,
    quoted: false,
  }
}

export const useAtMention = (
  input: string,
  cursorPosition: number | undefined,
  options: { debounceDelay?: number; maxSuggestions?: number } = {}
): UseAtMentionResult => {
  const { debounceDelay = 200, maxSuggestions = 15 } = options

  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  const match = useMemo(() => {
    if (cursorPosition === undefined) {
      return { hasQuery: false, query: '', startIndex: -1, endIndex: -1, quoted: false }
    }
    return extractAtMention(input, cursorPosition)
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
        const response = await fetch(
          `/suggestions/files?q=${encodeURIComponent(match.query)}&limit=${maxSuggestions}`
        )
        if (!response.ok) throw new Error('Failed to fetch suggestions')
        const data = await response.json()
        if (!cancelled) {
          setSuggestions(data)
        }
      } catch (error) {
        console.error('Failed to fetch file suggestions:', error)
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
  }, [match.hasQuery, match.query, debounceDelay, maxSuggestions])

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

const formatSuggestion = (suggestion: string, quoted: boolean = false): string => {
  if (suggestion.includes(' ') || quoted) {
    return `@"${suggestion}"`
  }
  return `@${suggestion}`
}

export const applyAtMentionSuggestion = (
  input: string,
  match: AtMentionMatch,
  suggestion: string
): { newInput: string; newCursorPos: number } => {
  if (!match.hasQuery) {
    return { newInput: input, newCursorPos: input.length }
  }

  const formatted = formatSuggestion(suggestion, match.quoted)
  const before = input.slice(0, match.startIndex)
  const after = input.slice(match.endIndex)
  const newInput = before + formatted + ' ' + after
  const newCursorPos = match.startIndex + formatted.length + 1

  return { newInput, newCursorPos }
}
