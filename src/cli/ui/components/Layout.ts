/**
 * UI布局组件
 * 用于页面结构和版面管理
 */

import { UIStyles } from '../themes/styles.js';
import { UIDisplay } from './Display.js';

export interface LayoutOptions {
  width?: number;
  padding?: number;
  margin?: number;
  border?: boolean;
  title?: string;
}

export interface BoxOptions extends LayoutOptions {
  style?: 'single' | 'double' | 'rounded' | 'bold';
  align?: 'left' | 'center' | 'right';
}

export class UILayout {
  /**
   * 创建页面头部
   */
  public static header(title: string, subtitle?: string, options: LayoutOptions = {}): void {
    const opts = { width: 80, padding: 2, border: true, ...options };

    UIDisplay.newline();

    if (opts.border) {
      UIDisplay.text(UIStyles.border.doubleLine(opts.width));
    }

    // 主标题
    const centeredTitle = this.centerText(title, opts.width);
    UIDisplay.text(UIStyles.heading.h1(centeredTitle));

    // 副标题
    if (subtitle) {
      const centeredSubtitle = this.centerText(subtitle, opts.width);
      UIDisplay.text(UIStyles.heading.h2(centeredSubtitle));
    }

    if (opts.border) {
      UIDisplay.text(UIStyles.border.doubleLine(opts.width));
    }

    UIDisplay.newline();
  }

  /**
   * 创建页面尾部
   */
  public static footer(content: string, options: LayoutOptions = {}): void {
    const opts = { width: 80, border: true, ...options };

    UIDisplay.newline();

    if (opts.border) {
      UIDisplay.text(UIStyles.border.line(opts.width));
    }

    const centeredContent = this.centerText(content, opts.width);
    UIDisplay.text(UIStyles.status.muted(centeredContent));

    if (opts.border) {
      UIDisplay.text(UIStyles.border.line(opts.width));
    }
  }

  /**
   * 创建侧边栏布局
   */
  public static sidebar(
    sidebarContent: string[],
    mainContent: string[],
    options: { sidebarWidth?: number; totalWidth?: number } = {}
  ): void {
    const opts = { sidebarWidth: 20, totalWidth: 80, ...options };
    const mainWidth = opts.totalWidth - opts.sidebarWidth - 3; // 3 for separator

    const maxLines = Math.max(sidebarContent.length, mainContent.length);

    for (let i = 0; i < maxLines; i++) {
      const sidebar = (sidebarContent[i] || '').padEnd(opts.sidebarWidth);
      const main = mainContent[i] || '';

      UIDisplay.text(`${UIStyles.status.muted(sidebar)} │ ${main}`);
    }
  }

  /**
   * 创建分栏布局
   */
  public static columns(
    columns: string[][],
    options: { columnWidths?: number[]; totalWidth?: number } = {}
  ): void {
    const opts = { totalWidth: 80, ...options };
    const colCount = columns.length;

    // 计算列宽
    const columnWidths =
      opts.columnWidths ||
      Array(colCount).fill(Math.floor((opts.totalWidth - (colCount - 1) * 3) / colCount));

    const maxLines = Math.max(...columns.map(col => col.length));

    for (let i = 0; i < maxLines; i++) {
      const line = columns
        .map((col, colIndex) => {
          const content = col[i] || '';
          const width = columnWidths[colIndex];
          return content.padEnd(width).substring(0, width);
        })
        .join(' │ ');

      UIDisplay.text(line);
    }
  }

  /**
   * 创建框框
   */
  public static box(content: string | string[], options: BoxOptions = {}): void {
    const opts = {
      width: 60,
      padding: 1,
      style: 'single' as const,
      align: 'left' as const,
      ...options,
    };

    const lines = Array.isArray(content) ? content : content.split('\n');
    const boxChars = this.getBoxChars(opts.style);

    // 计算内容宽度
    const contentWidth = opts.width - 2 - opts.padding * 2;

    // 顶部边框
    UIDisplay.text(
      boxChars.topLeft + boxChars.horizontal.repeat(opts.width - 2) + boxChars.topRight
    );

    // 上边距
    for (let i = 0; i < opts.padding; i++) {
      UIDisplay.text(boxChars.vertical + ' '.repeat(opts.width - 2) + boxChars.vertical);
    }

    // 内容行
    lines.forEach(line => {
      const trimmedLine = line.substring(0, contentWidth);
      const alignedLine = this.alignText(trimmedLine, contentWidth, opts.align);

      UIDisplay.text(
        boxChars.vertical +
          ' '.repeat(opts.padding) +
          alignedLine +
          ' '.repeat(opts.padding) +
          boxChars.vertical
      );
    });

    // 下边距
    for (let i = 0; i < opts.padding; i++) {
      UIDisplay.text(boxChars.vertical + ' '.repeat(opts.width - 2) + boxChars.vertical);
    }

    // 底部边框
    UIDisplay.text(
      boxChars.bottomLeft + boxChars.horizontal.repeat(opts.width - 2) + boxChars.bottomRight
    );
  }

