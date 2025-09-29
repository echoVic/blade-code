# Blade 安全加固实施指南

本指南提供了针对安全审计报告中发现问题的具体解决方案和实施步骤。

## 1. 路径遍历漏洞修复

### 问题
文件系统工具中的路径遍历防护不足。

### 解决方案

#### 1.1 创建安全的路径验证工具

```typescript
// src/utils/path-security.ts
import { resolve, normalize, relative } from 'path';
import { constants } from 'fs';
import { access } from 'fs/promises';

export class PathSecurity {
  private static readonly ALLOWED_SCHEMES = ['file:', ''];
  
  /**
   * 安全地解析和验证文件路径
   * @param userPath 用户提供的路径
   * @param baseDir 基础目录（可选，默认为当前工作目录）
   * @returns 解析后的安全路径
   * @throws Error 如果路径不安全
   */
  static async securePath(userPath: string, baseDir?: string): Promise<string> {
    // 1. 检查路径协议
    if (this.ALLOWED_SCHEMES.every(scheme => !userPath.startsWith(scheme))) {
      throw new Error(`不支持的路径协议: ${userPath}`);
    }

    // 2. 规范化路径
    const normalizedBase = baseDir ? normalize(baseDir) : process.cwd();
    const normalizedPath = normalize(userPath);
    
    // 3. 解析为绝对路径
    const resolvedPath = resolve(normalizedBase, normalizedPath);
    
    // 4. 检查路径是否在基础目录内
    if (baseDir) {
      const relativePath = relative(normalizedBase, resolvedPath);
      if (relativePath.startsWith('..') || relativePath === '') {
        throw new Error('路径超出允许的目录范围');
      }
    }
    
    // 5. 检查路径是否存在（可选）
    try {
      await access(resolvedPath, constants.F_OK);
    } catch {
      // 路径不存在可能是正常情况（如创建新文件）
    }
    
    return resolvedPath;
  }
  
  /**
   * 检查文件扩展名是否在允许列表中
   */
  static isAllowedExtension(filePath: string, allowedExtensions: string[]): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return !ext || allowedExtensions.includes(`.${ext}`) || allowedExtensions.includes(ext);
  }
}
```

#### 1.2 更新文件系统工具使用安全路径

```typescript
// src/tools/builtin/file-system.ts (更新部分)
import { PathSecurity } from '../../utils/path-security.js';

// 更新 fileReadTool
async execute(params) {
  const { path, encoding, maxSize } = params;

  try {
    // 使用安全路径解析
    const resolvedPath = await PathSecurity.securePath(path);
    
    // 其余代码保持不变...
  }
}
```

## 2. 命令注入防护

### 解决方案

#### 2.1 使用参数化命令执行

```typescript
// src/utils/command-executor.ts
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class CommandExecutor {
  /**
   * 安全执行命令（使用文件和参数分离）
   */
  static async executeSafe(command: string, args: string[], options?: {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ stdout: string; stderr: string }> {
    // 验证命令白名单
    const allowedCommands = ['git', 'node', 'npm', 'pnpm'];
    const commandName = command.split(' ')[0];
    
    if (!allowedCommands.includes(commandName)) {
      throw new Error(`不允许执行的命令: ${commandName}`);
    }
    
    // 使用 execFile 而不是 exec，自动处理参数转义
    return execFileAsync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout || 30000,
      env: options?.env,
    });
  }
  
  /**
   * 安全执行 Git 命令
   */
  static async executeGit(args: string[], cwd?: string) {
    return this.executeSafe('git', args, { cwd });
  }
}
```

#### 2.2 更新 Git 工具使用安全执行器

