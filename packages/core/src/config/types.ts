/**
 * Blade AI 统一配置类型定义
 * 作为Core包导出的标准配置，供CLI和其他包使用
 */

export interface BladeConfig {
  version: string;
  name: string;
  description: string;
  
  // 核心配置
  core: {
    debug: boolean;
    telemetry: boolean;
    autoUpdate: boolean;
    maxMemory: number;
    timeout: number;
    workingDirectory: string;
    tempDirectory: string;
  };
  
  // 认证配置 - 统一所有LLM调用参数 (类似Claude Code设计)
  auth: {
    // 基础认证
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
    
    // LLM 模型配置
    modelName: string;
    temperature: number;
    maxTokens: number;
    stream: boolean;
    
    // 高级参数
    topP: number;
    topK: number;
    frequencyPenalty: number;
    presencePenalty: number;
    
    // 其他
    tokenStorage: 'memory' | 'file' | 'system';
    tokenRefreshInterval: number;
    timeout: number;
    providers: AuthProvider[];
  };
  
  // MCP配置
  mcp: {
    enabled: boolean;
    servers: MCPServer[];
    autoConnect: boolean;
    timeout: number;
    maxConnections: number;
  };
  
  // UI配置
  ui: {
    theme: string;
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    showStatusBar: boolean;
    showNotifications: boolean;
    animations: boolean;
    shortcuts: Record<string, string>;
    language: string;
  };
  
  // 工具配置
  tools: {
    git: {
      autoDetect: boolean;
      defaultBranch: string;
      commitVerification: boolean;
    };
    fileSystem: {
      allowedPaths: string[];
      blockedPaths: string[];
      maxFileSize: number;
    };
    shell: {
      allowedCommands: string[];
      blockedCommands: string[];
      timeout: number;
    };
    network: {
      timeout: number;
      maxRetries: number;
      userAgent: string;
      proxy?: {
        host: string;
        port: number;
        username?: string;
        password?: string;
      };
    };
  };
  
  // 服务配置
  services: {
    fileSystem: {
      watchEnabled: boolean;
      watchInterval: number;
      indexingEnabled: boolean;
    };
    git: {
      autoSync: boolean;
      syncInterval: number;
      commitOnExit: boolean;
    };
    logging: {
      level: 'debug' | 'info' | 'warn' | 'error';
      format: 'json' | 'text';
      output: 'file' | 'console' | 'both';
      maxFiles: number;
      maxSize: string;
    };
    telemetry: {
      enabled: boolean;
      endpoint: string;
      interval: number;
      batchSize: number;
    };
  };
  
  // 高级配置
  advanced: {
    experimentalFeatures: boolean;
    performanceMode: 'fast' | 'balanced' | 'stable';
    memoryManagement: 'auto' | 'manual';
    gcInterval: number;
    threadPool: {
      minThreads: number;
      maxThreads: number;
    };
    cache: {
      enabled: boolean;
      maxSize: number;
      ttl: number;
      strategy: 'lru' | 'fifo' | 'ttl';
    };
    security: {
      sandboxEnabled: boolean;
      validateInputs: boolean;
      rateLimiting: {
        enabled: boolean;
        requests: number;
        window: number;
      };
      encryption: {
        algorithm: string;
        keyRotationInterval: number;
      };
    };
  };
  
  // 隐私配置
  privacy: {
    dataCollection: boolean;
    crashReporting: boolean;
    usageMetrics: boolean;
    personalizedExperience: boolean;
    thirdPartySharing: boolean;
  };
  
  // 扩展配置
  extensions: {
    enabled: boolean;
    directory: string;
    autoInstall: boolean;
    autoUpdate: boolean;
    trustedSources: string[];
    installed: ExtensionConfig[];
  };
  
  // 开发配置
  development: {
    mode: 'development' | 'production' | 'test';
    hotReload: boolean;
    debugTools: boolean;
    mockData: boolean;
    testRunner: {
      enabled: boolean;
      autoRun: boolean;
      coverage: boolean;
    };
  };
  
  // 插件配置
  plugins: {
    enabled: boolean;
    directory: string;
    loadOrder: PluginLoadOrder;
    hooks: Record<string, string[]>;
  };
}

// 认证提供者
export interface AuthProvider {
  name: string;
  type: 'oauth' | 'api-key' | 'custom';
  endpoint: string;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  enabled: boolean;
  config: Record<string, any>;
}

// MCP服务器配置
export interface MCPServer {
  id: string;
  name: string;
  endpoint: string;
  transport: 'stdio' | 'sse' | 'websocket';
  enabled: boolean;
  config: Record<string, any>;
  capabilities: string[];
  autoConnect: boolean;
}

// 扩展配置
export interface ExtensionConfig {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  config: Record<string, any>;
  dependencies: string[];
  permissions: string[];
  priority: number;
}

// 插件加载顺序
export interface PluginLoadOrder {
  pre: string[];
  core: string[];
  post: string[];
}

// 路由配置
export interface RouteConfig {
  path: string;
  component: string;
  title: string;
  icon?: string;
  guards?: ((targetView: string, options?: any) => boolean)[];
  sidebar?: boolean;
  footer?: boolean;
  meta?: Record<string, any>;
  onNavigate?: (view: string, options?: any) => void;
}

