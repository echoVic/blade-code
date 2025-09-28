/**
 * UI输入组件
 * 统一管理所有用户交互输入功能
 */

import inquirer from 'inquirer';
import { UIStyles } from '../themes/styles.js';

export interface Choice {
  name: string;
  value: any;
  short?: string;
  disabled?: boolean | string;
}

export interface TextInputOptions {
  default?: string;
  validate?: (input: string) => boolean | string | Promise<boolean | string>;
  filter?: (input: string) => string | Promise<string>;
  transformer?: (input: string, answers: any, flags: any) => string;
  when?: boolean | ((answers: any) => boolean | Promise<boolean>);
}

export interface SelectOptions {
  default?: any;
  pageSize?: number;
  loop?: boolean;
  when?: boolean | ((answers: any) => boolean | Promise<boolean>);
}

export interface ConfirmOptions {
  default?: boolean;
  when?: boolean | ((answers: any) => boolean | Promise<boolean>);
}

export class UIInput {
  /**
   * 文本输入
   */
  public static async text(
    message: string,
    options: TextInputOptions = {}
  ): Promise<string> {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: UIStyles.component.label(message),
        ...options,
      } as any,
    ]);
    return answers.value;
  }

  /**
   * 密码输入
   */
  public static async password(
    message: string,
    options: Omit<TextInputOptions, 'transformer'> = {}
  ): Promise<string> {
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'value',
        message: UIStyles.component.label(message),
        mask: '*',
        ...options,
      },
    ]);
    return answers.value;
  }

  /**
   * 确认输入
   */
  public static async confirm(
    message: string,
    options: ConfirmOptions = {}
  ): Promise<boolean> {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'value',
        message: UIStyles.component.label(message),
        default: false,
        ...options,
      },
    ]);
    return answers.value;
  }

  /**
   * 单选列表
   */
  public static async select(
    message: string,
    choices: Choice[],
    options: SelectOptions = {}
  ): Promise<any> {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'value',
        message: UIStyles.component.label(message),
        choices: choices.map((choice) => ({
          name: choice.name,
          value: choice.value,
          short: choice.short || choice.name,
          disabled: choice.disabled,
        })),
        pageSize: 10,
        ...options,
      },
    ]);
    return answers.value;
  }

  /**
   * 多选列表
   */
  public static async multiSelect(
    message: string,
    choices: Choice[],
    options: SelectOptions = {}
  ): Promise<any[]> {
    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'value',
        message: UIStyles.component.label(message),
        choices: choices.map((choice) => ({
          name: choice.name,
          value: choice.value,
          checked: false,
          disabled: choice.disabled,
        })),
        pageSize: 10,
        ...options,
      },
    ]);
    return answers.value;
  }

  /**
   * 自动完成输入
   */
  public static async autocomplete(
    message: string,
    source: (answersSoFar: any, input: string) => Promise<string[]>
  ): Promise<string> {
    const answers = await inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'value',
        message: UIStyles.component.label(message),
        source,
      } as any, // 需要额外的插件支持
    ]);
    return answers.value;
  }

  /**
   * 数字输入
   */
  public static async number(
    message: string,
    options: TextInputOptions & { min?: number; max?: number } = {}
  ): Promise<number> {
    const { min, max, ...inputOptions } = options;

    const validate = (input: string) => {
      const num = parseFloat(input);

      if (isNaN(num)) {
        return '请输入有效的数字';
      }

      if (min !== undefined && num < min) {
        return `数字不能小于 ${min}`;
      }

      if (max !== undefined && num > max) {
        return `数字不能大于 ${max}`;
      }

      if (options.validate) {
        return options.validate(input);
      }

      return true;
    };

    const filter = (input: string) => {
      return parseFloat(input);
    };

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: UIStyles.component.label(message),
        validate,
        filter,
        ...inputOptions,
      } as any,
    ]);

    return answers.value;
  }

  /**
   * 编辑器输入（多行文本）
   */
  public static async editor(
    message: string,
    options: TextInputOptions = {}
  ): Promise<string> {
    const answers = await inquirer.prompt([
      {
        type: 'editor',
        name: 'value',
        message: UIStyles.component.label(message),
        ...options,
      },
    ]);
    return answers.value;
  }

  /**
   * 原始提示符（不带样式）
   */
  public static async raw(questions: any[]): Promise<any> {
    return inquirer.prompt(questions);
  }

  /**
   * 等待用户按键继续
   */
  public static async pressKeyToContinue(
    message: string = '按任意键继续...'
  ): Promise<void> {
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: UIStyles.status.muted(message),
      },
    ]);
  }

  /**
   * 快速确认（带默认值）
   */
  public static async quickConfirm(
    message: string,
    defaultValue: boolean = true
  ): Promise<boolean> {
    return this.confirm(message, { default: defaultValue });
  }

  /**
   * 快速选择（带常用选项）
   */
  public static async quickSelect(
    message: string,
    options: string[],
    defaultIndex: number = 0
  ): Promise<string> {
    const choices: Choice[] = options.map((option) => ({
      name: option,
      value: option,
      short: option,
    }));

    return this.select(message, choices, {
      default: options[defaultIndex],
    });
  }
}
