import chalk from 'chalk';
import { exec } from 'child_process';
import inquirer from 'inquirer';
import { promisify } from 'util';
import type { ToolDefinition, ToolExecutionResult } from '../types.js';

const execAsync = promisify(exec);

/**
 * 风险级别枚举
 */
export enum RiskLevel {
  SAFE = 'safe',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * 命令预检查结果
 */
export interface CommandPreCheckResult {
  valid: boolean;
  message?: string;
  suggestions?: Array<{
    command: string;
    description: string;
    riskLevel?: RiskLevel;
  }>;
}

/**
 * 确认选项
 */
export interface ConfirmationOptions {
  /** 是否跳过确认 */
  skipConfirmation?: boolean;
  /** 自定义确认消息 */
  confirmMessage?: string;
  /** 风险级别 */
  riskLevel?: RiskLevel;
  /** 是否显示命令预览 */
  showPreview?: boolean;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 命令执行结果
 */
export interface CommandExecutionResult extends ToolExecutionResult {
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  workingDirectory?: string;
  cancelled?: boolean;
}

/**
 * 可确认工具的抽象基类
 * 为需要用户确认的命令行工具提供统一的确认机制
 */
export abstract class ConfirmableToolBase implements ToolDefinition {
  /** 工具名称 */
  abstract readonly name: string;
  /** 工具描述 */
  abstract readonly description: string;
  /** 工具版本 */
  readonly version?: string = '1.0.0';
  /** 工具作者 */
  readonly author?: string = 'Agent CLI';
  /** 工具分类 */
  readonly category?: string;
  /** 工具标签 */
  readonly tags?: string[];
  /** 参数模式定义 */
  abstract readonly parameters: Record<string, any>;
  /** 必需参数列表 */
  readonly required?: string[];
  /** 日志组件 */
  protected logger: LoggerComponent;

  constructor() {
    this.logger = new LoggerComponent(`tool-${this.name}`);
  }

  /**
   * 工具执行入口
   */
  async execute(params: Record<string, any>): Promise<CommandExecutionResult> {
    try {
      // 预处理参数
      const processedParams = await this.preprocessParameters(params);

      // 构建命令
      const command = await this.buildCommand(processedParams);

      // 获取确认选项
      const confirmationOptions = this.getConfirmationOptions(processedParams);

      // 获取工作目录
      const workingDirectory = this.getWorkingDirectory(processedParams);

      // 预检查命令
      const preCheckResult = await this.preCheckCommand(command, workingDirectory, processedParams);

      if (!preCheckResult.valid) {
        return await this.handlePreCheckFailure(
          preCheckResult,
          workingDirectory,
          confirmationOptions
        );
      }

      // 如果需要确认，进行用户确认
      if (!confirmationOptions.skipConfirmation) {
        const confirmed = await this.confirmExecution(
          command,
          workingDirectory,
          confirmationOptions,
          processedParams
        );

        if (!confirmed) {
          return {
            success: false,
            error: '用户取消执行',
            cancelled: true,
          };
        }
      }

      // 执行命令
      return await this.executeCommand(
        command,
        workingDirectory,
        confirmationOptions,
        processedParams
      );
    } catch (error: any) {
      return {
        success: false,
        error: `工具执行失败: ${error.message}`,
      };
    }
  }

  /**
   * 预处理参数 - 子类可重写进行参数验证和转换
   */
  protected async preprocessParameters(params: Record<string, any>): Promise<Record<string, any>> {
    return params;
  }

  /**
   * 构建要执行的命令 - 子类必须实现
   */
  protected abstract buildCommand(params: Record<string, any>): Promise<string>;

  /**
   * 获取确认选项 - 子类可重写自定义确认行为
   */
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    return {
      skipConfirmation: params.skipConfirmation || false,
      riskLevel: params.riskLevel || RiskLevel.MODERATE,
      showPreview: params.showPreview !== false,
      timeout: params.timeout || 30000,
    };
  }

  /**
   * 获取工作目录 - 子类可重写
   */
  protected getWorkingDirectory(params: Record<string, any>): string {
    return params.workingDirectory || params.path || process.cwd();
  }

  /**
   * 预检查命令 - 子类可重写进行特定的命令检查
   */
  protected async preCheckCommand(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workingDirectory: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: Record<string, any>
  ): Promise<CommandPreCheckResult> {
    return { valid: true };
  }

  /**
   * 处理预检查失败 - 提供建议选项
   */
  protected async handlePreCheckFailure(
    preCheckResult: CommandPreCheckResult,
    workingDirectory: string,
    confirmationOptions: ConfirmationOptions
  ): Promise<CommandExecutionResult> {
    this.logger.warn(`预检查发现问题: ${preCheckResult.message}`, {
      component: 'ConfirmableToolBase',
      action: 'handlePreCheckFailure'
    });

    if (preCheckResult.suggestions && preCheckResult.suggestions.length > 0) {
      this.logger.info('显示建议的替代方案', {
        component: 'ConfirmableToolBase',
        action: 'handlePreCheckFailure',
        suggestionCount: preCheckResult.suggestions.length
      });

      const choices = preCheckResult.suggestions.map((suggestion, index) => ({
        name: `${chalk.cyan(suggestion.command)} ${chalk.gray(`- ${suggestion.description}`)}`,
        value: index,
        short: suggestion.command,
      }));

      choices.push({ name: chalk.gray('取消执行'), value: -1, short: '取消' });

      const { selectedIndex } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedIndex',
          message: '请选择要执行的命令:',
          choices,
          pageSize: 10,
        },
      ]);

