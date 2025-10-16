import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetrySDK } from '../../../src/telemetry/sdk';

// Mock axios
vi.mock('axios');

describe('TelemetrySDK', () => {
  let telemetrySDK: TelemetrySDK;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = {
      telemetry: {
        enabled: true,
        endpoint: 'https://test-telemetry.example.com/api/v1/events',
        interval: 1000,
        batchSize: 10,
      },
      telemetryEndpoint: 'https://test-telemetry.example.com/api/v1/events',
      version: '1.0.0',
    };

    telemetrySDK = new TelemetrySDK(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should initialize successfully', async () => {
    await expect(telemetrySDK.initialize()).resolves.not.toThrow();
    expect(telemetrySDK.getTelemetryStatus().initialized).toBe(true);
  });

  it('should not initialize when disabled', async () => {
    mockConfig.telemetry = false;
    const disabledSDK = new TelemetrySDK(mockConfig);

    await disabledSDK.initialize();
    expect(disabledSDK.getTelemetryStatus().initialized).toBe(false);
  });

  it('should track events', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackEvent('test_event', { test: 'data' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(1);
    expect(stats.eventTypes['test_event']).toBe(1);
  });

  it('should track page views', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackPageView('home_page', { path: '/' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.eventTypes['page_view']).toBe(1);
  });

  it('should track errors', async () => {
    await telemetrySDK.initialize();

    const testError = new Error('测试错误');
    telemetrySDK.trackError(testError, { component: 'test' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.eventTypes['error']).toBe(1);
  });

  it('should track performance metrics', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackPerformance('api_call', 150, { endpoint: '/api/test' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.eventTypes['performance']).toBe(1);
  });

  it('should track user actions', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackUserAction('click', 'button_login', { user: 'test' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.eventTypes['user_action']).toBe(1);
  });

  it('should track feature usage', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackFeatureUsage('code_generation', { language: 'javascript' });

    const stats = telemetrySDK.getEventStats();
    expect(stats.eventTypes['feature_usage']).toBe(1);
  });

  it('should batch events correctly', async () => {
    vi.useFakeTimers();

    await telemetrySDK.initialize();

    // 添加多个事件
    telemetrySDK.trackEvent('test_event_1');
    telemetrySDK.trackEvent('test_event_2');

    // 模拟时间流逝
    vi.advanceTimersByTime(1000);

    // 使用fake timers时，需要用vi.advanceTimersByTime来推进setTimeout
    vi.advanceTimersByTime(100);

    const stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(2);
  });

  it('should flush events to server', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } });

    await telemetrySDK.initialize();

    telemetrySDK.trackEvent('test_event_1');
    telemetrySDK.trackEvent('test_event_2');

    await telemetrySDK.flushEvents();

    expect(axios.post).toHaveBeenCalledWith(
      'https://test-telemetry.example.com/api/v1/events',
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            eventName: 'test_event_1',
          }),
          expect.objectContaining({
            eventName: 'test_event_2',
          }),
        ]),
        batchId: expect.any(String),
        timestamp: expect.any(Number),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'User-Agent': expect.stringContaining('Blade-AI/'),
        }),
        timeout: 10000,
      })
    );
  });

  it('should handle network errors gracefully', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('Network error'));

    await telemetrySDK.initialize();

    telemetrySDK.trackEvent('test_event');

    // 不应该抛出错误
    await expect(telemetrySDK.flushEvents()).resolves.not.toThrow();
  });

  it('should respect batch size limits', async () => {
    await telemetrySDK.initialize();

    // 添加超过批次大小的事件
    for (let i = 0; i < 15; i++) {
      telemetrySDK.trackEvent(`test_event_${i}`);
    }

    const stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(15);
  });

  it('should handle concurrent event tracking', async () => {
    await telemetrySDK.initialize();

    // 并发添加事件
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        new Promise((resolve) => {
          telemetrySDK.trackEvent(`concurrent_event_${i}`);
          resolve(undefined);
        })
      );
    }

    await Promise.all(promises);

    const stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(10);
  });

  it('should provide correct telemetry status', async () => {
    const status = telemetrySDK.getTelemetryStatus();
    expect(status.enabled).toBeTruthy(); // config.telemetry is an object, so it's truthy
    expect(status.initialized).toBe(false);

    await telemetrySDK.initialize();

    const updatedStatus = telemetrySDK.getTelemetryStatus();
    expect(updatedStatus.initialized).toBe(true);
  });

  it('should reset event statistics', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackEvent('test_event');
    telemetrySDK.trackEvent('another_event');

    let stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(2);

    telemetrySDK.clearEvents();

    stats = telemetrySDK.getEventStats();
    expect(stats.totalEvents).toBe(0);
  });

  it('should destroy cleanly', async () => {
    await telemetrySDK.initialize();

    telemetrySDK.trackEvent('test_event');

    await expect(telemetrySDK.destroy()).resolves.not.toThrow();

    const status = telemetrySDK.getTelemetryStatus();
    expect(status.initialized).toBe(false);
  });
});
