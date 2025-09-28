/**
 * ErrorSerializer 测试
 */

import { BladeError } from '../../../src/error/BladeError.js';
import { ErrorSerializer } from '../../../src/error/ErrorSerializer.js';

describe('ErrorSerializer', () => {
  let serializer: ErrorSerializer;

  beforeEach(() => {
    serializer = new ErrorSerializer({
      includeStack: true,
      includeContext: true,
      includeCause: true,
      includeRelatedErrors: true,
      maxContextDepth: 10,
      stripSensitiveData: true,
      sensitiveFields: ['password', 'token', 'apiKey'],
    });
  });

  test('应该正确序列化BladeError', () => {
    const error = new BladeError('CORE', '0004', '测试错误', {
      context: { userId: '123', action: 'test' },
      retryable: true,
      suggestions: ['检查配置'],
    });

    const serialized = serializer.serialize(error);

    expect(serialized.name).toBe('BladeError');
    expect(serialized.message).toBe('测试错误');
    expect(serialized.code).toBe('CORE_0004');
    expect(serialized.context).toEqual({ userId: '123', action: 'test' });
    expect(serialized.retryable).toBe(true);
    expect(serialized.suggestions).toEqual(['检查配置']);
  });

  test('应该正确反序列化错误', () => {
    const originalError = new BladeError('CORE', '0004', '测试错误');
    const serialized = serializer.serialize(originalError);
    const deserialized = serializer.deserialize(serialized);

    expect(deserialized).toBeInstanceOf(BladeError);
    expect(deserialized.message).toBe('测试错误');
    expect(deserialized.code).toBe('CORE_0004');
  });

  test('应该正确处理敏感数据', () => {
    const error = new BladeError('CORE', '0004', '测试错误', {
      context: {
        userId: '123',
        password: 'secret',
        apiKey: 'abcdef123456',
      },
    });

    const serialized = serializer.serialize(error);

    expect(serialized.context.userId).toBe('123');
    expect(serialized.context.password).toBe('[REDACTED]');
    expect(serialized.context.apiKey).toBe('[REDACTED]');
  });

  test('应该正确转换为JSON字符串', () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    const jsonString = serializer.toJson(error);

    expect(typeof jsonString).toBe('string');
    expect(jsonString).toContain('测试错误');

    const parsed = JSON.parse(jsonString);
    expect(parsed.message).toBe('测试错误');
  });

  test('应该正确从JSON字符串解析', () => {
    const error = new BladeError('CORE', '0004', '测试错误');
    const jsonString = serializer.toJson(error);
    const parsedError = serializer.fromJson(jsonString);

    expect(parsedError).toBeInstanceOf(BladeError);
    expect(parsedError.message).toBe('测试错误');
  });

  test('应该正确处理嵌套对象中的敏感数据', () => {
    const error = new BladeError('CORE', '0004', '测试错误', {
      context: {
        user: {
          id: '123',
          credentials: {
            password: 'secret',
            token: 'abcdef',
          },
        },
      },
    });

    const serialized = serializer.serialize(error);

    expect(serialized.context.user.id).toBe('123');
    expect(serialized.context.user.credentials.password).toBe('[REDACTED]');
    expect(serialized.context.user.credentials.token).toBe('[REDACTED]');
  });
});