// 用户配置覆盖
export interface UserConfigOverride {
  ui?: Partial<BladeConfig['ui']>;
  tools?: Partial<BladeConfig['tools']>;
  services?: Partial<BladeConfig['services']>;
  advanced?: Partial<BladeConfig['advanced']>;
  privacy?: Partial<BladeConfig['privacy']>;
  extensions?: Partial<BladeConfig['extensions']>;
  development?: Partial<BladeConfig['development']>;
  plugins?: Partial<BladeConfig['plugins']>;
}

// 配置验证器
export interface ConfigValidator {
  validate: (config: Partial<BladeConfig>) => boolean;
  errors: string[];
  warnings: string[];
}

// 配置文件位置
export interface ConfigLocations {
  userConfigPath: string;
  globalConfigPath: string;
  localConfigPath: string;
  tempConfigPath: string;
}

// 配置迁移信息
export interface ConfigMigration {
  from: string;
  to: string;
  changes: MigrationChange[];
  breaking: boolean;
  notes?: string;
}

export interface MigrationChange {
  path: string;
  type: 'add' | 'remove' | 'modify' | 'move';
  description: string;
  defaultValue?: any;
  migrationScript?: (config: any) => any;
}

// 配置错误
export interface ConfigError {
  code: string;
  message: string;
  path: string;
  value?: any;
  severity: 'error' | 'warning';
  details?: Record<string, any>;
}

// 配置状态
export interface ConfigStatus {
  isValid: boolean;
  errors: ConfigError[];
  warnings: ConfigError[];
  loadedFrom: string;
  lastModified: number;
  checksum: string;
}

// 环境变量映射
export interface EnvMapping {
  [key: string]: {
    path: string;
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: any;
    description?: string;
  };
}

// 默认配置导出
export const DEFAULT_CONFIG: Omit<BladeConfig, 'version' | 'name' | 'description'> = {
  core: {
    debug: false,
    telemetry: true,
    autoUpdate: true,
    maxMemory: 1024 * 1024 * 1024, // 1GB
    timeout: 30000,
    workingDirectory: process.cwd(),
    tempDirectory: process.env.TEMP || '/tmp',
  },
  auth: {
    // 基础认证
    apiKey: '',
    apiSecret: '',
    baseUrl: 'https://apis.iflow.cn/v1/chat/completions',
    
    // LLM 模型配置 (统一在auth下)
    modelName: 'Qwen3-Coder',
    temperature: 0.7,
    maxTokens: 4000,
    stream: true,
    
    // 高级参数
    topP: 0.9,
    topK: 50,
    frequencyPenalty: 0,
    presencePenalty: 0,
    
    // 其他
    tokenStorage: 'file',
    tokenRefreshInterval: 3600,
    timeout: 30000,
    providers: [],
  },
  mcp: {
    enabled: false,
    servers: [],
    autoConnect: false,
    timeout: 5000,
    maxConnections: 5,
  },
  ui: {
    theme: 'GitHub',
    fontSize: 14,
    fontFamily: 'monospace',
    lineHeight: 1.4,
    showStatusBar: true,
    showNotifications: true,
    animations: true,
    shortcuts: {},
    language: 'zh-CN',
  },
  tools: {
    git: {
      autoDetect: true,
      defaultBranch: 'main',
      commitVerification: false,
    },
    fileSystem: {
      allowedPaths: [],
      blockedPaths: [],
      maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    shell: {
      allowedCommands: [],
      blockedCommands: ['rm -rf', 'format', 'del'],
      timeout: 30000,
    },
    network: {
      timeout: 10000,
      maxRetries: 3,
      userAgent: 'Blade-Agent/1.0',
    },
  },
  services: {
    fileSystem: {
      watchEnabled: true,
      watchInterval: 1000,
      indexingEnabled: true,
    },
    git: {
      autoSync: false,
      syncInterval: 60000,
      commitOnExit: false,
    },
    logging: {
      level: 'info',
      format: 'text',
      output: 'both',
      maxFiles: 5,
      maxSize: '10MB',
    },
    telemetry: {
      enabled: true,
      endpoint: 'https://telemetry.blade-ai.com/api/v1/events',
      interval: 300000, // 5分钟
      batchSize: 100,
    },
  },
  advanced: {
    experimentalFeatures: false,
    performanceMode: 'balanced',
    memoryManagement: 'auto',
    gcInterval: 60000,
    threadPool: {
      minThreads: 2,
      maxThreads: 8,
    },
    cache: {
      enabled: true,
      maxSize: 100 * 1024 * 1024, // 100MB
      ttl: 3600000, // 1小时
      strategy: 'lru',
    },
    security: {
      sandboxEnabled: true,
      validateInputs: true,
      rateLimiting: {
        enabled: true,
        requests: 100,
        window: 60000,
      },
      encryption: {
        algorithm: 'aes-256-gcm',
        keyRotationInterval: 86400000, // 24小时
      },
    },
  },
  privacy: {
    dataCollection: true,
    crashReporting: true,
    usageMetrics: true,
    personalizedExperience: true,
    thirdPartySharing: false,
  },
  extensions: {
    enabled: true,
    directory: './extensions',
    autoInstall: false,
    autoUpdate: true,
    trustedSources: ['https://extensions.blade-ai.com'],
    installed: [],
  },
  development: {
    mode: 'production',
    hotReload: false,
    debugTools: false,
    mockData: false,
    testRunner: {
      enabled: false,
      autoRun: false,
      coverage: false,
    },
  },
  plugins: {
    enabled: false,
    directory: './plugins',
    loadOrder: {
      pre: [],
      core: [],
      post: [],
    },
    hooks: {},
  },
};