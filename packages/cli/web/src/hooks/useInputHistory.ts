import { useCallback, useRef, useState } from 'react'

export function useInputHistory() {
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const savedInput = useRef<string>('')

  const addToHistory = useCallback((input: string) => {
    if (!input.trim()) return
    setHistory((prev) => {
      if (prev[prev.length - 1] === input) return prev
      return [...prev, input]
    })
    setHistoryIndex(-1)
    savedInput.current = ''
  }, [])

  const getPrevious = useCallback((currentInput: string): string | null => {
    if (history.length === 0) return null

    if (historyIndex === -1) {
      savedInput.current = currentInput
    }

    const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1)
    setHistoryIndex(newIndex)
    return history[newIndex] ?? null
  }, [history, historyIndex])

  const getNext = useCallback((): string | null => {
    if (historyIndex === -1) return null

    const newIndex = historyIndex + 1
    if (newIndex >= history.length) {
      setHistoryIndex(-1)
      return savedInput.current
    }
    
    setHistoryIndex(newIndex)
    return history[newIndex] ?? null
  }, [history, historyIndex])

  const reset = useCallback(() => {
    setHistoryIndex(-1)
    savedInput.current = ''
  }, [])

  return {
    addToHistory,
    getPrevious,
    getNext,
    reset,
    historyIndex,
  }
}
