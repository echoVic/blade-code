/**
 * UI输入验证工具函数
 */

export class UIValidator {
  /**
   * 验证必填字段
   */
  public static required(value: string): boolean | string {
    if (!value || value.trim().length === 0) {
      return '此字段为必填项';
    }
    return true;
  }

  /**
   * 验证邮箱格式
   */
  public static email(value: string): boolean | string {
    if (!value) return true; // 允许空值，配合 required 使用

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      return '请输入有效的邮箱地址';
    }
    return true;
  }

  /**
   * 验证URL格式
   */
  public static url(value: string): boolean | string {
    if (!value) return true;

    try {
      new URL(value);
      return true;
    } catch {
      return '请输入有效的URL地址';
    }
  }

  /**
   * 验证数字
   */
  public static number(min?: number, max?: number) {
    return (value: string): boolean | string => {
      if (!value) return true;

      const num = parseFloat(value);
      if (isNaN(num)) {
        return '请输入有效的数字';
      }

      if (min !== undefined && num < min) {
        return `数字不能小于 ${min}`;
      }

      if (max !== undefined && num > max) {
        return `数字不能大于 ${max}`;
      }

      return true;
    };
  }

  /**
   * 验证整数
   */
  public static integer(min?: number, max?: number) {
    return (value: string): boolean | string => {
      if (!value) return true;

      const num = parseInt(value, 10);
      if (isNaN(num) || !Number.isInteger(parseFloat(value))) {
        return '请输入有效的整数';
      }

      if (min !== undefined && num < min) {
        return `整数不能小于 ${min}`;
      }

      if (max !== undefined && num > max) {
        return `整数不能大于 ${max}`;
      }

      return true;
    };
  }

  /**
   * 验证字符串长度
   */
  public static stringLength(min?: number, max?: number) {
    return (value: string): boolean | string => {
      if (!value && min && min > 0) {
        return `最少需要 ${min} 个字符`;
      }

      if (min !== undefined && value.length < min) {
        return `最少需要 ${min} 个字符`;
      }

      if (max !== undefined && value.length > max) {
        return `最多允许 ${max} 个字符`;
      }

      return true;
    };
  }

  /**
   * 验证正则表达式
   */
  public static pattern(regex: RegExp, errorMessage: string) {
    return (value: string): boolean | string => {
      if (!value) return true;

      if (!regex.test(value)) {
        return errorMessage;
      }

      return true;
    };
  }

  /**
   * 验证文件路径
   */
  public static filePath(value: string): boolean | string {
    if (!value) return true;

    // 检查是否包含非法字符
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(value)) {
      return '文件路径包含非法字符';
    }

    return true;
  }

  /**
   * 验证端口号
   */
  public static port(value: string): boolean | string {
    if (!value) return true;

    const portNum = parseInt(value, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return '端口号必须在 1-65535 之间';
    }

    return true;
  }

  /**
   * 验证IP地址
   */
  public static ip(value: string): boolean | string {
    if (!value) return true;

    const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = value.match(ipRegex);

    if (!match) {
      return '请输入有效的IP地址';
    }

    const octets = match.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) {
      return '请输入有效的IP地址';
    }

    return true;
  }

  /**
   * 验证版本号（语义化版本）
   */
  public static version(value: string): boolean | string {
    if (!value) return true;

    const versionRegex =
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    if (!versionRegex.test(value)) {
      return '请输入有效的版本号 (例如: 1.0.0)';
    }

    return true;
  }

  /**
   * 验证JSON格式
   */
  public static json(value: string): boolean | string {
    if (!value) return true;

    try {
      JSON.parse(value);
      return true;
    } catch {
      return '请输入有效的JSON格式';
    }
  }

  /**
   * 验证API密钥格式
   */
  public static apiKey(value: string): boolean | string {
    if (!value) return true;

    // 基本格式验证：至少包含字母数字，长度大于10
    if (value.length < 10) {
      return 'API密钥长度不能少于10个字符';
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      return 'API密钥只能包含字母、数字、下划线和短横线';
    }

    return true;
  }

  /**
   * 验证选择项是否在允许的值中
   */
  public static oneOf(allowedValues: string[]) {
    return (value: string): boolean | string => {
      if (!value) return true;

      if (!allowedValues.includes(value)) {
        return `值必须是以下之一: ${allowedValues.join(', ')}`;
      }

      return true;
    };
  }

  /**
   * 组合多个验证器
   */
  public static combine(...validators: Array<(value: string) => boolean | string>) {
    return (value: string): boolean | string => {
      for (const validator of validators) {
        const result = validator(value);
        if (result !== true) {
          return result;
        }
      }
      return true;
    };
  }

  /**
   * 自定义验证器
   */
  public static custom(validatorFn: (value: string) => boolean, errorMessage: string) {
    return (value: string): boolean | string => {
      if (!value) return true;

      if (!validatorFn(value)) {
        return errorMessage;
      }

      return true;
    };
  }

  /**
   * 异步验证器（返回Promise）
   */
  public static async asyncValidate(
    value: string,
    validatorFn: (value: string) => Promise<boolean>,
    errorMessage: string
  ): Promise<boolean | string> {
    if (!value) return true;

    try {
      const isValid = await validatorFn(value);
      return isValid ? true : errorMessage;
    } catch {
      return '验证过程中发生错误';
    }
  }

  /**
   * 密码强度验证
   */
  public static password(
    options: {
      minLength?: number;
      requireUppercase?: boolean;
      requireLowercase?: boolean;
      requireNumbers?: boolean;
      requireSpecialChars?: boolean;
    } = {}
  ) {
    return (value: string): boolean | string => {
      if (!value) return true;

      const opts = {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireNumbers: true,
        requireSpecialChars: false,
        ...options,
      };

      if (value.length < opts.minLength) {
        return `密码长度至少需要 ${opts.minLength} 个字符`;
      }

      if (opts.requireUppercase && !/[A-Z]/.test(value)) {
        return '密码必须包含大写字母';
      }

      if (opts.requireLowercase && !/[a-z]/.test(value)) {
        return '密码必须包含小写字母';
      }

      if (opts.requireNumbers && !/\d/.test(value)) {
        return '密码必须包含数字';
      }

      if (opts.requireSpecialChars && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value)) {
        return '密码必须包含特殊字符';
      }

      return true;
    };
  }
}
