/**
 * UI列表组件
 * 统一管理列表数据的显示
 */

import { UIStyles } from '../themes/styles.js';
import { UIDisplay } from './Display.js';

export interface ListItem {
  label: string;
  value?: string;
  description?: string;
  status?: 'success' | 'error' | 'warning' | 'info';
  icon?: string;
  indent?: number;
}

export interface TableColumn {
  key: string;
  title: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  format?: (value: any) => string;
}

export interface ListOptions {
  showNumbers?: boolean;
  showBullets?: boolean;
  indent?: number;
  separator?: string;
}

export class UIList {
  /**
   * 显示项目符号列表
   */
  public static bullets(items: string[], options: ListOptions = {}): void {
    this.simple(items, { ...options, showBullets: true });
  }

  /**
   * 显示简单列表
   */
  public static simple(items: string[], options: ListOptions = {}): void {
    const opts = {
      showNumbers: false,
      showBullets: true,
      indent: 0,
      separator: '',
      ...options,
    };

    items.forEach((item, index) => {
      let prefix = '';

      if (opts.showNumbers) {
        prefix = UIStyles.status.muted(`${index + 1}. `);
      } else if (opts.showBullets) {
        prefix = UIStyles.status.muted('• ');
      }

      const text = prefix + item;
      UIDisplay.text(text, { indent: opts.indent });

      if (opts.separator && index < items.length - 1) {
        UIDisplay.text(opts.separator);
      }
    });
  }

  /**
   * 显示详细列表
   */
  public static detailed(items: ListItem[], options: ListOptions = {}): void {
    const opts = {
      showNumbers: false,
      showBullets: false,
      indent: 0,
      ...options,
    };

    items.forEach((item, index) => {
      const indent = (item.indent || 0) + opts.indent;

      // 构建前缀
      let prefix = '';
      if (opts.showNumbers) {
        prefix = UIStyles.status.muted(`${index + 1}. `);
      } else if (opts.showBullets) {
        prefix = UIStyles.status.muted('• ');
      }

      // 添加图标
      if (item.icon) {
        prefix += item.icon + ' ';
      }

      // 添加状态图标
      if (item.status) {
        switch (item.status) {
          case 'success':
            prefix += UIStyles.icon.success + ' ';
            break;
          case 'error':
            prefix += UIStyles.icon.error + ' ';
            break;
          case 'warning':
            prefix += UIStyles.icon.warning + ' ';
            break;
          case 'info':
            prefix += UIStyles.icon.info + ' ';
            break;
        }
      }

      // 主标签
      let text = prefix + UIStyles.component.label(item.label);

      // 添加值
      if (item.value) {
        text += ': ' + UIStyles.component.value(item.value);
      }

      UIDisplay.text(text, { indent });

      // 添加描述
      if (item.description) {
        const descText = UIStyles.status.muted(item.description);
        UIDisplay.text(descText, { indent: indent + 2 });
      }
    });
  }

  /**
   * 显示键值对列表
   */
  public static keyValue(data: Record<string, string>, options: ListOptions = {}): void {
    const items: ListItem[] = Object.entries(data).map(([key, value]) => ({
      label: key,
      value: value,
    }));

    this.detailed(items, options);
  }

  /**
   * 显示表格
   */
  public static table(data: any[], columns: TableColumn[]): void {
    if (data.length === 0) {
      UIDisplay.muted('没有数据');
      return;
    }

    // 计算列宽
    const colWidths = columns.map(col => {
      const headerWidth = col.title.length;
      const dataWidth = Math.max(
        ...data.map(row => {
          const value = row[col.key];
          const formatted = col.format ? col.format(value) : String(value || '');
          return formatted.length;
        })
      );
      return Math.max(headerWidth, dataWidth, col.width || 0);
    });

    // 显示表头
    const header = columns
      .map((col, i) => {
        const title = UIStyles.text.bold(col.title);
        const align = col.align || 'left';
        return this.alignText(title, colWidths[i], align);
      })
      .join(' | ');

    UIDisplay.text(header);

    // 显示分隔线
    const separator = colWidths.map(width => '─'.repeat(width)).join('─┼─');
    UIDisplay.muted('─' + separator + '─');

    // 显示数据行
    data.forEach(row => {
      const line = columns
        .map((col, i) => {
          const value = row[col.key];
          const formatted = col.format ? col.format(value) : String(value || '');
          const align = col.align || 'left';
          return this.alignText(formatted, colWidths[i], align);
        })
        .join(' | ');

      UIDisplay.text(line);
    });
  }

  /**
   * 显示树形结构
   */
  public static tree(
    items: any[],
    options: {
      childrenKey?: string;
      labelKey?: string;
      showConnectors?: boolean;
    } = {}
  ): void {
    const opts = {
      childrenKey: 'children',
      labelKey: 'label',
      showConnectors: true,
      ...options,
    };

    const renderNode = (node: any, prefix: string = '', isLast: boolean = true) => {
      const label = typeof node === 'string' ? node : node[opts.labelKey];
      const connector = opts.showConnectors ? (isLast ? '└── ' : '├── ') : '';

      UIDisplay.text(prefix + connector + label);

      const children = typeof node === 'object' ? node[opts.childrenKey] : null;
      if (children && Array.isArray(children)) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        children.forEach((child, index) => {
          const isLastChild = index === children.length - 1;
          renderNode(child, newPrefix, isLastChild);
        });
      }
    };

    items.forEach((item, index) => {
      const isLast = index === items.length - 1;
      renderNode(item, '', isLast);
    });
  }

  /**
   * 显示状态列表
   */
  public static status(
    items: Array<{ name: string; status: 'success' | 'error' | 'warning' | 'pending' }>
  ): void {
    const maxLength = Math.max(...items.map(item => item.name.length));

    items.forEach(item => {
      const name = item.name.padEnd(maxLength);
      let statusText = '';

      switch (item.status) {
        case 'success':
          statusText = UIStyles.status.success('✓ 成功');
          break;
        case 'error':
          statusText = UIStyles.status.error('✗ 失败');
          break;
        case 'warning':
          statusText = UIStyles.status.warning('⚠ 警告');
          break;
        case 'pending':
          statusText = UIStyles.status.muted('◯ 等待');
          break;
      }

      UIDisplay.text(`${UIStyles.component.label(name)} ${statusText}`);
    });
  }

  /**
   * 文本对齐助手
   */
  private static alignText(
    text: string,
    width: number,
    align: 'left' | 'center' | 'right'
  ): string {
    const plainText = text.replace(/\x1b\[[0-9;]*m/g, ''); // 移除ANSI颜色代码计算长度
    const padding = Math.max(0, width - plainText.length);

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
   * 分页显示
   */
  public static paginated(items: string[], pageSize: number = 10): void {
    if (items.length <= pageSize) {
      this.simple(items);
      return;
    }

    const totalPages = Math.ceil(items.length / pageSize);
    const currentPage = 0;

    const showPage = () => {
      const start = currentPage * pageSize;
      const end = Math.min(start + pageSize, items.length);
      const pageItems = items.slice(start, end);

      UIDisplay.clear();
      UIDisplay.header(`第 ${currentPage + 1} 页，共 ${totalPages} 页`);
      UIDisplay.newline();
      this.simple(pageItems, { showNumbers: true });
      UIDisplay.newline();
      UIDisplay.muted(`显示 ${start + 1}-${end} 项，共 ${items.length} 项`);
    };

    // 这里可以添加交互式分页逻辑
    showPage();
  }
}
