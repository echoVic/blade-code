/**
 * UI动画组件
 * 提供各种视觉动画效果
 */

import chalk from 'chalk';
import { UIColors } from '../themes/colors.js';

export interface AnimationConfig {
  duration?: number;
  interval?: number;
  repeat?: number | 'infinite';
  direction?: 'forward' | 'reverse' | 'alternate';
}

export interface TypewriterConfig extends AnimationConfig {
  speed?: number;
  cursor?: boolean;
  cursorChar?: string;
}

export interface PulseConfig extends AnimationConfig {
  colors?: string[];
  intensity?: number;
}

/**
 * 动画效果组件
 */
export class UIAnimation {
  private static readonly defaultConfig: AnimationConfig = {
    duration: 1000,
    interval: 100,
    repeat: 1,
    direction: 'forward',
  };

  /**
   * 打字机效果
   */
  public static async typewriter(
    text: string,
    config: TypewriterConfig = {}
  ): Promise<void> {
    const opts = {
      speed: 50,
      cursor: true,
      cursorChar: '▋',
      ...this.defaultConfig,
      ...config,
    };

    return new Promise((resolve) => {
      let index = 0;
      const timer = setInterval(() => {
        // 清除当前行
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');

        // 显示当前文本
        const currentText = text.slice(0, index);
        const cursor = opts.cursor && index < text.length ? opts.cursorChar : '';
        process.stdout.write(currentText + cursor);

        index++;

        if (index > text.length) {
          clearInterval(timer);
          if (!opts.cursor) {
            process.stdout.write('\r');
            process.stdout.write(' '.repeat(process.stdout.columns || 80));
            process.stdout.write('\r');
            process.stdout.write(text);
          }
          console.log(); // 换行
          resolve();
        }
      }, opts.speed);
    });
  }

  /**
   * 脉冲效果
   */
  public static pulse(
    text: string,
    config: PulseConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = {
      ...this.defaultConfig,
      colors: [UIColors.primary, UIColors.secondary],
      ...config,
    };

    let timer: any = null;
    let colorIndex = 0;

    const start = () => {
      timer = setInterval(() => {
        process.stdout.write('\r');

        const color = opts.colors![colorIndex % opts.colors!.length];
        process.stdout.write(chalk.hex(color)(text));

        colorIndex++;
      }, opts.interval!);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');
        console.log(text);
      }
    };

    return { start, stop };
  }

  /**
   * 波浪效果
   */
  public static wave(
    text: string,
    config: AnimationConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = { ...this.defaultConfig, ...config };
    let timer: any = null;
    let frame = 0;

    const start = () => {
      timer = setInterval(() => {
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');

        const waveText = text
          .split('')
          .map((char, index) => {
            const offset = Math.sin((frame + index) * 0.5) * 2;
            const spaces = ' '.repeat(Math.max(0, Math.floor(offset)));
            return spaces + char;
          })
          .join('');

        process.stdout.write(chalk.hex(UIColors.primary)(waveText));
        frame++;
      }, opts.interval!);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');
        console.log(text);
      }
    };

    return { start, stop };
  }

  /**
   * 彩虹效果
   */
  public static rainbow(
    text: string,
    config: AnimationConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = { ...this.defaultConfig, ...config };
    let timer: any = null;
    let offset = 0;

    const colors = [
      UIColors.error, // 红
      UIColors.warning, // 黄
      UIColors.success, // 绿
      UIColors.info, // 青
      UIColors.primary, // 蓝
      UIColors.muted, // 紫
    ];

    const start = () => {
      timer = setInterval(() => {
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');

        const rainbowText = text
          .split('')
          .map((char, index) => {
            const colorIndex = (index + offset) % colors.length;
            return chalk.hex(colors[colorIndex])(char);
          })
          .join('');

        process.stdout.write(rainbowText);
        offset++;
      }, opts.interval!);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');
        console.log(text);
      }
    };

    return { start, stop };
  }

  /**
   * 矩阵雨效果（简化版）
   */
  public static matrix(
    lines: number = 10,
    config: AnimationConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = {
      duration: 5000,
      interval: 100,
      ...config,
    };

    let timer: any = null;
    const chars = '0123456789ABCDEF';
    const matrixLines: string[] = [];

    const start = () => {
      // 初始化
      for (let i = 0; i < lines; i++) {
        matrixLines[i] = '';
      }

      timer = setInterval(() => {
        // 清屏
        console.clear();

        // 更新每一行
        for (let i = 0; i < lines; i++) {
          if (Math.random() < 0.1) {
            // 生成新的随机字符串
            const length = Math.floor(Math.random() * 20) + 10;
            matrixLines[i] = Array(length)
              .fill(0)
              .map(() => chars[Math.floor(Math.random() * chars.length)])
              .join('');
          }

          // 显示行
          if (matrixLines[i]) {
            console.log(chalk.hex(UIColors.success)(matrixLines[i]));
          }
        }
      }, opts.interval!);

      // 自动停止
      if (opts.duration && opts.duration > 0) {
        setTimeout(() => stop(), opts.duration);
      }
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        console.clear();
      }
    };

    return { start, stop };
  }

  /**
   * 滚动文本效果
   */
  public static scroll(
    texts: string[],
    config: AnimationConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = {
      interval: 500,
      repeat: 'infinite' as const,
      ...config,
    };

    let timer: any = null;
    let index = 0;

    const start = () => {
      timer = setInterval(() => {
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');

        const currentText = texts[index % texts.length];
        process.stdout.write(chalk.hex(UIColors.primary)(currentText));

        index++;

        if (
          opts.repeat !== 'infinite' &&
          index >= texts.length * (opts.repeat as number)
        ) {
          stop();
        }
      }, opts.interval!);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');
        console.log();
      }
    };

    return { start, stop };
  }

  /**
   * 闪烁效果
   */
  public static blink(
    text: string,
    config: AnimationConfig = {}
  ): { start: () => void; stop: () => void } {
    const opts = { ...this.defaultConfig, ...config };
    let timer: any = null;
    let visible = true;

    const start = () => {
      timer = setInterval(() => {
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');

        if (visible) {
          process.stdout.write(chalk.hex(UIColors.primary)(text));
        }

        visible = !visible;
      }, opts.interval!);
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write('\r');
        process.stdout.write(' '.repeat(process.stdout.columns || 80));
        process.stdout.write('\r');
        console.log(text);
      }
    };

    return { start, stop };
  }

  /**
   * 淡入效果（模拟）
   */
  public static async fadeIn(
    text: string,
    config: AnimationConfig = {}
  ): Promise<void> {
    const opts = {
      duration: 1000,
      ...config,
    };

    const steps = 10;
    const stepDuration = opts.duration! / steps;

    for (let i = 0; i <= steps; i++) {
      process.stdout.write('\r');
      process.stdout.write(' '.repeat(process.stdout.columns || 80));
      process.stdout.write('\r');

      // 模拟透明度效果（使用不同的灰度）
      const opacity = i / steps;
      const grayValue = Math.floor(128 + 127 * opacity);
      const fadeText = `\x1b[38;2;${grayValue};${grayValue};${grayValue}m${text}\x1b[0m`;

      process.stdout.write(chalk.hex(UIColors.primary)(fadeText));

      await new Promise((resolve) => setTimeout(resolve, stepDuration));
    }

    console.log(); // 换行
  }
}
