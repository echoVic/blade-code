import axios from 'axios';
import { TelemetrySDK, PerformanceMonitor, ErrorTracker } from '../src/telemetry/sdk.js';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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
      version: '1.0.0',
    };
    
    telemetrySDK = new TelemetrySDK(mockConfig);
  });
  
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });
  
  it('should initialize successfully', async () => {
    await expect(telemetrySDK.initialize()).resolves.not.toThrow();
    expect(telemetrySDK.getTelemetryStatus().initialized).toBe(true);
  });
  
  it('should not initialize when disabled', async () => {
    mockConfig.telemetry.enabled = false;
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
  
  it('should flush events to server', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    
    await telemetrySDK.initialize();
    
    // 添加一些事件
    telemetrySDK.trackEvent('test_event_1');
    telemetrySDK.trackEvent('test_event_2');
    
    // 刷新事件
    await telemetrySDK.flushEvents();
    
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://test-telemetry.example.com/api/v1/events',
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ eventName: 'test_event_1' }),
          expect.objectContaining({ eventName: 'test_event_2' })
        ])
      }),
      expect.any(Object)
    );
  });
  
  it('should handle flush errors gracefully', async () => {
    mockedAxios.post.mockRejectedValue(new Error('网络错误'));
    
    await telemetrySDK.initialize();
    
    // 添加事件
    telemetrySDK.trackEvent('test_event');
    
    // 刷新应该不抛出异常
    await expect(telemetrySDK.flushEvents()).resolves.not.toThrow();
    
    // 事件应该保留在队列中
    const stats = telemetrySDK.getEventStats();
    expect(stats.queuedEvents).toBe(1);
  });
  
  it('should set user ID', async () => {
    await telemetrySDK.initialize();
    
    telemetrySDK.setUserId('user_123');
    
    const status = telemetrySDK.getTelemetryStatus();
    expect(status.userId).toBe('user_123');
  });
  
  it('should clear events', async () => {
    await telemetrySDK.initialize();
    
    telemetrySDK.trackEvent('test_event');
    expect(telemetrySDK.getEventStats().totalEvents).toBe(1);
    
    telemetrySDK.clearEvents();
    expect(telemetrySDK.getEventStats().totalEvents).toBe(0);
  });
  
  it('should destroy properly', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    
    await telemetrySDK.initialize();
    
    telemetrySDK.trackEvent('test_event');
    await telemetrySDK.destroy();
    
    // 应该刷新所有事件
    expect(mockedAxios.post).toHaveBeenCalled();
    
    const status = telemetrySDK.getTelemetryStatus();
    expect(status.initialized).toBe(false);
    expect(status.queuedEvents).toBe(0);
  });
});

