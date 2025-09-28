/**
 * 安全监控和检测工具
 * 实时监控系统的安全状态
 */

import { createHash } from 'crypto';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SecurityEvent {
  id: string;
  timestamp: string;
  type:
    | 'auth_failure'
    | 'path_traversal'
    | 'command_injection'
    | 'prompt_injection'
    | 'config_access'
    | 'rate_limit'
    | 'suspicious_activity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  details: Record<string, any>;
  userAgent?: string;
  ipAddress?: string;
}

export interface SecurityMetrics {
  totalEvents: number;
  criticalEvents: number;
  lastEventTime: string;
  topEventTypes: Record<string, number>;
  topSources: Record<string, number>;
}

export class SecurityMonitor {
  private static instance: SecurityMonitor;
  private logFile: string;
  private events: SecurityEvent[] = [];
  private maxEvents = 1000;

  private constructor() {
    // 使用固定的、安全的路径
    const baseDir = process.cwd();
    const logDir = join(baseDir, 'logs');

    // 确保路径在项目目录内
    if (logDir.startsWith(baseDir) && !existsSync(logDir)) {
      require('fs').mkdirSync(logDir, { recursive: true });
    }
    this.logFile = join(logDir, 'security.log');
  }

  static getInstance(): SecurityMonitor {
    if (!SecurityMonitor.instance) {
      SecurityMonitor.instance = new SecurityMonitor();
    }
    return SecurityMonitor.instance;
  }