  /**
   * 创建卡片布局
   */
  public static card(
    title: string,
    content: string | string[],
    options: BoxOptions & { icon?: string } = {}
  ): void {
    const lines = Array.isArray(content) ? content : content.split('\n');

    // 添加标题到内容
    const cardContent = [
      options.icon ? `${options.icon} ${title}` : title,
      UIStyles.border.line(Math.min(title.length + (options.icon ? 3 : 0), 40)),
      '',
      ...lines,
    ];

    this.box(cardContent, {
      ...options,
      align: 'left',
    });
  }

  /**
   * 创建网格布局
   */
  public static grid(
    items: string[],
    options: { columns?: number; cellWidth?: number; spacing?: number } = {}
  ): void {
    const opts = { columns: 3, cellWidth: 20, spacing: 2, ...options };

    for (let i = 0; i < items.length; i += opts.columns) {
      const row = items.slice(i, i + opts.columns);
      const line = row
        .map(item => {
          return item.padEnd(opts.cellWidth).substring(0, opts.cellWidth);
        })
        .join(' '.repeat(opts.spacing));

      UIDisplay.text(line);
    }
  }

  /**
   * 创建面板
   */
  public static panel(
    sections: Array<{ title: string; content: string | string[] }>,
    options: LayoutOptions = {}
  ): void {
    const opts = { width: 80, padding: 1, border: true, ...options };

    sections.forEach((section, index) => {
      if (index > 0) {
        UIDisplay.newline();
      }

      // 节标题
      UIDisplay.section(section.title);

      // 节内容
      const lines = Array.isArray(section.content) ? section.content : [section.content];
      lines.forEach(line => {
        UIDisplay.text(line, { indent: 2 });
      });
    });
  }

  /**
   * 居中文本
   */
  private static centerText(text: string, width: number): string {
    const padding = Math.max(0, width - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
  }

  /**
   * 对齐文本
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
   * 获取边框字符
   */
  private static getBoxChars(style: 'single' | 'double' | 'rounded' | 'bold'): {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
  } {
    switch (style) {
      case 'double':
        return {
          topLeft: '╔',
          topRight: '╗',
          bottomLeft: '╚',
          bottomRight: '╝',
          horizontal: '═',
          vertical: '║',
        };
      case 'rounded':
        return {
          topLeft: '╭',
          topRight: '╮',
          bottomLeft: '╰',
          bottomRight: '╯',
          horizontal: '─',
          vertical: '│',
        };
      case 'bold':
        return {
          topLeft: '┏',
          topRight: '┓',
          bottomLeft: '┗',
          bottomRight: '┛',
          horizontal: '━',
          vertical: '┃',
        };
      default: // single
        return {
          topLeft: '┌',
          topRight: '┐',
          bottomLeft: '└',
          bottomRight: '┘',
          horizontal: '─',
          vertical: '│',
        };
    }
  }

  /**
   * 创建分隔器
   */
  public static divider(
    text?: string,
    options: {
      width?: number;
      style?: 'single' | 'double';
      align?: 'left' | 'center' | 'right';
    } = {}
  ): void {
    const opts = { width: 80, style: 'single' as const, align: 'center' as const, ...options };

    if (!text) {
      const line = opts.style === 'double' ? '═' : '─';
      UIDisplay.text(UIStyles.status.muted(line.repeat(opts.width)));
      return;
    }

    const line = opts.style === 'double' ? '═' : '─';
    const availableWidth = opts.width - text.length - 2; // 2 for spaces around text

    if (availableWidth <= 0) {
      UIDisplay.text(UIStyles.status.muted(text));
      return;
    }

    let leftPadding: number;
    let rightPadding: number;

    switch (opts.align) {
      case 'left':
        leftPadding = 0;
        rightPadding = availableWidth;
        break;
      case 'right':
        leftPadding = availableWidth;
        rightPadding = 0;
        break;
      default: // center
        leftPadding = Math.floor(availableWidth / 2);
        rightPadding = availableWidth - leftPadding;
        break;
    }

    const result =
      UIStyles.status.muted(line.repeat(leftPadding)) +
      ' ' +
      UIStyles.status.info(text) +
      ' ' +
      UIStyles.status.muted(line.repeat(rightPadding));

    UIDisplay.text(result);
  }
}