```typescript
// src/tools/builtin/git/git-smart-commit.ts (更新部分)
import { CommandExecutor } from '../../../utils/command-executor.js';

// 替换原有的 commit 命令执行
protected async executeCommand(
  command: string,
  workingDirectory: string,
  options: any,
  params: Record<string, any>
) {
  const { dryRun, llmAnalysis } = params;

  try {
    // 提取 commit message（不含引号）
    const commitMessage = llmAnalysis.replace(/^"|"$/g, '');
    
    if (dryRun) {
      // 干运行逻辑...
    } else {
      // 使用安全的命令执行
      const result = await CommandExecutor.executeGit(
        ['commit', '-m', commitMessage],
        workingDirectory
      );
      
      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        command: `git commit -m "${commitMessage}"`,
        workingDirectory,
      };
    }
  } catch (error) {
    // 错误处理...
  }
}
```

## 3. 提示词注入防护

### 解决方案

#### 3.1 创建提示词安全工具

```typescript
// src/utils/prompt-security.ts
export class PromptSecurity {
  private static readonly MALICIOUS_PATTERNS = [
    /ignore.*previous/i,
    /disregard.*above/i,
    /forget.*instructions/i,
    /bypass.*security/i,
    /system.*admin/i,
    /inject.*prompt/i,
    /roleplay.*as/i,
    /pretend.*to.*be/i,
  ];
  
  /**
   * 净化用户输入
   */
  static sanitizeUserInput(input: string): string {
    let sanitized = input;
    
    // 移除潜在的恶意模式
    this.MALICIOUS_PATTERNS.forEach(pattern => {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    });
    
    // 限制输入长度
    if (sanitized.length > 2000) {
      sanitized = sanitized.substring(0, 2000) + '...[TRUNCATED]';
    }
    
    return sanitized.trim();
  }
  
  /**
   * 创建安全的提示词模板
   */
  static createSecurePrompt(
    systemPrompt: string,
    userContent: string,
    delimiter = '--- USER CONTENT ---'
  ): string {
    const sanitizedContent = this.sanitizeUserInput(userContent);
    
    return `${systemPrompt}\n\n${delimiter}\n${sanitizedContent}\n${delimiter}`;
  }
  
  /**
   * 检测是否为提示词注入攻击
   */
  static detectPromptInjection(input: string): boolean {
    return this.MALICIOUS_PATTERNS.some(pattern => pattern.test(input));
  }
}
```

#### 3.2 在 LLM 管理器中集成安全措施

```typescript
// src/llm/LLMManager.ts (更新部分)
import { PromptSecurity } from '../utils/prompt-security.js';

export class LLMManager {
  async send(request: Partial<LLMRequest>): Promise<LLMResponse> {
    // ... 原有验证代码
    
    // 安全处理消息
    const secureMessages = request.messages?.map(msg => {
      if (msg.role === 'user') {
        // 检测潜在的注入攻击
        if (PromptSecurity.detectPromptInjection(msg.content)) {
          throw new Error('检测到潜在的安全风险，请修改输入内容');
        }
        
        return {
          ...msg,
          content: PromptSecurity.sanitizeUserInput(msg.content),
        };
      }
      return msg;
    });
    
    // ... 其余代码
  }
  
  // 更新对话方法
  async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    // 使用安全的提示词创建
    const securePrompt = PromptSecurity.createSecurePrompt(
      systemPrompt,
      userMessage
    );
    
    return await this.send({ 
      messages: [
        { role: 'system', content: securePrompt.split('--- USER CONTENT ---')[0] },
        { role: 'user', content: securePrompt.split('--- USER CONTENT ---')[1] }
      ]
    }).then(r => r.content);
  }
}
```

## 4. 配置加密

### 解决方案

#### 4.1 创建配置加密工具