describe('PerformanceMonitor', () => {
  let performanceMonitor: PerformanceMonitor;
  
  beforeEach(() => {
    performanceMonitor = PerformanceMonitor.getInstance();
  });
  
  afterEach(() => {
    // 清理指标
    (performanceMonitor as any).metrics.clear();
  });
  
  it('should be a singleton', () => {
    const instance1 = PerformanceMonitor.getInstance();
    const instance2 = PerformanceMonitor.getInstance();
    
    expect(instance1).toBe(instance2);
  });
  
  it('should measure async function execution time', async () => {
    const asyncFn = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'result';
    };
    
    const { result, duration } = await performanceMonitor.measureAsync('test_async', asyncFn);
    
    expect(result).toBe('result');
    expect(duration).toBeGreaterThan(5); // 应该大于5ms
  });
  
  it('should measure sync function execution time', () => {
    const syncFn = () => {
      let sum = 0;
      for (let i = 0; i < 1000; i++) {
        sum += i;
      }
      return sum;
    };
    
    const { result, duration } = performanceMonitor.measureSync('test_sync', syncFn);
    
    expect(result).toBe(499500);
    expect(duration).toBeGreaterThanOrEqual(0);
  });
  
  it('should start and end manual measurements', () => {
    const measurementId = performanceMonitor.startMeasurement('manual_test');
    
    // 模拟一些工作
    const start = performance.now();
    while (performance.now() - start < 5) {
      // 等待5ms
    }
    
    const duration = performanceMonitor.endMeasurement(measurementId);
    
    expect(duration).toBeGreaterThan(0);
  });
  
  it('should get metrics stats', () => {
    // 记录一些指标
    (performanceMonitor as any).recordMetric('test_metric', 100);
    (performanceMonitor as any).recordMetric('test_metric', 200);
    (performanceMonitor as any).recordMetric('test_metric', 150);
    
    const stats = performanceMonitor.getMetricsStats('test_metric');
    
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(200);
    expect(stats.avg).toBe(150);
    expect(stats.total).toBe(450);
  });
  
  it('should get all metrics', () => {
    (performanceMonitor as any).recordMetric('metric_1', 100);
    (performanceMonitor as any).recordMetric('metric_2', 200);
    
    const allMetrics = performanceMonitor.getAllMetrics();
    
    expect(Object.keys(allMetrics)).toHaveLength(2);
    expect(allMetrics['metric_1']).toBeDefined();
    expect(allMetrics['metric_2']).toBeDefined();
  });
  
  it('should clear metrics', () => {
    (performanceMonitor as any).recordMetric('test_metric', 100);
    
    expect(performanceMonitor.getMetricsStats('test_metric').count).toBe(1);
    
    performanceMonitor.clearMetrics('test_metric');
    
    expect(performanceMonitor.getMetricsStats('test_metric').count).toBe(0);
  });
  
  it('should get uptime', () => {
    const uptime = performanceMonitor.getUptime();
    expect(uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('ErrorTracker', () => {
  let errorTracker: ErrorTracker;
  let mockTelemetrySDK: jest.Mocked<TelemetrySDK>;
  
  beforeEach(() => {
    errorTracker = ErrorTracker.getInstance();
    mockTelemetrySDK = {
      trackError: jest.fn(),
    } as any;
    
    errorTracker.setTelemetrySDK(mockTelemetrySDK);
  });
  
  afterEach(() => {
    // 清理错误
    (errorTracker as any).errors = [];
  });
  
  it('should be a singleton', () => {
    const instance1 = ErrorTracker.getInstance();
    const instance2 = ErrorTracker.getInstance();
    
    expect(instance1).toBe(instance2);
  });
  
  it('should track errors', () => {
    const testError = new Error('测试错误');
    const context = { component: 'test', action: 'click' };
    
    errorTracker.trackError(testError, context);
    
    const errors = errorTracker.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe('测试错误');
    expect(errors[0].context).toEqual(context);
  });
  
  it('should send errors to telemetry SDK', () => {
    const testError = new Error('遥测测试错误');
    
    errorTracker.trackError(testError);
    
    expect(mockTelemetrySDK.trackError).toHaveBeenCalledWith(
      testError,
      expect.objectContaining({
        errorId: expect.any(String),
        severity: 'error',
      })
    );
  });
  
  it('should get error stats', () => {
    const error1 = new Error('错误1');
    const error2 = new Error('错误2');
    
    errorTracker.trackError(error1, { severity: 'warning' });
    errorTracker.trackError(error2, { severity: 'error' });
    errorTracker.trackError(error1, { severity: 'error' });
    
    const stats = errorTracker.getErrorStats();
    
    expect(stats.totalErrors).toBe(3);
    expect(stats.severityCounts['warning']).toBe(1);
    expect(stats.severityCounts['error']).toBe(2);
    expect(stats.latestError).toBeDefined();
  });
  
  it('should clear errors', () => {
    const testError = new Error('测试错误');
    errorTracker.trackError(testError);
    
    expect(errorTracker.getErrors()).toHaveLength(1);
    
    errorTracker.clearErrors();
    
    expect(errorTracker.getErrors()).toHaveLength(0);
  });
  
  it('should limit returned errors', () => {
    // 添加5个错误
    for (let i = 0; i < 5; i++) {
      errorTracker.trackError(new Error(`错误${i}`));
    }
    
    const allErrors = errorTracker.getErrors();
    const limitedErrors = errorTracker.getErrors(3);
    
    expect(allErrors).toHaveLength(5);
    expect(limitedErrors).toHaveLength(3);
    // 应该返回最新的错误
    expect(limitedErrors[0].error.message).toBe('错误4');
  });
});