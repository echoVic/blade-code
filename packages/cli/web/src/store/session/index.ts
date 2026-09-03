import { create } from 'zustand';
import {
  createHistorySurfaceSlice,
  createMessageSlice,
  createSessionSlice,
  createStreamingSlice,
  createTaskListSlice,
  createUiSlice,
} from './slices';
import type { SessionStoreState } from './types';

export const useSessionStore = create<SessionStoreState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createHistorySurfaceSlice(...a),
  ...createTaskListSlice(...a),
  ...createMessageSlice(...a),
  ...createStreamingSlice(...a),
  ...createUiSlice(...a),
}));

export { TEMP_SESSION_ID } from './constants';
export type {
  AgentResponseContent,
  AgentTimelineBlock,
  BoundProject,
  CatalogLoadState,
  ConfirmationInfo,
  Goal,
  HistorySurfaceError,
  HistorySurfaceLoadState,
  HistorySurfaceSlice,
  ImageAttachmentInput,
  Message,
  MessageContent,
  MessageContentPart,
  PermissionMode,
  QuestionInfo,
  SendMessagePayload,
  Session,
  SessionErrorContext,
  SessionErrorKind,
  SessionSlice,
  SessionStoreState,
  SessionSurfaceSelection,
  StreamEvent,
  SubagentProgress,
  TaskItem,
  TaskListSlice,
  TokenUsage,
  ToolCallInfo,
} from './types';
