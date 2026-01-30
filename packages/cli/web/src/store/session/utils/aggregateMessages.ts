import type { Message as RawMessage } from '@/services'
import type { AgentResponseContent, Message, ToolCallInfo } from '../types'

const createEmptyAgentContent = (): AgentResponseContent => ({
  textBefore: '',
  toolCalls: [],
  textAfter: '',
  thinkingContent: '',
  todos: [],
  subagent: null,
  confirmation: null,
  question: null,
})

export function aggregateMessages(rawMessages: RawMessage[]): Message[] {
  const result: Message[] = []
  let currentAssistant: Message | null = null

  for (const raw of rawMessages) {
    if (raw.role === 'user' || raw.role === 'system') {
      if (currentAssistant) {
        result.push(currentAssistant)
        currentAssistant = null
      }
      result.push({
        id: raw.id,
        role: raw.role,
        content: raw.content,
        timestamp: raw.timestamp || Date.now(),
      })
    } else if (raw.role === 'assistant') {
      if (currentAssistant) {
        result.push(currentAssistant)
      }
      const agentContent = createEmptyAgentContent()
      agentContent.textBefore = raw.content || ''
      if (raw.thinkingContent) {
        agentContent.thinkingContent = raw.thinkingContent
      }
      
      if (raw.tool_calls && Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          const toolCall: ToolCallInfo = {
            toolCallId: tc.id || `tool-${Date.now()}`,
            toolName: tc.function?.name || 'Unknown',
            arguments: typeof tc.function?.arguments === 'string' 
              ? tc.function.arguments 
              : JSON.stringify(tc.function?.arguments || {}),
            status: 'success',
            startTime: Date.now(),
          }
          agentContent.toolCalls.push(toolCall)
        }
      }
      
      currentAssistant = {
        id: raw.id,
        role: 'assistant',
        content: raw.content || '',
        timestamp: raw.timestamp || Date.now(),
        agentContent,
      }
    } else if (raw.role === 'tool') {
      if (currentAssistant && currentAssistant.agentContent) {
        const rawAny = raw as Record<string, unknown>
        const metadata = raw.metadata as Record<string, unknown> | undefined
        const toolCallId = (rawAny.tool_call_id as string) || (metadata?.toolCallId as string)
        const toolName = (rawAny.name as string) || (metadata?.toolName as string) || 'Tool'
        
        const existingTool = currentAssistant.agentContent.toolCalls.find(
          (tc) => tc.toolCallId === toolCallId
        )
        
        if (existingTool) {
          existingTool.output = raw.content
          existingTool.status = 'success'
          if (!existingTool.toolName || existingTool.toolName === 'Unknown') {
            existingTool.toolName = toolName
          }
        } else {
          currentAssistant.agentContent.toolCalls.push({
            toolCallId: toolCallId || `tool-${Date.now()}-${Math.random()}`,
            toolName,
            output: raw.content,
            status: 'success',
            startTime: Date.now(),
          })
        }
      }
    }
  }

  if (currentAssistant) {
    result.push(currentAssistant)
  }

  return result
}
