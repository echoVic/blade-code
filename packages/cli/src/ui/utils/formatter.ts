/**
 * UI格式化工具函数
 */

import { UIStyles } from '../themes/styles.js';

export class UIFormatter {
  /**
   * 格式化文件大小
   */
  public static fileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  /**
   * 格式化时间间隔
   */
  public static duration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}天 ${hours % 24}小时`;
    } else if (hours > 0) {
      return `${hours}小时 ${minutes % 60}分钟`;
    } else if (minutes > 0) {
      return `${minutes}分钟 ${seconds % 60}秒`;
    } else {
      return `${seconds}秒`;
    }
  }

  /**
   * 格式化日期时间
   */
  public static dateTime(date: Date | string | number): string {
    const d = new Date(date);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /**
   * 格式化相对时间
   */
  public static relativeTime(date: Date | string | number): string {
    const now = new Date();
    const target = new Date(date);
    const diff = now.getTime() - target.getTime();

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}天前`;
    } else if (hours > 0) {
      return `${hours}小时前`;
    } else if (minutes > 0) {
      return `${minutes}分钟前`;
    } else if (seconds > 0) {
      return `${seconds}秒前`;
    } else {
      return '刚刚';
    }
  }

  /**
   * 格式化数字（添加千位分隔符）
   */
  public static number(num: number): string {
    return num.toLocaleString('zh-CN');
  }

  /**
   * 格式化百分比
   */
  public static percentage(value: number, total: number, decimals: number = 1): string {
    const percent = (value / total) * 100;
    return `${percent.toFixed(decimals)}%`;
  }

  /**
   * 格式化状态
   */
  public static status(
    status: 'success' | 'error' | 'warning' | 'info' | 'pending',
    text?: string
  ): string {
    const statusText = text || status;

    switch (status) {
      case 'success':
        return UIStyles.status.success(`✓ ${statusText}`);
      case 'error':
        return UIStyles.status.error(`✗ ${statusText}`);
      case 'warning':
        return UIStyles.status.warning(`⚠ ${statusText}`);
      case 'info':
        return UIStyles.status.info(`ℹ ${statusText}`);
      case 'pending':
        return UIStyles.status.muted(`◯ ${statusText}`);
      default:
        return statusText;
    }
  }

  /**
   * 格式化列表项
   */
  public static listItem(
    index: number,
    content: string,
    options: { style?: 'bullet' | 'number' | 'arrow'; indent?: number } = {}
  ): string {
    const opts = { style: 'bullet' as const, indent: 0, ...options };

    let prefix = '';
    switch (opts.style) {
      case 'number':
        prefix = UIStyles.status.muted(`${index + 1}. `);
        break;
      case 'arrow':
        prefix = UIStyles.status.muted('→ ');
        break;
      default:
        prefix = UIStyles.status.muted('• ');
        break;
    }

    const indent = ' '.repeat(opts.indent);
    return indent + prefix + content;
  }

  /**
   * 格式化键值对
   */
  public static keyValue(
    key: string,
    value: string,
    options: { separator?: string; keyWidth?: number } = {}
  ): string {
    const opts = { separator: ': ', keyWidth: 0, ...options };

    const formattedKey =
      opts.keyWidth > 0
        ? UIStyles.component.label(key.padEnd(opts.keyWidth))
        : UIStyles.component.label(key);

    return formattedKey + opts.separator + UIStyles.component.value(value);
  }

  /**
   * 格式化表格行
   */
  public static tableRow(
    values: string[],
    widths: number[],
    alignments: Array<'left' | 'center' | 'right'> = []
  ): string {
    return values
      .map((value, index) => {
        const width = widths[index] || 0;
        const align = alignments[index] || 'left';
        return this.alignText(value, width, align);
      })
      .join(' | ');
  }

  /**
   * 格式化代码块
   */
  public static codeBlock(code: string, language?: string): string {
    const lines = code.split('\n');
    const maxLineNumber = lines.length;
    const lineNumberWidth = maxLineNumber.toString().length;

    const formattedLines = lines.map((line, index) => {
      const lineNumber = (index + 1).toString().padStart(lineNumberWidth);
      const numberedLine = UIStyles.status.muted(`${lineNumber} │ `) + line;
      return numberedLine;
    });

    const header = language ? UIStyles.status.info(`[${language}]`) : '';

    return [
      header,
      UIStyles.border.line(
        Math.max(60, Math.max(...lines.map(l => l.length)) + lineNumberWidth + 3)
      ),
      ...formattedLines,
      UIStyles.border.line(
        Math.max(60, Math.max(...lines.map(l => l.length)) + lineNumberWidth + 3)
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 格式化JSON
   */
  public static json(obj: any, indent: number = 2): string {
    try {
      const json = JSON.stringify(obj, null, indent);
      return json
        .split('\n')
        .map(line => {
          // 简单的语法高亮
          if (line.includes(':')) {
            const [key, ...valueParts] = line.split(':');
            const value = valueParts.join(':');
            return key + ':' + UIStyles.status.success(value);
          }
          return line;
        })
        .join('\n');
    } catch (error) {
      return UIStyles.status.error('无效的JSON数据');
    }
  }

  /**
   * 文本截断
   */
  public static truncate(text: string, maxLength: number, suffix: string = '...'): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - suffix.length) + suffix;
  }

  /**
   * 文本对齐
   */
  private static alignText(
    text: string,
    width: number,
    align: 'left' | 'center' | 'right'
  ): string {
    if (text.length >= width) {
      return text.substring(0, width);
    }

    const padding = width - text.length;

    switch (align) {
      case 'center':
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
      case 'right':
        return ' '.repeat(padding) + text;
      default: // left
        return text + ' '.repeat(padding);
    }
  }

  /**
   * 单位转换
   */
  public static unit(value: number, unit: string, precision: number = 2): string {
    return `${value.toFixed(precision)} ${unit}`;
  }

  /**
   * 格式化URL
   */
  public static url(url: string, maxLength: number = 50): string {
    if (url.length <= maxLength) {
      return UIStyles.semantic.accent(url);
    }

    const truncated = this.truncate(url, maxLength);
    return UIStyles.semantic.accent(truncated);
  }

  /**
   * 格式化路径
   */
  public static path(path: string, maxLength: number = 60): string {
    if (path.length <= maxLength) {
      return UIStyles.status.muted(path);
    }

    // 智能截断：保留文件名和部分目录
    const parts = path.split('/');
    if (parts.length > 2) {
      const filename = parts[parts.length - 1];
      const remaining = maxLength - filename.length - 5; // 5 for ".../"

      if (remaining > 0) {
        const prefix = path.substring(0, remaining);
        return UIStyles.status.muted(`${prefix}.../${filename}`);
      }
    }

    return UIStyles.status.muted(this.truncate(path, maxLength));
  }
}
