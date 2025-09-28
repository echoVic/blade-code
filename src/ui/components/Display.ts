/**
 * UI显示组件
 * 统一管理所有输出展示功能
 */

import { UIStyles } from '../themes/styles.js';

export interface DisplayOptions {
  prefix?: string;
  suffix?: string;
  newline?: boolean;
  indent?: number;
}

export class UIDisplay {
  private static defaultOptions: DisplayOptions = {
    newline: true,
    indent: 0,
  };

  /**
   * 格式化输出文本
   */
  private static formatText(text: string, options: DisplayOptions = {}): string {
    const opts = { ...this.defaultOptions, ...options };

    let result = text;

    // 添加前缀
    if (opts.prefix) {
      result = opts.prefix + result;
    }

    // 添加后缀
    if (opts.suffix) {
      result = result + opts.suffix;
    }

    // 添加缩进
    if (opts.indent && opts.indent > 0) {
      const indent = ' '.repeat(opts.indent);
      result = indent + result.split('\n').join('\n' + indent);
    }

    return result;
  }

  /**
   * 输出文本
   */
  private static output(text: string, options: DisplayOptions = {}): void {
    const opts = { ...this.defaultOptions, ...options };
    const formatted = this.formatText(text, opts);

    if (opts.newline) {
      console.log(formatted);
    } else {
      process.stdout.write(formatted);
    }
  }

  /**
   * 成功消息
   */
  public static success(message: string, options?: DisplayOptions): void {
    const text = `${UIStyles.icon.success} ${UIStyles.status.success(message)}`;
    this.output(text, options);
  }

  /**
   * 错误消息
   */
  public static error(message: string, options?: DisplayOptions): void {
    const text = `${UIStyles.icon.error} ${UIStyles.status.error(message)}`;
    this.output(text, options);
  }

  /**
   * 警告消息
   */
  public static warning(message: string, options?: DisplayOptions): void {
    const text = `${UIStyles.icon.warning} ${UIStyles.status.warning(message)}`;
    this.output(text, options);
  }

  /**
   * 信息消息
   */
  public static info(message: string, options?: DisplayOptions): void {
    const text = `${UIStyles.icon.info} ${UIStyles.status.info(message)}`;
    this.output(text, options);
  }

  /**
   * 静默文本
   */
  public static muted(message: string, options?: DisplayOptions): void {
    const text = UIStyles.status.muted(message);
    this.output(text, options);
  }

  /**
   * 页面标题
   */
  public static header(title: string, options?: DisplayOptions): void {
    const text = `${UIStyles.icon.rocket} ${UIStyles.component.header(title)}`;
    this.output(text, options);
  }

  /**
   * 节标题
   */
  public static section(
    title: string,
    content?: string,
    options?: DisplayOptions
  ): void {
    const text = UIStyles.component.section(title);
    this.output(text, options);

    if (content) {
      this.output(content, { ...options, indent: 2 });
    }
  }

  /**
   * 键值对显示
   */
  public static keyValue(key: string, value: string, options?: DisplayOptions): void {
    const text = `${UIStyles.component.label(key)}: ${UIStyles.component.value(value)}`;
    this.output(text, options);
  }

  /**
   * 代码块显示
   */
  public static code(code: string, language?: string, options?: DisplayOptions): void {
    const prefix = language ? UIStyles.status.muted(`[${language}]`) + '\n' : '';
    const text = prefix + UIStyles.component.code(code);
    this.output(text, options);
  }

  /**
   * 引用文本
   */
  public static quote(text: string, author?: string, options?: DisplayOptions): void {
    const quote = UIStyles.component.quote(`"${text}"`);
    const attribution = author ? UIStyles.status.muted(` - ${author}`) : '';
    this.output(quote + attribution, options);
  }

  /**
   * 分隔线
   */
  public static separator(length: number = 50, double: boolean = false): void {
    const line = double
      ? UIStyles.border.doubleLine(length)
      : UIStyles.border.line(length);
    this.output(line);
  }

  /**
   * 空行
   */
  public static newline(count: number = 1): void {
    for (let i = 0; i < count; i++) {
      console.log();
    }
  }

  /**
   * 清屏
   */
  public static clear(): void {
    console.clear();
  }

  /**
   * 普通输出
   */
  public static text(message: string, options?: DisplayOptions): void {
    this.output(message, options);
  }

  /**
   * 高亮文本
   */
  public static highlight(message: string, options?: DisplayOptions): void {
    const text = UIStyles.semantic.highlight(message);
    this.output(text, options);
  }

  /**
   * 步骤提示
   */
  public static step(
    step: number,
    total: number,
    message: string,
    options?: DisplayOptions
  ): void {
    const stepText = UIStyles.status.info(`[${step}/${total}]`);
    const text = `${stepText} ${message}`;
    this.output(text, options);
  }
}
