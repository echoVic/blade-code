import { isReadOnlyTool, toolToBatchMap } from '../constants'
import type { Message, SliceCreator, ToolBatch, ToolCallItem, ToolSlice } from '../types'

export const createToolSlice: SliceCreator<ToolSlice> = (set, get) => ({
  currentToolBatch: null,
  toolBatchAggregationEnabled: true,

  handleToolStart: (props) => {
    const { toolCallId, toolName, arguments: args, toolKind } = props
    const { toolBatchAggregationEnabled, currentToolBatch, messages } = get()
    const now = Date.now()
    const shouldAggregate = toolBatchAggregationEnabled && toolName && isReadOnlyTool(toolName)

    if (shouldAggregate) {
      const newTool: ToolCallItem = {
        toolCallId: toolCallId || `tool-${now}`,
        toolName: toolName || 'Unknown',
        arguments: args,
        toolKind,
        status: 'running',
        startTime: now,
      }

      const actualToolCallId = toolCallId || `tool-${now}`

      if (currentToolBatch) {
        toolToBatchMap.set(actualToolCallId, currentToolBatch.id)

        set((state) => {
          if (!state.currentToolBatch) return state
          const updatedBatch = {
            ...state.currentToolBatch,
            tools: [...state.currentToolBatch.tools, newTool],
          }
          const batchMsgId = `tool-batch-${state.currentToolBatch.id}`
          const updatedMessages = state.messages.map((m) => {
            if (m.id === batchMsgId && m.metadata?.kind === 'tool_batch') {
              return {
                ...m,
                metadata: { ...m.metadata, tools: updatedBatch.tools },
              }
            }
            return m
          })
          return { currentToolBatch: updatedBatch, messages: updatedMessages }
        })
      } else {
        const batchId = `batch-${now}`
        toolToBatchMap.set(actualToolCallId, batchId)

        const newBatch: ToolBatch = {
          id: batchId,
          tools: [newTool],
          startTime: now,
          isComplete: false,
        }

        const batchMessage: Message = {
          id: `tool-batch-${batchId}`,
          role: 'assistant',
          content: '',
          timestamp: now,
          metadata: {
            kind: 'tool_batch',
            batchId,
            tools: [newTool],
            isComplete: false,
          },
        }

        set({ currentToolBatch: newBatch, messages: [...messages, batchMessage] })
      }
    } else {
      if (currentToolBatch) {
        set({ currentToolBatch: null })
      }

      const messageId = toolCallId ? `tool-call-${toolCallId}` : `tool-call-${now}`
      const message: Message = {
        id: messageId,
        role: 'assistant',
        content: '',
        timestamp: now,
        metadata: {
          kind: 'tool_call',
          toolCallId,
          toolName,
          arguments: args,
          toolKind,
          status: 'running',
        },
      }
      set({ messages: [...messages, message] })
    }
  },

  handleToolResult: (props) => {
    const { toolCallId, toolName, success, output, summary, metadata } = props
    const batchId = toolCallId ? toolToBatchMap.get(toolCallId) : undefined
    const now = Date.now()

    if (batchId) {
      set((state) => {
        const batchMsgId = `tool-batch-${batchId}`

        const updatedMessages = state.messages.map((m) => {
          if (m.id === batchMsgId && m.metadata?.kind === 'tool_batch') {
            const tools = (m.metadata.tools as ToolCallItem[]) || []
            const updatedTools = tools.map((tool): ToolCallItem => {
              if (tool.toolCallId === toolCallId) {
                return { ...tool, status: success ? 'success' : 'error', summary, output }
              }
              return tool
            })
            const allComplete = updatedTools.every((t) => t.status !== 'running')
            return {
              ...m,
              metadata: { ...m.metadata, tools: updatedTools, isComplete: allComplete },
            }
          }
          return m
        })

        if (state.currentToolBatch?.id === batchId) {
          const updatedTools = state.currentToolBatch.tools.map((tool): ToolCallItem => {
            if (tool.toolCallId === toolCallId) {
              return { ...tool, status: success ? 'success' : 'error', summary, output }
            }
            return tool
          })
          const allComplete = updatedTools.every((t) => t.status !== 'running')
          return {
            currentToolBatch: allComplete
              ? null
              : { ...state.currentToolBatch, tools: updatedTools, isComplete: allComplete },
            messages: updatedMessages,
          }
        }

        return { messages: updatedMessages }
      })
    } else if (toolCallId) {
      set((state) => {
        const hasToolCall = state.messages.some(
          (m) => m.metadata?.kind === 'tool_call' && m.metadata.toolCallId === toolCallId
        )

        if (hasToolCall) {
          return {
            messages: state.messages.map((m) => {
              if (m.metadata?.kind === 'tool_call' && m.metadata.toolCallId === toolCallId) {
                return {
                  ...m,
                  metadata: { ...m.metadata, status: success ? 'success' : 'error', summary, output },
                }
              }
              return m
            }),
          }
        }

        const resultMessage: Message = {
          id: `tool-result-${toolCallId}`,
          role: 'assistant',
          content: output || '',
          timestamp: now,
          metadata: {
            kind: 'tool_result',
            toolCallId,
            toolName,
            success,
            summary,
            output,
            metadata,
          },
        }
        return { messages: [...state.messages, resultMessage] }
      })
    }
  },

  setToolBatchAggregation: (enabled) => set({ toolBatchAggregationEnabled: enabled }),

  clearToolBatch: () => set({ currentToolBatch: null }),
})
