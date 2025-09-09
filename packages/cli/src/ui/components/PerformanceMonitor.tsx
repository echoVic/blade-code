import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { usePerformance } from '../../contexts/AppContext.js';

interface PerformanceMonitorProps {
  interval?: number; // 更新间隔（毫秒）
  showGraph?: boolean; // 是否显示图形
  className?: string;
}

export const PerformanceMonitor: React.FC<PerformanceMonitorProps> = ({ 
  interval = 1000,
  showGraph = false,
  className 
}) => {
  const { performance, updatePerformance } = usePerformance();
  const [history, setHistory] = useState<number[]>([]);

  // 更新性能数据
  useEffect(() => {
    const updateStats = () => {
      // 获取内存使用情况
      const memoryUsage = process.memoryUsage();
      const totalMem = memoryUsage.heapTotal;
      const usedMem = memoryUsage.heapUsed;
      const memPercentage = Math.round((usedMem / totalMem) * 100);

      // 获取CPU使用情况（简化实现）
      const cpuUsage = process.cpuUsage();
      const cpuPercentage = Math.min(100, Math.round(cpuUsage.user / 1000000));

      // 更新性能数据
      updatePerformance({
        memory: {
          used: usedMem,
          total: totalMem,
          percentage: memPercentage,
        },
        cpu: {
          usage: cpuPercentage,
        },
        uptime: Math.floor(process.uptime()),
      });

      // 更新历史数据
      setHistory(prev => {
        const newHistory = [...prev, memPercentage];
        return newHistory.length > 20 ? newHistory.slice(-20) : newHistory;
      });
    };

    updateStats(); // 立即更新一次
    const timer = setInterval(updateStats, interval);

    return () => clearInterval(timer);
  }, [interval, updatePerformance]);

  // 生成简单的ASCII图形
  const generateGraph = (data: number[], width: number, height: number) => {
    if (data.length === 0) return '';
    
    const maxValue = Math.max(...data, 1);
    const step = Math.max(1, Math.floor(data.length / width));
    
    let graph = '';
    for (let i = 0; i < height; i++) {
      let line = '';
      for (let j = 0; j < width; j += step) {
        const index = Math.floor(j * data.length / width);
        const value = data[index] || 0;
        const barHeight = Math.floor((value / maxValue) * height);
        
        if (i >= height - barHeight) {
          line += '█';
        } else {
          line += ' ';
        }
      }
      graph += line + '\n';
    }
    
    return graph;
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  return (
    <Box 
      flexDirection="column"
      paddingX={1}
      paddingY={0}
      borderStyle="round"
      borderColor="#4F46E5"
      backgroundColor="#1F2937"
      {...(className ? { className } : {})}
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text color="#93C5FD" bold>📊 性能监控</Text>
        <Text color="#9CA3AF" dimColor>
          更新间隔: {interval}ms
        </Text>
      </Box>

      {/* 内存使用 */}
      <Box flexDirection="row" alignItems="center" marginBottom={1}>
        <Text color="#FBBF24" marginRight={1}>🧠</Text>
        <Text color="#D1D5DB" width={12}>内存:</Text>
        <Text color="#93C5FD">
          {formatBytes(performance.memory.used)} / {formatBytes(performance.memory.total)}
        </Text>
        <Text color="#9CA3AF" marginLeft={2}>
          ({performance.memory.percentage}%)
        </Text>
      </Box>

      {/* CPU使用 */}
      <Box flexDirection="row" alignItems="center" marginBottom={1}>
        <Text color="#EF4444" marginRight={1}>⚡</Text>
        <Text color="#D1D5DB" width={12}>CPU:</Text>
        <Text color="#93C5FD">{performance.cpu.usage}%</Text>
      </Box>

      {/* 运行时间 */}
      <Box flexDirection="row" alignItems="center" marginBottom={1}>
        <Text color="#10B981" marginRight={1}>⏰</Text>
        <Text color="#D1D5DB" width={12}>运行时间:</Text>
        <Text color="#93C5FD">{formatTime(performance.uptime)}</Text>
      </Box>

      {/* 内存使用图表 */}
      {showGraph && history.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="#9CA3AF" dimColor marginBottom={1}>内存使用趋势:</Text>
          <Text color="#93C5FD">
            {generateGraph(history, 30, 5)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// 静态性能监控类
export class PerformanceMonitorStatic {
  private static instance: PerformanceMonitorStatic;
  private stats: any = {};
  private startTime: number;

  private constructor() {
    this.startTime = Date.now();
  }

  public static getInstance(): PerformanceMonitorStatic {
    if (!PerformanceMonitorStatic.instance) {
      PerformanceMonitorStatic.instance = new PerformanceMonitorStatic();
    }
    return PerformanceMonitorStatic.instance;
  }

  public start(): void {
    this.startTime = Date.now();
    console.log('性能监控已启动');
  }

  public stop(): void {
    const duration = Date.now() - this.startTime;
    console.log(`性能监控已停止，运行时间: ${duration}ms`);
  }

  public getStats(): any {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    };
  }

  public logMemoryUsage(label: string): void {
    const usage = process.memoryUsage();
    console.log(`[${label}] 内存使用:`, {
      rss: `${(usage.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(usage.external / 1024 / 1024).toFixed(2)} MB`,
    });
  }

  public measureFunction<T extends (...args: any[]) => any>(
    fn: T, 
    label: string
  ): (...args: Parameters<T>) => ReturnType<T> {
    return (...args: Parameters<T>): ReturnType<T> => {
      const start = process.hrtime.bigint();
      const result = fn(...args);
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // 转换为毫秒
      
      console.log(`[${label}] 函数执行时间: ${duration.toFixed(2)}ms`);
      return result;
    };
  }
}