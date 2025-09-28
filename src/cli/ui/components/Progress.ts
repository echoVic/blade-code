/**
 * UI进度组件
 * 用于显示加载和进度状态
 */

import { UIStyles } from '../themes/styles.js';
import { UIDisplay } from './Display.js';

export interface SpinnerOptions {
  text?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  interval?: number;
}

export interface ProgressBarOptions {
  width?: number;
  format?: string;
  complete?: string;
  incomplete?: string;
  renderThrottle?: number;
}

export class UIProgress {
  private static spinners = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    line: ['|', '/', '-', '\\'],
    arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    bounce: ['⠁', '⠂', '⠄', '⠂'],
    pulse: ['●', '◐', '◑', '◒', '◓', '◔', '◕', '◖', '◗', '◘'],
  };

  /**
   * 创建旋转加载器
   */
  public static spinner(text: string = '加载中...', options: SpinnerOptions = {}): Spinner {
    return new Spinner(text, options);
  }

  /**
   * 创建进度条
   */
  public static progressBar(total: number, options: ProgressBarOptions = {}): ProgressBar {
    return new ProgressBar(total, options);
  }

  /**
   * 显示步骤进度
   */
  public static step(current: number, total: number, message: string): void {
    const percentage = Math.round((current / total) * 100);
    const progress = this.createProgressBar(percentage, 30);

    UIDisplay.text(
      `${UIStyles.status.info(`[${current}/${total}]`)} ${progress} ${percentage}% - ${message}`
    );
  }

  /**
   * 显示带时间的进度
   */
  public static timedStep(
    current: number,
    total: number,
    message: string,
    startTime: number
  ): void {
    const elapsed = Date.now() - startTime;
    const rate = current / (elapsed / 1000);
    const eta = rate > 0 ? Math.round((total - current) / rate) : 0;

    const percentage = Math.round((current / total) * 100);
    const progress = this.createProgressBar(percentage, 20);

    const timeInfo = `${this.formatTime(elapsed)} | ETA: ${this.formatTime(eta * 1000)}`;

    UIDisplay.text(
      `${UIStyles.status.info(`[${current}/${total}]`)} ${progress} ${percentage}% - ${message} (${UIStyles.status.muted(timeInfo)})`
    );
  }

  /**
   * 创建简单的进度条字符串
   */
  private static createProgressBar(percentage: number, width: number = 20): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;

    const filledBar = UIStyles.status.success('█'.repeat(filled));
    const emptyBar = UIStyles.status.muted('░'.repeat(empty));

    return `[${filledBar}${emptyBar}]`;
  }

  /**
   * 格式化时间
   */
  private static formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * 倒计时
   */
  public static countdown(seconds: number, message: string = '倒计时'): Promise<void> {
    return new Promise(resolve => {
      let remaining = seconds;

      const timer = setInterval(() => {
        process.stdout.write(`\r${message}: ${UIStyles.status.warning(remaining.toString())}s `);

        remaining--;

        if (remaining < 0) {
          clearInterval(timer);
          process.stdout.write('\r');
          UIDisplay.success('倒计时完成！');
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * 模拟加载过程
   */
  public static async simulate(duration: number, message: string = '处理中'): Promise<void> {
    const steps = 20;
    const stepDuration = duration / steps;

    for (let i = 0; i <= steps; i++) {
      const percentage = Math.round((i / steps) * 100);
      const progress = this.createProgressBar(percentage);

      process.stdout.write(`\r${message}: ${progress} ${percentage}%`);

      if (i < steps) {
        await new Promise(resolve => setTimeout(resolve, stepDuration));
      }
    }

    process.stdout.write('\n');
    UIDisplay.success('完成！');
  }
}

/**
 * 旋转加载器类
 */
export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private frames: string[];
  private text: string;
  private options: SpinnerOptions;

  constructor(text: string, options: SpinnerOptions = {}) {
    this.text = text;
    this.options = {
      color: 'blue',
      interval: 100,
      ...options,
    };
    this.frames = UIProgress['spinners'].dots;
  }

  /**
   * 开始旋转
   */
  public start(): void {
    if (this.interval) {
      this.stop();
    }

    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex];
      const coloredFrame = this.colorize(frame);
      process.stdout.write(`\r${coloredFrame} ${this.text}`);

      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, this.options.interval);
  }

  /**
   * 停止旋转
   */
  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write('\r');
    }
  }

  /**
   * 更新文本
   */
  public updateText(text: string): void {
    this.text = text;
  }

  /**
   * 成功完成
   */
  public succeed(text?: string): void {
    this.stop();
    UIDisplay.success(text || this.text);
  }

  /**
   * 失败
   */
  public fail(text?: string): void {
    this.stop();
    UIDisplay.error(text || this.text);
  }

  /**
   * 警告
   */
  public warn(text?: string): void {
    this.stop();
    UIDisplay.warning(text || this.text);
  }

  /**
   * 信息
   */
  public info(text?: string): void {
    this.stop();
    UIDisplay.info(text || this.text);
  }

  /**
   * 颜色化框架
   */
  private colorize(frame: string): string {
    switch (this.options.color) {
      case 'green':
        return UIStyles.status.success(frame);
      case 'yellow':
        return UIStyles.status.warning(frame);
      case 'red':
        return UIStyles.status.error(frame);
      case 'gray':
        return UIStyles.status.muted(frame);
      default:
        return UIStyles.status.info(frame);
    }
  }
}

/**
 * 进度条类
 */
export class ProgressBar {
  private current = 0;
  private total: number;
  private options: ProgressBarOptions;
  private startTime: number;

  constructor(total: number, options: ProgressBarOptions = {}) {
    this.total = total;
    this.options = {
      width: 40,
      format: '{bar} {percentage}% | {current}/{total} | {eta}',
      complete: '█',
      incomplete: '░',
      renderThrottle: 16,
      ...options,
    };
    this.startTime = Date.now();
  }

  /**
   * 更新进度
   */
  public update(value: number): void {
    this.current = Math.min(value, this.total);
    this.render();
  }

  /**
   * 增加进度
   */
  public increment(delta: number = 1): void {
    this.update(this.current + delta);
  }

  /**
   * 渲染进度条
   */
  private render(): void {
    const percentage = Math.round((this.current / this.total) * 100);
    const elapsed = Date.now() - this.startTime;
    const rate = this.current / (elapsed / 1000);
    const eta = rate > 0 ? Math.round((this.total - this.current) / rate) : 0;

    // 创建进度条
    const filledWidth = Math.round((this.current / this.total) * this.options.width!);
    const emptyWidth = this.options.width! - filledWidth;

    const filledBar = UIStyles.status.success(this.options.complete!.repeat(filledWidth));
    const emptyBar = UIStyles.status.muted(this.options.incomplete!.repeat(emptyWidth));
    const bar = `[${filledBar}${emptyBar}]`;

    // 替换格式字符串
    const output = this.options
      .format!.replace('{bar}', bar)
      .replace('{percentage}', percentage.toString())
      .replace('{current}', this.current.toString())
      .replace('{total}', this.total.toString())
      .replace('{eta}', this.formatTime(eta * 1000));

    process.stdout.write(`\r${output}`);

    if (this.current >= this.total) {
      process.stdout.write('\n');
    }
  }

  /**
   * 完成进度条
   */
  public complete(): void {
    this.update(this.total);
    UIDisplay.success('完成！');
  }

  /**
   * 格式化时间
   */
  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
