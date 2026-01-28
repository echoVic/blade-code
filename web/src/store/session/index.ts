import { create } from 'zustand'
import {
  createMessageSlice,
  createSessionSlice,
  createStreamingSlice,
  createToolSlice,
  createUiSlice,
} from './slices'
import type { SessionStoreState } from './types'

export const useSessionStore = create<SessionStoreState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createStreamingSlice(...a),
  ...createToolSlice(...a),
  ...createUiSlice(...a),
}))

export type {
  Message,
  PermissionMode,
  Session,
  SessionSlice,
  SessionStoreState,
  StreamEvent,
  SubagentProgress,
  TodoItem,
  TokenUsage,
  ToolBatch,
  ToolCallItem,
} from './types'

export { TEMP_SESSION_ID } from './constants'