  /**
   * 记录安全事件
   */
  logEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): void {
    const securityEvent: SecurityEvent = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    // 添加到内存中的事件队列
    this.events.push(securityEvent);

    // 保持事件队列大小
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // 写入日志文件
    this.writeToLogFile(securityEvent);

    // 触发警报（如果需要）
    if (this.shouldTriggerAlert(securityEvent)) {
      this.triggerAlert(securityEvent);
    }

    // 在开发环境中输出到控制台
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[SECURITY] ${securityEvent.type}: ${JSON.stringify(securityEvent.details)}`
      );
    }
  }

  /**
   * 获取安全指标
   */
  getMetrics(): SecurityMetrics {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const recentEvents = this.events.filter(
      (event) => new Date(event.timestamp) > oneHourAgo
    );

    const topEventTypes: Record<string, number> = {};
    const topSources: Record<string, number> = {};

    recentEvents.forEach((event) => {
      topEventTypes[event.type] = (topEventTypes[event.type] || 0) + 1;
      if (event.source) {
        topSources[event.source] = (topSources[event.source] || 0) + 1;
      }
    });

    return {
      totalEvents: recentEvents.length,
      criticalEvents: recentEvents.filter((e) => e.severity === 'critical').length,
      lastEventTime:
        recentEvents.length > 0
          ? recentEvents[recentEvents.length - 1].timestamp
          : new Date().toISOString(),
      topEventTypes,
      topSources,
    };
  }

  /**
   * 检测异常行为模式
   */
  detectAnomalies(): SecurityEvent[] {
    const anomalies: SecurityEvent[] = [];
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // 找到最近1小时的事件
    const recentEvents = this.events.filter(
      (event) => new Date(event.timestamp) > oneHourAgo
    );

    // 检测高频失败认证
    const authFailures = recentEvents.filter((event) => event.type === 'auth_failure');

    if (authFailures.length > 10) {
      anomalies.push({
        id: this.generateEventId(),
        timestamp: now.toISOString(),
        type: 'suspicious_activity',
        severity: 'high',
        source: 'SecurityMonitor',
        details: {
          pattern: 'High frequency authentication failures',
          count: authFailures.length,
          timeframe: '1 hour',
        },
      });
    }

    // 检测可疑的路径遍历尝试
    const pathTraversals = recentEvents.filter(
      (event) => event.type === 'path_traversal' && event.severity === 'high'
    );

    if (pathTraversals.length > 3) {
      anomalies.push({
        id: this.generateEventId(),
        timestamp: now.toISOString(),
        type: 'suspicious_activity',
        severity: 'critical',
        source: 'SecurityMonitor',
        details: {
          pattern: 'Multiple path traversal attempts',
          count: pathTraversals.length,
          timeframe: '1 hour',
        },
      });
    }

    // 检测提示词注入攻击
    const promptInjections = recentEvents.filter(
      (event) => event.type === 'prompt_injection' && event.severity === 'high'
    );

    if (promptInjections.length > 5) {
      anomalies.push({
        id: this.generateEventId(),
        timestamp: now.toISOString(),
        type: 'suspicious_activity',
        severity: 'high',
        source: 'SecurityMonitor',
        details: {
          pattern: 'Multiple prompt injection attempts',
          count: promptInjections.length,
          timeframe: '1 hour',
        },
      });
    }

    return anomalies;
  }

  /**
   * 生成安全报告
   */
  generateReport(): string {
    const metrics = this.getMetrics();
    const anomalies = this.detectAnomalies();

    let report = `=== Blade Security Report ===\n\n`;
    report += `Generated: ${new Date().toISOString()}\n\n`;

    report += `Security Metrics:\n`;
    report += `- Total Events (1h): ${metrics.totalEvents}\n`;
    report += `- Critical Events: ${metrics.criticalEvents}\n`;
    report += `- Last Event: ${metrics.lastEventTime}\n\n`;

    report += `Top Event Types:\n`;
    Object.entries(metrics.topEventTypes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .forEach(([type, count]) => {
        report += `- ${type}: ${count}\n`;
      });

    report += `\nTop Sources:\n`;
    Object.entries(metrics.topSources)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .forEach(([source, count]) => {
        report += `- ${source}: ${count}\n`;
      });

    if (anomalies.length > 0) {
      report += `\nDetected Anomalies:\n`;
      anomalies.forEach((anomaly) => {
        report += `- [${anomaly.severity.toUpperCase()}] ${anomaly.details.pattern} (${anomaly.details.count} occurrences)\n`;
      });
    }

    return report;
  }

  /**
   * 清理旧事件
   */
  cleanupOldEvents(hours = 24): void {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    this.events = this.events.filter((event) => new Date(event.timestamp) > cutoff);
  }

  /**
   * 导出事件数据
   */
  exportEvents(format: 'json' | 'csv' = 'json'): string {
    if (format === 'json') {
      return JSON.stringify(this.events, null, 2);
    } else {
      // CSV 格式
      const headers = ['id', 'timestamp', 'type', 'severity', 'source', 'details'];
      const rows = this.events.map((event) => [
        event.id,
        event.timestamp,
        event.type,
        event.severity,
        event.source,
        JSON.stringify(event.details),
      ]);

      return [
        headers.join(','),
        ...rows.map((row) => row.map((field) => `"${field}"`).join(',')),
      ].join('\n');
    }
  }

  /**
   * 生成事件ID
   */
  private generateEventId(): string {
    return createHash('sha256')
      .update(Date.now().toString() + Math.random().toString())
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * 写入日志文件
   */
  private writeToLogFile(event: SecurityEvent): void {
    try {
      const logEntry = JSON.stringify({
        ...event,
        // 避免日志文件中出现敏感信息
        details: this.sanitizeEventDetails(event.details),
      });

      // 确保日志文件路径在项目目录内
      const baseDir = process.cwd();
      if (this.logFile.startsWith(baseDir)) {
        appendFileSync(this.logFile, logEntry + '\n', { flag: 'a' });
      }
    } catch (error) {
      console.error('Failed to write security log:', error);
    }
  }

  /**
   * 脱敏事件详情
   */
  private sanitizeEventDetails(details: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(details)) {
      // 脱敏敏感字段
      if (
        ['password', 'token', 'key', 'secret', 'api', 'auth'].some((sensitive) =>
          key.toLowerCase().includes(sensitive)
        )
      ) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 1000) {
        // 截断过长的字符串
        sanitized[key] = value.substring(0, 1000) + '...';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 判断是否应该触发警报
   */
  private shouldTriggerAlert(event: SecurityEvent): boolean {
    // 关键事件总是触发警报
    if (event.severity === 'critical') {
      return true;
    }

    // 高风险事件在短时间内重复时触发警报
    if (event.severity === 'high') {
      const similarEvents = this.events.filter(
        (e) =>
          e.type === event.type &&
          e.source === event.source &&
          new Date(e.timestamp).getTime() > Date.now() - 5 * 60 * 1000 // 5分钟内
      );

      return similarEvents.length > 3;
    }

    return false;
  }

  /**
   * 触发警报
   */
  private triggerAlert(event: SecurityEvent): void {
    // 在实际应用中，这里可以：
    // 1. 发送邮件通知
    // 2. 发送到 Slack/Discord
    // 3. 写入专门的警报日志
    // 4. 调用外部告警系统

    console.error(
      `[SECURITY ALERT] Critical event detected: ${event.type} from ${event.source}`
    );

    // 在生产环境中，可能需要触发更严重的响应
    if (process.env.NODE_ENV === 'production') {
      // 可以集成外部告警系统
      // this.sendToExternalAlertSystem(event);
    }
  }

  /**
   * 获取特定类型的事件
   */
  getEventsByType(type: SecurityEvent['type'], limit = 50): SecurityEvent[] {
    return this.events
      .filter((event) => event.type === type)
      .slice(-limit)
      .reverse();
  }

  /**
   * 获取特定严重级别的事件
   */
  getEventsBySeverity(
    severity: SecurityEvent['severity'],
    limit = 50
  ): SecurityEvent[] {
    return this.events
      .filter((event) => event.severity === severity)
      .slice(-limit)
      .reverse();
  }
}

// 创建全局安全监控实例
export const securityMonitor = SecurityMonitor.getInstance();

// 安全事件工厂函数
export function createSecurityEvent(
  type: SecurityEvent['type'],
  severity: SecurityEvent['severity'],
  source: string,
  details: Record<string, any>
): SecurityEvent {
  return {
    id: securityMonitor['generateEventId'](),
    timestamp: new Date().toISOString(),
    type,
    severity,
    source,
    details,
  };
}