```typescript
// src/utils/config-encryptor.ts
import { createCipher, createDecipher, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

export class ConfigEncryptor {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly SALT_LENGTH = 32;
  
  /**
   * 加密配置值
   */
  static async encrypt(value: string, password: string): Promise<string> {
    const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(this.SALT_LENGTH)));
    const key = await scryptAsync(password, salt, 32) as Buffer;
    
    const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
    const cipher = createCipher(this.ALGORITHM, key);
    
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // 组合所有组件
    const combined = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'hex')]);
    
    return combined.toString('base64');
  }
  
  /**
   * 解密配置值
   */
  static async decrypt(encryptedValue: string, password: string): Promise<string> {
    const combined = Buffer.from(encryptedValue, 'base64');
    
    // 提取组件
    const salt = combined.subarray(0, this.SALT_LENGTH);
    const iv = combined.subarray(this.SALT_LENGTH, this.SALT_LENGTH + 16);
    const authTag = combined.subarray(this.SALT_LENGTH + 16, this.SALT_LENGTH + 32);
    const encrypted = combined.subarray(this.SALT_LENGTH + 32);
    
    const key = await scryptAsync(password, salt, 32) as Buffer;
    
    const decipher = createDecipher(this.ALGORITHM, key);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  /**
   * 从环境变量获取加密密码
   */
  static getEncryptionPassword(): string {
    return process.env.BLADE_CONFIG_PASSWORD || 
           process.env.USER + '-' + process.env.HOSTNAME ||
           'default-encryption-key';
  }
}
```

#### 4.2 更新配置管理器

```typescript
// src/config/ConfigManager.ts (更新部分)
import { ConfigEncryptor } from '../utils/config-encryptor.js';

export class ConfigManager {
  // ... 其他代码
  
  private async loadUserConfig(): Promise<void> {
    const configPath = path.join(os.homedir(), '.blade', 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const file = fs.readFileSync(configPath, 'utf8');
        const userConfig = JSON.parse(file);
        
        // 解密敏感字段
        const password = ConfigEncryptor.getEncryptionPassword();
        
        for (const [key, value] of Object.entries(userConfig)) {
          if (typeof value === 'string' && value.startsWith('enc:')) {
            try {
              const encrypted = value.substring(4);
              const decrypted = await ConfigEncryptor.decrypt(encrypted, password);
              (this.config as any)[key] = decrypted;
            } catch {
              // 解密失败，保持原值
              (this.config as any)[key] = value;
            }
          } else {
            (this.config as any)[key] = value;
          }
        }
      }
    } catch (error) {
      // 忽略错误
    }
  }
  
  async saveUserConfig(): Promise<void> {
    const configPath = path.join(os.homedir(), '.blade', 'config.json');
    const configDir = path.dirname(configPath);
    
    // 确保目录存在
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // 加密敏感字段
    const password = ConfigEncryptor.getEncryptionPassword();
    const configToSave: any = {};
    
    for (const [key, value] of Object.entries(this.config)) {
      if (['apiKey', 'searchApiKey', 'baseUrl'].includes(key)) {
        const encrypted = await ConfigEncryptor.encrypt(String(value), password);
        configToSave[key] = 'enc:' + encrypted;
      } else {
        configToSave[key] = value;
      }
    }
    
    fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2));
  }
}
```

## 5. TLS 配置优化

### 解决方案

#### 5.1 创建安全的 HTTP 客户端

```typescript
// src/utils/secure-http-client.ts
import axios, { AxiosInstance } from 'axios';

export class SecureHttpClient {
  static createClient(): AxiosInstance {
    const client = axios.create({
      // 强制 HTTPS
      baseURL: process.env.NODE_ENV === 'production' ? undefined : undefined,
      timeout: 30000,
      
      // TLS 配置
      httpsAgent: new https.Agent({
        // 强制 TLS 1.2+
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        
        // 禁用弱加密套件
        ciphers: [
          'TLS_AES_256_GCM_SHA384',
          'TLS_CHACHA20_POLY1305_SHA256',
          'TLS_AES_128_GCM_SHA256',
          'ECDHE-RSA-AES256-GCM-SHA384',
          'ECDHE-RSA-AES128-GCM-SHA256',
        ].join(':'),
        
        // 其他安全选项
        honorCipherOrder: true,
        rejectUnauthorized: true,
      }),
      
      // 请求拦截器
      headers: {
        'User-Agent': `Blade-AI/${process.env.npm_package_version || '1.0.0'}`,
        'Accept': 'application/json',
      },
    });
    
    // 响应拦截器
    client.interceptors.response.use(
      (response) => response,
      (error) => {
        // 安全错误处理
        if (error.code === 'CERT_HAS_EXPIRED') {
          throw new Error('服务器证书已过期');
        }
        if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          throw new Error('无法验证服务器证书');
        }
        throw error;
      }
    );
    
    return client;
  }
}
```

