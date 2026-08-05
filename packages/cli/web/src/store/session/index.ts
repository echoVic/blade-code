import { create } from 'zustand';
import {
  createMessageSlice,
  createSessionSlice,
  createStreamingSlice,
  createTaskListSlice,
  createUiSlice,
} from './slices';
import type { SessionStoreState } from './types';

export const useSessionStore = create<SessionStoreState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createTaskListSlice(...a),
  ...createMessageSlice(...a),
  ...createStreamingSlice(...a),
  ...createUiSlice(...a),
}));

export { TEMP_SESSION_ID } from './constants';
export type {
  AgentResponseContent,
  ConfirmationInfo,
  Goal,
  ImageAttachmentInput,
  Message,
  MessageContent,
  MessageContentPart,
  PermissionMode,
  QuestionInfo,
  SendMessagePayload,
  Session,
  SessionSlice,
  SessionStoreState,
  StreamEvent,
  SubagentProgress,
  TaskItem,
  TaskListSlice,
  TokenUsage,
  ToolCallInfo,
} from './types';
