# ConfirmableToolBase 使用指南

`ConfirmableToolBase` 是一个抽象基类，专门为需要用户确认的命令行工具提供统一的确认机制。它简化了命令行工具的开发，并确保所有需要用户确认的操作都遵循一致的用户体验。

## 特性

- 🔒 **统一的用户确认流程** - 所有继承的工具都使用相同的确认界面
- 🛡️ **风险级别管理** - 支持不同风险级别的可视化显示
- 🔍 **命令预检查** - 在执行前验证命令的有效性
- 💡 **智能建议** - 当命令无效时提供替代方案
- 📋 **执行预览** - 显示命令执行前的预览信息
- ⚡ **可跳过确认** - 支持自动化场景下跳过用户确认

## 核心概念

### 风险级别 (RiskLevel)

```typescript
enum RiskLevel {
  SAFE = 'safe',        // 安全操作，如查看状态
  MODERATE = 'moderate', // 中等风险，如普通提交
  HIGH = 'high',        // 高风险，如修改历史
  CRITICAL = 'critical'  // 极高风险，如删除操作
}
```

### 确认选项 (ConfirmationOptions)

```typescript
interface ConfirmationOptions {
  skipConfirmation?: boolean;  // 是否跳过确认
  confirmMessage?: string;     // 自定义确认消息
  riskLevel?: RiskLevel;       // 风险级别
  showPreview?: boolean;       // 是否显示预览
  timeout?: number;            // 执行超时时间
}
```

## 使用方法

### 1. 继承基类

```typescript
import { ConfirmableToolBase, RiskLevel } from './ConfirmableToolBase.js';

export class MyCommandTool extends ConfirmableToolBase {
  readonly name = 'my_command';
  readonly description = '我的命令工具';
  readonly category = 'custom';
  
  readonly parameters = {
    // 定义参数
    target: {
      type: 'string',
      required: true,
      description: '目标参数',
    },
    skipConfirmation: {
      type: 'boolean',
      required: false,
      description: '跳过用户确认',
      default: false,
    },
  };
  
  readonly required = ['target'];
}
```

### 2. 实现必需方法

#### buildCommand (必须实现)

构建要执行的命令字符串：

```typescript
protected async buildCommand(params: Record<string, any>): Promise<string> {
  const { target, option } = params;
  return `my-command --target="${target}" ${option ? '--option' : ''}`;
}
```

### 3. 重写可选方法

#### preprocessParameters

预处理和验证参数：

```typescript
protected async preprocessParameters(params: Record<string, any>): Promise<Record<string, any>> {
  if (!params.target || params.target.trim().length === 0) {
    throw new Error('目标参数不能为空');
  }
  return params;
}
```

#### getConfirmationOptions

自定义确认选项：

```typescript
protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
  const baseOptions = super.getConfirmationOptions(params);
  
  // 根据参数调整风险级别
  let riskLevel = RiskLevel.MODERATE;
  if (params.dangerous) {
    riskLevel = RiskLevel.HIGH;
  }
  
  return {
    ...baseOptions,
    riskLevel,
    confirmMessage: '确定要执行这个危险操作吗？',
  };
}
```

#### preCheckCommand

预检查命令有效性：

```typescript
protected async preCheckCommand(
  command: string,
  workingDirectory: string,
  params: Record<string, any>
): Promise<CommandPreCheckResult> {
  // 检查目标文件是否存在
  if (!existsSync(params.target)) {
    return {
      valid: false,
      message: `目标文件 "${params.target}" 不存在`,
      suggestions: [
        {
          command: `touch ${params.target}`,
          description: '创建目标文件',
          riskLevel: RiskLevel.SAFE,
        },
      ],
    };
  }
  
  return { valid: true };
}
```

#### getExecutionDescription

提供执行描述：

```typescript
protected getExecutionDescription(params: Record<string, any>): string {
  return `处理文件: ${params.target}`;
}
```

#### getExecutionPreview

提供执行预览：

```typescript
protected async getExecutionPreview(
  command: string,
  workingDirectory: string,
  params: Record<string, any>
): Promise<string> {
  return `将要处理的文件:\n  - ${params.target}`;
}
```

#### postProcessResult

后处理执行结果：

```typescript
protected async postProcessResult(
  result: { stdout: string; stderr: string },
  params: Record<string, any>
): Promise<any> {
  return {
    processed: true,
    output: result.stdout,
    target: params.target,
  };
}
```

## 完整示例

参见 `git-commit-v2.ts` 文件，它展示了如何使用 `ConfirmableToolBase` 重构 Git Commit 工具：

```typescript
export class GitCommitTool extends ConfirmableToolBase {
  // 基本配置
  readonly name = 'git_commit_v2';
  readonly description = '提交Git暂存区的更改（需要用户确认）';
  
  // 参数定义
  readonly parameters = {
    message: { type: 'string', required: true, description: '提交信息' },
    amend: { type: 'boolean', required: false, description: '修改最后一次提交' },
    // ... 其他参数
  };
  
  // 构建命令
  protected async buildCommand(params: Record<string, any>): Promise<string> {
    let command = 'git commit';
    if (params.amend) command += ' --amend';
    command += ` -m "${params.message}"`;
    return command;
  }
  
  // 自定义确认选项
  protected getConfirmationOptions(params: Record<string, any>): ConfirmationOptions {
    const riskLevel = params.amend ? RiskLevel.HIGH : RiskLevel.MODERATE;
    return {
      ...super.getConfirmationOptions(params),
      riskLevel,
      confirmMessage: params.amend ? '⚠️  这将修改最后一次提交，是否继续？' : '是否提交这些更改？',
    };
  }
  
  // 预检查
  protected async preCheckCommand(/* ... */): Promise<CommandPreCheckResult> {
    // 检查是否有更改可提交，提供建议等
  }
}
```

## 最佳实践

1. **明确风险级别** - 根据操作的危险程度设置合适的风险级别
2. **提供有用的预览** - 让用户清楚了解即将执行的操作
3. **智能建议** - 当操作无效时，提供有意义的替代方案
4. **详细的错误信息** - 提供清晰的错误信息帮助用户排查问题
5. **支持自动化** - 通过 `skipConfirmation` 参数支持自动化场景

## 工具集成

要将新工具集成到系统中，需要：

1. 在相应的工具文件中导出工具实例
2. 在工具管理器中注册工具
3. 更新工具索引文件

```typescript
// 在工具文件中
export const myTool = new MyCommandTool();

// 在工具管理器中注册
toolManager.register(myTool);
```

这样，所有需要用户确认的命令行工具都能享受统一、安全的用户体验。 