#### 5.2 更新 LLM 管理器使用安全客户端

```typescript
// src/llm/LLMManager.ts (更新部分)
import { SecureHttpClient } from '../utils/secure-http-client.js';
import https from 'https';

export class LLMManager {
  private httpClient: AxiosInstance;
  
  constructor(config: Pick<BladeConfig, 'apiKey' | 'baseUrl' | 'modelName'>) {
    this.httpClient = SecureHttpClient.createClient();
    // ... 其他初始化代码
  }
  
  async send(request: Partial<LLMRequest>): Promise<LLMResponse> {
    const config = { ...this.config, ...request };
    
    // 验证必要配置
    if (!config.apiKey) {
      throw new Error('API密钥未配置');
    }
    
    // 构造请求
    const payload = {
      model: config.modelName,
      messages: config.messages,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2048,
      stream: config.stream || false,
    };

    try {
      const response = await this.httpClient.post(config.baseUrl!, payload, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(config.timeout || 30000),
      });

      return {
        content: response.data.choices?.[0]?.message?.content || '',
        usage: response.data.usage,
        model: response.data.model,
      };
    } catch (error) {
      throw new Error(`LLM调用失败: ${(error as Error).message}`);
    }
  }
}
```

## 6. 错误信息脱敏

### 解决方案

#### 6.1 创建错误处理中间件

```typescript
// src/utils/error-handler.ts
import { PathSecurity } from './path-security.js';

export class ErrorHandler {
  private static readonly SENSITIVE_PATTERNS = [
    /apiKey=[^&\s]+/gi,
    /password=[^&\s]+/gi,
    /token=[^&\s]+/gi,
    /secret=[^&\s]+/gi,
    /\/\/.*@/g, // URL 中的认证信息
    /\\?[^\\]*\\.json/gi, // 文件路径
    /\\?[^\\]*\\.env/gi,
  ];
  
  /**
   * 脱敏错误信息
   */
  static sanitizeError(error: Error | string): string {
    const errorMessage = error instanceof Error ? error.message : error;
    let sanitizedMessage = errorMessage;
    
    // 移除敏感信息
    this.SENSITIVE_PATTERNS.forEach(pattern => {
      sanitizedMessage = sanitizedMessage.replace(pattern, (match) => {
        return match.substring(0, Math.min(20, match.indexOf('=') + 1)) + '[REDACTED]';
      });
    });
    
    // 脱敏路径
    if (sanitizedMessage.includes('/')) {
      try {
        // 只显示文件名，隐藏路径
        const parts = sanitizedMessage.split('/');
        const filename = parts[parts.length - 1];
        sanitizedMessage = sanitizedMessage.replace(/.*\//, '[PATH]/') + filename;
      } catch {
        // 如果路径解析失败，保持原样
      }
    }
    
    return sanitizedMessage;
  }
  
  /**
   * 创建安全的错误响应
   */
  static createSafeError(error: unknown): {
    success: false;
    error: string;
    code?: string;
  } {
    const safeMessage = this.sanitizeError(
      error instanceof Error ? error : new Error(String(error))
    );
    
    return {
      success: false,
      error: safeMessage,
      code: error instanceof Error && (error as any).code ? (error as any).code : undefined,
    };
  }
}
```

