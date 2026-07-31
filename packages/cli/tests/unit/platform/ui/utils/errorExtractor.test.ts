/**
 * errorExtractor — classifyError 单元测试
 *
 * 测试唯一错误分类入口，覆盖：
 * - AbortError（name / message 两种检测路径）
 * - RetryError（嵌套 lastError 解包）
 * - APICallError（responseBody JSON 解析 + statusCode）
 * - vision 不支持（多种关键词）
 * - 非 Error 对象 fallback
 */

import { describe, expect, it } from 'vitest';
import { classifyError } from '../../../../../src/ui/utils/errorExtractor.js';

describe('classifyError', () => {
  // ==================== AbortError ====================

  describe('AbortError 检测', () => {
    it('应该检测 name 为 AbortError 的错误', () => {
      const error = new DOMException('The operation was aborted', 'AbortError');
      const result = classifyError(error);

      expect(result.isAbort).toBe(true);
      expect(result.isVisionNotSupported).toBe(false);
    });

    it('应该检测 message 包含 aborted 的错误', () => {
      const error = new Error('Request aborted by user');
      const result = classifyError(error);

      expect(result.isAbort).toBe(true);
    });

    it('非 abort 错误应该返回 isAbort = false', () => {
      const error = new Error('Network timeout');
      const result = classifyError(error);

      expect(result.isAbort).toBe(false);
    });
  });

  // ==================== RetryError 解包 ====================

  describe('RetryError 解包', () => {
    it('应该从 RetryError 的 lastError 中提取消息', () => {
      const rootCause = new Error('Connection refused');
      const retryError = Object.assign(
        new Error('Retry failed 3 times. Last error: Connection refused'),
        {
          lastError: rootCause,
        }
      );

      const result = classifyError(retryError);

      // extractFriendlyErrorMessage 优先尝试 lastError.responseBody，
      // 然后 match "Last error:" 前缀
      expect(result.displayMessage).toBe('Connection refused');
    });

    it('应该从 RetryError message 中的 Last error 前缀提取', () => {
      // 没有 lastError 属性但 message 包含 "Last error:" 前缀
      const error = new Error('Retry failed 3 times. Last error: rate limit exceeded');

      const result = classifyError(error);

      expect(result.displayMessage).toBe('rate limit exceeded');
    });
  });

  // ==================== APICallError（responseBody）====================

  describe('APICallError responseBody 解析', () => {
    it('应该从 responseBody JSON 中提取 error.message', () => {
      const apiError = Object.assign(new Error('API call failed'), {
        responseBody: JSON.stringify({
          error: { message: 'You exceeded your current quota' },
        }),
        statusCode: 429,
      });

      const result = classifyError(apiError);

      expect(result.displayMessage).toBe('You exceeded your current quota (HTTP 429)');
    });

    it('应该从 RetryError 嵌套的 lastError.responseBody 中解析', () => {
      const innerError = Object.assign(new Error('API call failed'), {
        responseBody: JSON.stringify({
          error: { message: 'Invalid API key' },
        }),
        statusCode: 401,
      });
      const retryError = Object.assign(
        new Error('Retry failed. Last error: API call failed'),
        {
          lastError: innerError,
        }
      );

      const result = classifyError(retryError);

      expect(result.displayMessage).toBe('Invalid API key (HTTP 401)');
    });

    it('应该在 responseBody JSON 解析失败时 fallback 到 message', () => {
      const apiError = Object.assign(new Error('Something went wrong'), {
        responseBody: 'not json',
        statusCode: 500,
      });

      const result = classifyError(apiError);

      expect(result.displayMessage).toBe('Something went wrong');
    });

    it('应该在 responseBody 无 error.message 字段时 fallback', () => {
      const apiError = Object.assign(new Error('API error'), {
        responseBody: JSON.stringify({ status: 'error' }),
        statusCode: 500,
      });

      const result = classifyError(apiError);

      expect(result.displayMessage).toBe('API error');
    });
  });

  // ==================== Vision 不支持 ====================

  describe('视觉模型不支持检测', () => {
    const visionKeywords = [
      'can only concatenate str',
      'image_url is not supported',
      'multimodal input not allowed',
      'vision capabilities required',
      'does not support images',
    ];

    for (const keyword of visionKeywords) {
      it(`应该检测包含 "${keyword}" 的错误`, () => {
        const error = new Error(`Error: ${keyword}`);
        const result = classifyError(error);

        expect(result.isVisionNotSupported).toBe(true);
        // vision 错误应该返回统一的中文提示
        expect(result.displayMessage).toContain('当前模型不支持图片理解功能');
      });
    }

    it('vision 错误应该覆盖原始 message', () => {
      const error = new Error('multimodal input is not supported for this model');
      const result = classifyError(error);

      expect(result.displayMessage).not.toBe(error.message);
      expect(result.displayMessage).toContain('支持视觉能力的模型');
    });
  });

  // ==================== 非 Error 对象 ====================

  describe('非 Error 输入', () => {
    it('应该处理字符串错误', () => {
      const result = classifyError('string error');

      expect(result.displayMessage).toBe('未知错误');
      expect(result.isAbort).toBe(false);
      expect(result.isVisionNotSupported).toBe(false);
    });

    it('应该处理 null', () => {
      const result = classifyError(null);

      expect(result.displayMessage).toBe('未知错误');
      expect(result.isAbort).toBe(false);
    });

    it('应该处理 undefined', () => {
      const result = classifyError(undefined);

      expect(result.displayMessage).toBe('未知错误');
    });

    it('应该处理纯对象', () => {
      const result = classifyError({ code: 500 });

      expect(result.displayMessage).toBe('未知错误');
    });
  });

  // ==================== 普通错误 ====================

  describe('普通错误', () => {
    it('应该直接返回 error.message', () => {
      const error = new Error('Something went wrong');
      const result = classifyError(error);

      expect(result.displayMessage).toBe('Something went wrong');
      expect(result.isAbort).toBe(false);
      expect(result.isVisionNotSupported).toBe(false);
    });
  });
});
