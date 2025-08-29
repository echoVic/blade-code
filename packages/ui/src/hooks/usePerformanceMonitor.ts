/*
 * 性能监控 Hook
 * 用于监控组件渲染性能、内存使用等关键指标
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { performance } from 'perf_hooks';

export interface PerformanceMetrics {
  renderCount: number;
  renderTime: number;
  memoryUsage: NodeJS.MemoryUsage;
  fps: number;
  lastFrameTime: number;
}

export interface PerformanceOptions {
  enableMemoryTracking?: boolean;
  enableFPSTracking?: boolean;
  sampleRate?: number;
  maxSampleSize?: number;
}

export const usePerformanceMonitor = (
  componentName: string,
  options: PerformanceOptions = {}
) => {
  const {
    enableMemoryTracking = false,
    enableFPSTracking = false,
    sampleRate = 1,
    maxSampleSize = 100
  } = options;

  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    renderCount: 0,
    renderTime: 0,
    memoryUsage: process.memoryUsage(),
    fps: 0,
    lastFrameTime: performance.now()
  });

  const renderTimesRef = useRef<number[]>([]);
  const frameTimesRef = useRef<number[]>([]);
  const renderStartRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(performance.now());

  // 监控渲染性能
  const measureRender = useCallback(() => {
    const sample = Math.random();
    if (sample > sampleRate) return;

    renderStartRef.current = performance.now();
  }, [sampleRate]);

  const endMeasureRender = useCallback(() => {
    const renderTime = performance.now() - renderStartRef.current;
    
    renderTimesRef.current.push(renderTime);
    if (renderTimesRef.current.length > maxSampleSize) {
      renderTimesRef.current.shift();
    }

    setMetrics(prev => ({
      ...prev,
      renderCount: prev.renderCount + 1,
      renderTime: renderTime
    }));
  }, [maxSampleSize]);

  // 监控FPS
  useEffect(() => {
    if (!enableFPSTracking) return;

    let animationFrameId: number;

    const measureFPS = () => {
      const now = performance.now();
      const delta = now - lastFrameTimeRef.current;
      
      frameTimesRef.current.push(delta);
      if (frameTimesRef.current.length > maxSampleSize) {
        frameTimesRef.current.shift();
      }

      const avgFrameTime = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
      const fps = 1000 / avgFrameTime;

      setMetrics(prev => ({
        ...prev,
        fps,
        lastFrameTime: now
      }));

      lastFrameTimeRef.current = now;
      animationFrameId = requestAnimationFrame(measureFPS);
    };

    animationFrameId = requestAnimationFrame(measureFPS);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [enableFPSTracking, maxSampleSize]);

  // 监控内存使用
  useEffect(() => {
    if (!enableMemoryTracking) return;

    const intervalId = setInterval(() => {
      setMetrics(prev => ({
        ...prev,
        memoryUsage: process.memoryUsage()
      }));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [enableMemoryTracking]);

  // 获取性能报告
  const getPerformanceReport = useCallback(() => {
    const avgRenderTime = renderTimesRef.current.length > 0
      ? renderTimesRef.current.reduce((a, b) => a + b, 0) / renderTimesRef.current.length
      : 0;

    return {
      component: componentName,
      metrics,
      averageRenderTime: avgRenderTime,
      maxRenderTime: Math.max(...renderTimesRef.current, 0),
      minRenderTime: Math.min(...renderTimesRef.current.filter(t => t > 0), Infinity),
      renderCount: renderTimesRef.current.length,
      timestamp: new Date().toISOString()
    };
  }, [componentName, metrics]);

  return {
    metrics,
    measureRender,
    endMeasureRender,
    getPerformanceReport
  };
};