      if (selectedIndex === -1) {
        this.logger.info('用户取消执行', {
          component: 'ConfirmableToolBase',
          action: 'handlePreCheckFailure'
        });
        return {
          success: false,
          error: '用户取消执行',
          cancelled: true,
        };
      }

      const selectedSuggestion = preCheckResult.suggestions[selectedIndex];
      return await this.executeCommand(
        selectedSuggestion.command,
        workingDirectory,
        {
          ...confirmationOptions,
          riskLevel: selectedSuggestion.riskLevel || confirmationOptions.riskLevel,
        },
        {}
      );
    }

    this.logger.error('预检查失败', {
      component: 'ConfirmableToolBase',
      action: 'handlePreCheckFailure',
      message: preCheckResult.message
    });
    
    return {
      success: false,
      error: preCheckResult.message || '预检查失败',
    };
  }

  /**
   * 用户确认执行
   */
  protected async confirmExecution(
    command: string,
    workingDirectory: string,
    options: ConfirmationOptions,
    params: Record<string, any>
  ): Promise<boolean> {
    // 显示命令信息
    this.logger.info('建议执行命令', {
      component: 'ConfirmableToolBase',
      action: 'confirmExecution',
      command,
      workingDirectory
    });

    // 显示额外信息
    const description = this.getExecutionDescription(params);
    if (description) {
      this.logger.info('命令说明', {
        component: 'ConfirmableToolBase',
        action: 'confirmExecution',
        description
      });
    }

    this.logger.info('风险级别信息', {
      component: 'ConfirmableToolBase',
      action: 'confirmExecution',
      riskLevel: options.riskLevel,
      workingDirectory
    });

    // 显示预览信息
    if (options.showPreview) {
      const previewInfo = await this.getExecutionPreview(command, workingDirectory, params);
      if (previewInfo) {
        this.logger.info('执行预览', {
          component: 'ConfirmableToolBase',
          action: 'confirmExecution',
          previewInfo
        });
      }
    }

    // 用户确认
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: options.confirmMessage || '是否执行此命令？',
        default: false,
      },
    ]);

    this.logger.info('用户确认结果', {
      component: 'ConfirmableToolBase',
      action: 'confirmExecution',
      confirmed: confirm
    });

    return confirm;
  }

  /**
   * 执行命令
   */
  protected async executeCommand(
    command: string,
    workingDirectory: string,
    options: ConfirmationOptions,
    params: Record<string, any>
  ): Promise<CommandExecutionResult> {
    this.logger.info('正在执行命令', {
      component: 'ConfirmableToolBase',
      action: 'executeCommand',
      command,
      workingDirectory
    });
    
    const startTime = Date.now();

    try {
      const result = await execAsync(command, {
        cwd: workingDirectory,
        timeout: options.timeout,
      });

      const duration = Date.now() - startTime;

      this.logger.info('命令执行成功', {
        component: 'ConfirmableToolBase',
        action: 'executeCommand',
        command,
        duration,
        success: true
      });

      if (result.stdout) {
        this.logger.debug('命令输出', {
          component: 'ConfirmableToolBase',
          action: 'executeCommand',
          command,
          stdout: result.stdout
        });
      }

      // 后处理结果
      const processedResult = await this.postProcessResult(result, params);

      return {
        success: true,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        workingDirectory,
        duration,
        data: processedResult,
      };
    } catch (error: any) {
      this.logger.error('命令执行失败', {
        component: 'ConfirmableToolBase',
        action: 'executeCommand',
        command,
        error: error.message,
        stack: error.stack
      });

      if (error.stdout) {
        this.logger.debug('标准输出', {
          component: 'ConfirmableToolBase',
          action: 'executeCommand',
          command,
          stdout: error.stdout
        });
      }

      if (error.stderr) {
        this.logger.warn('错误输出', {
          component: 'ConfirmableToolBase',
          action: 'executeCommand',
          command,
          stderr: error.stderr
        });
      }

      return {
        success: false,
        error: error.message,
        command,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.code,
        workingDirectory,
      };
    }
  }

  /**
   * 获取执行描述 - 子类可重写提供更详细的说明
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getExecutionDescription(_params: Record<string, any>): string | undefined {
    return undefined;
  }

  /**
   * 获取执行预览 - 子类可重写提供执行前的预览信息
   */
  protected async getExecutionPreview(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _command: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _workingDirectory: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: Record<string, any>
  ): Promise<string | undefined> {
    return undefined;
  }

  /**
   * 后处理结果 - 子类可重写对执行结果进行额外处理
   */
  protected async postProcessResult(
    result: { stdout: string; stderr: string },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: Record<string, any>
  ): Promise<any> {
    return result;
  }

  /**
   * 获取风险级别显示
   */
  protected getRiskLevelDisplay(level: RiskLevel): string {
    switch (level) {
      case RiskLevel.SAFE:
        return chalk.green('安全');
      case RiskLevel.MODERATE:
        return chalk.yellow('中等');
      case RiskLevel.HIGH:
        return chalk.red('高风险');
      case RiskLevel.CRITICAL:
        return chalk.redBright.bold('极高风险');
      default:
        return chalk.gray('未知');
    }
  }
}
