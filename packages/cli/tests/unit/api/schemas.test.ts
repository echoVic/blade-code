/**
 * API Schemas 测试
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionModeSchema,
  MessageSchema,
  SessionSchema,
  BusEventSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  PermissionResponseSchema,
  ModelConfigSchema,
  EditorThemeSchema,
  UiThemeSchema,
  GeneralSettingsSchema,
  GeneralSettingsUpdateSchema,
  type PermissionMode,
  type Message,
  type Session,
  type BusEvent,
  type SendMessageRequest,
  type SendMessageResponse,
  type PermissionResponse,
  type ModelConfig,
  type EditorTheme,
  type UiTheme,
  type GeneralSettings,
  type GeneralSettingsUpdate,
  PermissionModeEnum,
} from '../../../src/api/schemas.js';

describe('API Schemas', () => {
  describe('PermissionModeSchema', () => {
    it('应该验证有效的权限模式', () => {
      const validModes: PermissionMode[] = ['default', 'autoEdit', 'yolo', 'plan', 'spec'];
      
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
      expect(PermissionModeEnum.SPEC).toBe('spec');
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
        messageCount: 10,
        firstMessageTime: '2024-01-01T00:00:00Z',
        lastMessageTime: '2024-01-01T01:00:00Z',
        hasErrors: false,
        filePath: '/path/to/session.jsonl',
      };

      expect(() => SessionSchema.parse(validSession)).not.toThrow();
    });

    it('应该验证缺少可选字段的会话', () => {
      const minimalSession: Session = {
        sessionId: 'session-456',
        projectPath: '/path/to/project',
        messageCount: 5,
        firstMessageTime: '2024-01-01T00:00:00Z',
        lastMessageTime: '2024-01-01T01:00:00Z',
        hasErrors: false,
      };

      expect(() => SessionSchema.parse(minimalSession)).not.toThrow();
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

    it('应该验证带有附件的请求', () => {
      const requestWithAttachments: SendMessageRequest = {
        content: 'Check this file',
        attachments: [
          { type: 'file', path: '/path/to/file.txt' },
          { type: 'image', path: '/path/to/image.png' },
          { type: 'url', url: 'https://example.com' },
        ],
      };

      expect(() => SendMessageRequestSchema.parse(requestWithAttachments)).not.toThrow();
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
