/**
 * API Schemas 测试
 */

import { describe, expect, it } from 'vitest';
import {
  type BusEvent,
  BusEventSchema,
  type EditorTheme,
  EditorThemeSchema,
  ForkSessionResponseSchema,
  type GeneralSettings,
  GeneralSettingsSchema,
  type GeneralSettingsUpdate,
  GeneralSettingsUpdateSchema,
  type Message,
  MessageSchema,
  type ModelConfig,
  ModelConfigSchema,
  type PermissionMode,
  PermissionModeEnum,
  PermissionModeSchema,
  type PermissionResponse,
  PermissionResponseSchema,
  ResumeSubagentRequestSchema,
  ResumeSubagentResponseSchema,
  type SendMessageRequest,
  SendMessageRequestSchema,
  type SendMessageResponse,
  SendMessageResponseSchema,
  type Session,
  SessionHistoryMessageSchema,
  SessionRefSchema,
  SessionRewindCheckpointSchema,
  SessionRewindRequestSchema,
  SessionRewindResponseSchema,
  SessionSchema,
  type UiTheme,
  UiThemeSchema,
} from '../../../../src/api/schemas.js';

describe('API Schemas', () => {
  describe('PermissionModeSchema', () => {
    it('应该验证有效的权限模式', () => {
      const validModes: PermissionMode[] = ['default', 'autoEdit', 'yolo', 'plan'];

      validModes.forEach((mode) => {
        expect(() => PermissionModeSchema.parse(mode)).not.toThrow();
      });
    });

    it('应该拒绝无效的权限模式', () => {
      expect(() => PermissionModeSchema.parse('invalid')).toThrow();
      expect(() => PermissionModeSchema.parse('AUTO_EDIT')).toThrow();
      expect(() => PermissionModeSchema.parse('')).toThrow();
    });
  });

  describe('PermissionModeEnum', () => {
    it('应该定义所有权限模式常量', () => {
      expect(PermissionModeEnum.DEFAULT).toBe('default');
      expect(PermissionModeEnum.AUTO_EDIT).toBe('autoEdit');
      expect(PermissionModeEnum.YOLO).toBe('yolo');
      expect(PermissionModeEnum.PLAN).toBe('plan');
    });
  });

  describe('MessageSchema', () => {
    it('应该验证有效的消息', () => {
      const validMessage: Message = {
        id: 'msg-123',
        role: 'user',
        content: 'Hello, world!',
        timestamp: Date.now(),
        metadata: { key: 'value' },
      };

      expect(() => MessageSchema.parse(validMessage)).not.toThrow();
    });

    it('应该验证带有思考内容的消息', () => {
      const messageWithThinking: Message = {
        id: 'msg-456',
        role: 'assistant',
        content: 'Answer here',
        timestamp: Date.now(),
        thinkingContent: 'Thinking process',
      };

      expect(() => MessageSchema.parse(messageWithThinking)).not.toThrow();
    });

    it('应该验证多模态用户消息', () => {
      const multimodalMessage: Message = {
        id: 'msg-multimodal',
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
        timestamp: Date.now(),
      };

      expect(() => MessageSchema.parse(multimodalMessage)).not.toThrow();
    });

    it('应该验证工具调用消息', () => {
      const toolMessage: Message = {
        id: 'msg-789',
        role: 'tool',
        content: 'Tool result',
        timestamp: Date.now(),
        tool_call_id: 'call-123',
        name: 'my_tool',
      };

      expect(() => MessageSchema.parse(toolMessage)).not.toThrow();
    });

    it('应该拒绝缺少必需字段的消息', () => {
      const invalidMessage = {
        id: 'msg-123',
        role: 'user',
        // 缺少 content
        timestamp: Date.now(),
      };

      expect(() => MessageSchema.parse(invalidMessage)).toThrow();
    });

    it('应该拒绝无效的角色', () => {
      const invalidRoleMessage: Partial<Message> = {
        id: 'msg-123',
        role: 'invalid' as any,
        content: 'test',
        timestamp: Date.now(),
      };

      expect(() => MessageSchema.parse(invalidRoleMessage)).toThrow();
    });
  });

  describe('SessionSchema', () => {
    it('应该验证有效的会话', () => {
      const validSession: Session = {
        sessionId: 'session-123',
        projectPath: '/path/to/project',
        title: 'Test Session',
        gitBranch: 'main',
        rootId: 'session-123',
        parentId: 'parent-session',
        relationType: 'fork',
        messageCount: 10,
        firstMessageTime: '2024-01-01T00:00:00Z',
        lastMessageTime: '2024-01-01T01:00:00Z',
        hasErrors: false,
      };

      expect(() => SessionSchema.parse(validSession)).not.toThrow();
    });

    it('应该验证缺少可选字段的会话', () => {
      const minimalSession: Session = {
        sessionId: 'session-456',
        projectPath: '/path/to/project',
        rootId: 'session-456',
        messageCount: 5,
        firstMessageTime: '2024-01-01T00:00:00Z',
        lastMessageTime: '2024-01-01T01:00:00Z',
        hasErrors: false,
      };

      expect(() => SessionSchema.parse(minimalSession)).not.toThrow();
    });

    it('应该保留 lineage 字段并剥离未知的 filePath', () => {
      const parsed = SessionSchema.parse({
        sessionId: 'session-789',
        projectPath: '/path/to/project',
        rootId: 'root-session',
        parentId: 'parent-session',
        relationType: 'fork',
        messageCount: 1,
        firstMessageTime: '2024-01-01T00:00:00Z',
        lastMessageTime: '2024-01-01T00:00:01Z',
        hasErrors: false,
        filePath: '/should/not/leak.jsonl',
      });

      expect(parsed).toMatchObject({
        sessionId: 'session-789',
        rootId: 'root-session',
        parentId: 'parent-session',
        relationType: 'fork',
      });
      expect('filePath' in parsed).toBe(false);
    });
  });

  describe('SessionHistoryMessageSchema', () => {
    it('应该验证字符串历史消息', () => {
      const message = {
        role: 'assistant',
        content: 'history',
        metadata: { source: 'fork' },
        thinkingContent: 'reasoning',
        tool_call_id: 'call-1',
        name: 'tool-name',
        tool_calls: [{ id: 'tool-1' }],
      };

      expect(() => SessionHistoryMessageSchema.parse(message)).not.toThrow();
    });

    it('应该验证多模态与工具历史消息，不要求 UI id/timestamp', () => {
      const multimodal = {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      };
      const toolResult = {
        role: 'tool',
        content: 'done',
        tool_call_id: 'call-2',
        name: 'tool',
      };

      expect(() => SessionHistoryMessageSchema.parse(multimodal)).not.toThrow();
      expect(() => SessionHistoryMessageSchema.parse(toolResult)).not.toThrow();
      expect(() =>
        SessionHistoryMessageSchema.parse({
          id: 'ui-only',
          timestamp: Date.now(),
          ...multimodal,
        })
      ).not.toThrow();
    });

    it('应该保留 reasoningContent 与 thinkingContent', () => {
      const parsed = SessionHistoryMessageSchema.parse({
        role: 'assistant',
        content: 'history',
        reasoningContent: 'chain-of-thought',
        thinkingContent: 'ui-thinking',
      });

      expect(parsed).toMatchObject({
        role: 'assistant',
        content: 'history',
        reasoningContent: 'chain-of-thought',
        thinkingContent: 'ui-thinking',
      });
    });
  });

  describe('ForkSessionResponseSchema', () => {
    it('应该验证 fork 返回的公开 session 与原始 history', () => {
      const response = {
        session: {
          sessionId: 'child-session',
          projectPath: '/workspace',
          rootId: 'parent-session',
          parentId: 'parent-session',
          relationType: 'fork',
          messageCount: 2,
          firstMessageTime: '2024-01-01T00:00:00Z',
          lastMessageTime: '2024-01-01T00:01:00Z',
          hasErrors: false,
        },
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
          {
            role: 'tool',
            content: 'tool output',
            tool_call_id: 'call-3',
            name: 'search',
          },
        ],
      };

      expect(() => ForkSessionResponseSchema.parse(response)).not.toThrow();
    });
  });

  describe('SessionRefSchema', () => {
    it('应该验证 compound session ref', () => {
      const ref = {
        sessionId: 'session-123',
        projectPath: '/workspace',
      };

      expect(() => SessionRefSchema.parse(ref)).not.toThrow();
    });
  });

  describe('Session rewind schemas', () => {
    it('validates checkpoint requests and defaults to conversation-only mode', () => {
      const checkpoint = SessionRewindCheckpointSchema.parse({
        messageId: 'user-2',
        preview: 'rewind this turn',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 2,
      });
      const request = SessionRewindRequestSchema.parse({
        targetMessageId: checkpoint.messageId,
      });

      expect(request).toEqual({
        targetMessageId: 'user-2',
        mode: 'conversation',
      });
    });

    it('validates a rewind response without UI-only message fields', () => {
      expect(() =>
        SessionRewindResponseSchema.parse({
          checkpoint: {
            messageId: 'user-2',
            preview: 'rewind this turn',
            createdAt: '2026-08-05T00:00:00.000Z',
            fileCount: 1,
          },
          mode: 'both',
          removedTurns: 1,
          restoredFiles: ['/workspace/result.txt'],
          messages: [{ role: 'user', content: 'kept history' }],
        })
      ).not.toThrow();
    });
  });

  describe('Subagent resume schemas', () => {
    it('validates immutable lineage and rejects blank follow-up prompts', () => {
      expect(
        ResumeSubagentRequestSchema.parse({ prompt: 'Check the follow-up' })
      ).toEqual({ prompt: 'Check the follow-up' });
      expect(() => ResumeSubagentRequestSchema.parse({ prompt: '   ' })).toThrow();

      expect(
        ResumeSubagentResponseSchema.parse({
          source: {
            id: 'agent-source',
            subagentType: 'Explore',
            description: 'Inspect code',
            status: 'completed',
            rootAgentId: 'agent-root',
            resumeDepth: 1,
            createdAt: 1,
            lastActiveAt: 2,
          },
          session: {
            id: 'agent-child',
            subagentType: 'Explore',
            description: 'Inspect code',
            status: 'running',
            rootAgentId: 'agent-root',
            resumedFrom: 'agent-source',
            resumeDepth: 2,
            createdAt: 3,
            lastActiveAt: 3,
          },
        })
      ).toMatchObject({
        source: { id: 'agent-source', resumeDepth: 1 },
        session: {
          id: 'agent-child',
          resumedFrom: 'agent-source',
          resumeDepth: 2,
        },
      });
    });
  });

  describe('BusEventSchema', () => {
    it('应该验证有效的事件', () => {
      const validEvent: BusEvent = {
        type: 'test-event',
        properties: { key1: 'value1', key2: 123 },
      };

      expect(() => BusEventSchema.parse(validEvent)).not.toThrow();
    });

    it('应该验证空属性的事件', () => {
      const eventWithEmptyProps: BusEvent = {
        type: 'simple-event',
        properties: {},
      };

      expect(() => BusEventSchema.parse(eventWithEmptyProps)).not.toThrow();
    });
  });

  describe('SendMessageRequestSchema', () => {
    it('应该验证有效的发送消息请求', () => {
      const validRequest: SendMessageRequest = {
        content: 'Hello',
      };

      expect(() => SendMessageRequestSchema.parse(validRequest)).not.toThrow();
    });

    it('应该验证带有权限模式的请求', () => {
      const requestWithPermission: SendMessageRequest = {
        content: 'Execute command',
        permissionMode: 'autoEdit',
      };

      expect(() => SendMessageRequestSchema.parse(requestWithPermission)).not.toThrow();
    });

    it('应该保留用于区分同 ID 跨 workspace 会话的 projectPath', () => {
      const request: SendMessageRequest = {
        content: 'Send to workspace B',
        projectPath: '/tmp/workspace-b',
      };
      const parsed = SendMessageRequestSchema.parse(request);

      expect(parsed).toEqual({
        content: 'Send to workspace B',
        projectPath: '/tmp/workspace-b',
      });
    });

    it('应该验证带有附件的请求', () => {
      const requestWithAttachments: SendMessageRequest = {
        content: 'Check this file',
        attachments: [
          { type: 'file', path: '/path/to/file.txt' },
          { type: 'image', path: '/path/to/image.png' },
          { type: 'url', url: 'https://example.com' },
        ],
      };

      expect(() =>
        SendMessageRequestSchema.parse(requestWithAttachments)
      ).not.toThrow();
    });

    it('应该验证带图片内容和元数据的请求', () => {
      const requestWithImageMetadata: SendMessageRequest = {
        content: '',
        attachments: [
          {
            type: 'image',
            content: 'data:image/png;base64,abc',
            mimeType: 'image/png',
            name: 'pasted.png',
          },
        ],
      };

      expect(() =>
        SendMessageRequestSchema.parse(requestWithImageMetadata)
      ).not.toThrow();
    });
  });

  describe('SendMessageResponseSchema', () => {
    it('应该验证有效的响应', () => {
      const validResponse: SendMessageResponse = {
        messageId: 'msg-123',
        role: 'assistant',
        content: 'Response',
        timestamp: new Date().toISOString(),
      };

      expect(() => SendMessageResponseSchema.parse(validResponse)).not.toThrow();
    });
  });

  describe('PermissionResponseSchema', () => {
    it('应该验证批准的响应', () => {
      const approvedResponse: PermissionResponse = {
        approved: true,
        remember: true,
        scope: 'session',
      };

      expect(() => PermissionResponseSchema.parse(approvedResponse)).not.toThrow();
    });

    it('应该接受显式的项目级权限作用域', () => {
      expect(() =>
        PermissionResponseSchema.parse({
          approved: true,
          scope: 'project',
        })
      ).not.toThrow();
    });

    it('应该验证拒绝的响应', () => {
      const deniedResponse: PermissionResponse = {
        approved: false,
        feedback: 'Not safe to execute',
      };

      expect(() => PermissionResponseSchema.parse(deniedResponse)).not.toThrow();
    });

    it('应该验证带有答案的响应', () => {
      const responseWithAnswers: PermissionResponse = {
        approved: true,
        answers: {
          question1: 'answer1',
          question2: ['answer2', 'answer3'],
        },
      };

      expect(() => PermissionResponseSchema.parse(responseWithAnswers)).not.toThrow();
    });
  });

  describe('ModelConfigSchema', () => {
    it('应该验证有效的模型配置', () => {
      const validConfig: ModelConfig = {
        id: 'openai-gpt-4',
        name: 'GPT-4',
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-xxx',
        maxContextTokens: 128000,
      };

      expect(() => ModelConfigSchema.parse(validConfig)).not.toThrow();
    });

    it('应该验证最小配置', () => {
      const minimalConfig: ModelConfig = {
        id: 'local-model',
        name: 'Local Model',
        provider: 'ollama',
        model: 'llama2',
      };

      expect(() => ModelConfigSchema.parse(minimalConfig)).not.toThrow();
    });
  });

  describe('EditorThemeSchema', () => {
    it('应该验证有效的编辑器主题', () => {
      const validThemes: EditorTheme[] = ['vs-dark', 'vs-light', 'hc-black'];

      validThemes.forEach((theme) => {
        expect(() => EditorThemeSchema.parse(theme)).not.toThrow();
      });
    });

    it('应该拒绝无效的主题', () => {
      expect(() => EditorThemeSchema.parse('invalid')).toThrow();
    });
  });

  describe('UiThemeSchema', () => {
    it('应该验证有效的 UI 主题', () => {
      const validThemes: UiTheme[] = ['light', 'dark', 'system'];

      validThemes.forEach((theme) => {
        expect(() => UiThemeSchema.parse(theme)).not.toThrow();
      });
    });

    it('应该拒绝无效的主题', () => {
      expect(() => UiThemeSchema.parse('auto')).toThrow();
    });
  });

  describe('GeneralSettingsSchema', () => {
    it('应该验证完整的设置', () => {
      const fullSettings: GeneralSettings = {
        language: 'zh-CN',
        theme: 'dark',
        uiTheme: 'dark',
        autoSaveSessions: true,
        notifyBuild: false,
        notifyErrors: true,
        notifySounds: false,
        privacyTelemetry: true,
        privacyCrash: false,
      };

      expect(() => GeneralSettingsSchema.parse(fullSettings)).not.toThrow();
    });
  });

  describe('GeneralSettingsUpdateSchema', () => {
    it('应该验证部分更新', () => {
      const partialUpdate: GeneralSettingsUpdate = {
        language: 'en-US',
        theme: 'light',
      };

      expect(() => GeneralSettingsUpdateSchema.parse(partialUpdate)).not.toThrow();
    });

    it('应该验证单个字段更新', () => {
      const singleFieldUpdate: GeneralSettingsUpdate = {
        autoSaveSessions: false,
      };

      expect(() => GeneralSettingsUpdateSchema.parse(singleFieldUpdate)).not.toThrow();
    });

    it('应该验证空更新', () => {
      const emptyUpdate: GeneralSettingsUpdate = {};

      expect(() => GeneralSettingsUpdateSchema.parse(emptyUpdate)).not.toThrow();
    });
  });
});