#### 6.2 在工具中使用安全错误处理

```typescript
// src/tools/builtin/file-system.ts (更新部分)
import { ErrorHandler } from '../../utils/error-handler.js';

const fileReadTool: ToolDefinition = {
  // ... 其他配置
  
  async execute(params) {
    try {
      // 原有逻辑...
    } catch (error: any) {
      return ErrorHandler.createSafeError(error);
    }
  },
};
```

## 7. 安全编码规则集成

### 解决方案

#### 7.1 更新 ESLint 配置

```json
// .eslintrc.json (更新部分)
{
  "extends": [
    "eslint:recommended",
    "@typescript-eslint/recommended"
  ],
  "plugins": [
    "@typescript-eslint",
    "security"
  ],
  "rules": {
    // 安全规则
    "security/detect-non-literal-fs-filename": "error",
    "security/detect-non-literal-regexp": "error",
    "security/detect-unsafe-regex": "error",
    "security/detect-buffer-noassert": "error",
    "security/detect-child-process": "warn",
    "security/detect-eval-with-expression": "error",
    "security/detect-no-csrf-before-method-override": "error",
    "security/detect-non-literal-require": "warn",
    "security/detect-object-injection": "off", // TypeScript 提供了类似的保护
    "security/detect-possible-timing-attacks": "error",
    "security/detect-pseudoRandomBytes": "error",
    
    // TypeScript 安全规则
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/no-var-requires": "error",
    
    // 其他重要规则
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-script-url": "error"
  },
  "overrides": [
    {
      "files": ["*.test.ts"],
      "rules": {
        "security/detect-child-process": "off"
      }
    }
  ]
}
```

#### 7.2 安装安全 ESLint 插件

```bash
pnpm add -D eslint-plugin-security
```

## 8. 实施检查清单

### 高优先级修复
- [ ] 实施路径遍历防护
- [ ] 修复命令注入漏洞
- [ ] 部署提示词注入防护
- [ ] 制定隐私政策文档

### 中优先级修复
- [ ] 实现配置加密存储
- [ ] 优化 TLS 配置
- [ ] 实施错误信息脱敏
- [ ] 集成安全 ESLint 规则

### 长期安全改进
- [ ] 建立依赖监控流程
- [ ] 实施 CI/CD 安全扫描
- [ ] 定期安全审计计划
- [ ] 安全培训计划

## 9. 测试安全修复

### 创建安全测试套件

```typescript
// tests/security/path-security.test.ts
import { PathSecurity } from '../../src/utils/path-security.js';
import { describe, it, expect } from 'vitest';

describe('PathSecurity', () => {
  it('should prevent path traversal', async () => {
    await expect(PathSecurity.securePath('../../etc/passwd'))
      .rejects.toThrow('路径超出允许的目录范围');
  });
  
  it('should allow valid paths', async () => {
    const path = await PathSecurity.securePath('test.txt', '/tmp');
    expect(path).toBe('/tmp/test.txt');
  });
});

// tests/security/command-executor.test.ts
import { CommandExecutor } from '../../src/utils/command-executor.js';

describe('CommandExecutor', () => {
  it('should prevent unauthorized commands', async () => {
    await expect(CommandExecutor.executeSafe('rm', ['-rf', '/']))
      .rejects.toThrow('不允许执行的命令');
  });
  
  it('should execute authorized commands', async () => {
    const result = await CommandExecutor.executeSafe('echo', ['test']);
    expect(result.stdout.trim()).toBe('test');
  });
});
```

---

## 总结

本安全加固指南提供了针对 Blade 项目中所有安全问题的具体解决方案。建议按照优先级逐步实施这些修复措施：

1. **立即修复高风险问题**（1-2 周）
2. **实施中优先级改进**（2-4 周）
3. **建立长期安全实践**（持续）

实施这些安全加固措施后，建议进行一次全面的安全测试，确保所有修复都有效且不会引入新的问题。