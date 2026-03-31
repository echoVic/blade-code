import { create } from 'zustand';
import {
  createMessageSlice,
  createSessionSlice,
  createStreamingSlice,
  createUiSlice,
} from './slices';
import type { SessionStoreState } from './types';

export const useSessionStore = create<SessionStoreState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createMessageSlice(...a),
  ...createStreamingSlice(...a),
  ...createUiSlice(...a),
}));

export { TEMP_SESSION_ID } from './constants';
export type {
  AgentResponseContent,
  ConfirmationInfo,
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
  TodoItem,
  TokenUsage,
  ToolCallInfo,
} from './types';
