/**
 * 测试配置文件
 * 管理测试环境变量和配置
 */

export interface TestConfig {
  // 基础配置
  NODE_ENV: string;
  TEST_MODE: string;
  LOG_LEVEL: string;
  DEBUG_TESTS: string;
  VERBOSE_TESTS: string;

  // 测试类型配置
  UNIT_TEST_TIMEOUT: number;
  INTEGRATION_TEST_TIMEOUT: number;
  E2E_TEST_TIMEOUT: number;
  SECURITY_TEST_TIMEOUT: number;

  // 模拟配置
  MOCK_NETWORK_DELAY: number;
  MOCK_FILE_OPERATIONS: boolean;
  MOCK_EXTERNAL_SERVICES: boolean;

  // 覆盖率配置
  COVERAGE_THRESHOLD: {
    branches: number;
    functions: number;
    lines: number;
    statements: number;
  };

  // 测试数据配置
  TEST_DATA_CLEANUP: boolean;
  TEST_DATA_PERSISTENCE: boolean;

  // 并发配置
  MAX_CONCURRENT_TESTS: number;
  MAX_CONCURRENT_INTEGRATION_TESTS: number;
}

const defaultConfig: TestConfig = {
  // 基础配置
  NODE_ENV: 'test',
  TEST_MODE: 'true',
  LOG_LEVEL: 'error',
  DEBUG_TESTS: 'false',
  VERBOSE_TESTS: 'false',

  // 测试类型配置
  UNIT_TEST_TIMEOUT: 10000,
  INTEGRATION_TEST_TIMEOUT: 30000,
  E2E_TEST_TIMEOUT: 60000,
  SECURITY_TEST_TIMEOUT: 20000,

  // 模拟配置
  MOCK_NETWORK_DELAY: 100,
  MOCK_FILE_OPERATIONS: true,
  MOCK_EXTERNAL_SERVICES: true,

  // 覆盖率配置
  COVERAGE_THRESHOLD: {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80,
  },

  // 测试数据配置
  TEST_DATA_CLEANUP: true,
  TEST_DATA_PERSISTENCE: false,

  // 并发配置
  MAX_CONCURRENT_TESTS: 4,
  MAX_CONCURRENT_INTEGRATION_TESTS: 1,
};

class TestConfigManager {
  private config: TestConfig;

  constructor() {
    this.config = { ...defaultConfig };
    this.loadFromEnvironment();
  }

  /**
   * 从环境变量加载配置
   */
  private loadFromEnvironment(): void {
    const envConfig: Partial<TestConfig> = {};

    // 基础配置
    if (process.env.NODE_ENV) envConfig.NODE_ENV = process.env.NODE_ENV;
    if (process.env.TEST_MODE) envConfig.TEST_MODE = process.env.TEST_MODE;
    if (process.env.LOG_LEVEL) envConfig.LOG_LEVEL = process.env.LOG_LEVEL;
    if (process.env.DEBUG_TESTS) envConfig.DEBUG_TESTS = process.env.DEBUG_TESTS;
    if (process.env.VERBOSE_TESTS) envConfig.VERBOSE_TESTS = process.env.VERBOSE_TESTS;

    // 测试超时配置
    if (process.env.UNIT_TEST_TIMEOUT) {
      envConfig.UNIT_TEST_TIMEOUT = parseInt(process.env.UNIT_TEST_TIMEOUT, 10);
    }
    if (process.env.INTEGRATION_TEST_TIMEOUT) {
      envConfig.INTEGRATION_TEST_TIMEOUT = parseInt(
        process.env.INTEGRATION_TEST_TIMEOUT,
        10
      );
    }
    if (process.env.E2E_TEST_TIMEOUT) {
      envConfig.E2E_TEST_TIMEOUT = parseInt(process.env.E2E_TEST_TIMEOUT, 10);
    }
    if (process.env.SECURITY_TEST_TIMEOUT) {
      envConfig.SECURITY_TEST_TIMEOUT = parseInt(process.env.SECURITY_TEST_TIMEOUT, 10);
    }

    // 模拟配置
    if (process.env.MOCK_NETWORK_DELAY) {
      envConfig.MOCK_NETWORK_DELAY = parseInt(process.env.MOCK_NETWORK_DELAY, 10);
    }
    if (process.env.MOCK_FILE_OPERATIONS) {
      envConfig.MOCK_FILE_OPERATIONS = process.env.MOCK_FILE_OPERATIONS === 'true';
    }
    if (process.env.MOCK_EXTERNAL_SERVICES) {
      envConfig.MOCK_EXTERNAL_SERVICES = process.env.MOCK_EXTERNAL_SERVICES === 'true';
    }

    // 并发配置
    if (process.env.MAX_CONCURRENT_TESTS) {
      envConfig.MAX_CONCURRENT_TESTS = parseInt(process.env.MAX_CONCURRENT_TESTS, 10);
    }
    if (process.env.MAX_CONCURRENT_INTEGRATION_TESTS) {
      envConfig.MAX_CONCURRENT_INTEGRATION_TESTS = parseInt(
        process.env.MAX_CONCURRENT_INTEGRATION_TESTS,
        10
      );
    }

    // 合并配置
    this.config = { ...this.config, ...envConfig };
  }

  /**
   * 获取配置值
   */
  get<K extends keyof TestConfig>(key: K): TestConfig[K] {
    return this.config[key];
  }

  /**
   * 设置配置值
   */
  set<K extends keyof TestConfig>(key: K, value: TestConfig[K]): void {
    this.config[key] = value;
  }

  /**
   * 获取所有配置
   */
  getAll(): TestConfig {
    return { ...this.config };
  }

  /**
   * 重置为默认配置
   */
  reset(): void {
    this.config = { ...defaultConfig };
  }

  /**
   * 应用配置到环境变量
   */
  applyToEnvironment(): void {
    Object.entries(this.config).forEach(([key, value]) => {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        process.env[key] = String(value);
      }
    });
  }

  /**
   * 获取测试超时配置
   */
  getTestTimeout(testType: 'unit' | 'integration' | 'e2e' | 'security'): number {
    switch (testType) {
      case 'unit':
        return this.get('UNIT_TEST_TIMEOUT');
      case 'integration':
        return this.get('INTEGRATION_TEST_TIMEOUT');
      case 'e2e':
        return this.get('E2E_TEST_TIMEOUT');
      case 'security':
        return this.get('SECURITY_TEST_TIMEOUT');
      default:
        return this.get('UNIT_TEST_TIMEOUT');
    }
  }

  /**
   * 检查是否启用调试模式
   */
  isDebugMode(): boolean {
    return this.get('DEBUG_TESTS') === 'true';
  }

  /**
   * 检查是否启用详细模式
   */
  isVerboseMode(): boolean {
    return this.get('VERBOSE_TESTS') === 'true';
  }

  /**
   * 检查是否启用模拟
   */
  shouldMockFileOperations(): boolean {
    return this.get('MOCK_FILE_OPERATIONS');
  }

  /**
   * 检查是否启用外部服务模拟
   */
  shouldMockExternalServices(): boolean {
    return this.get('MOCK_EXTERNAL_SERVICES');
  }
}

// 创建全局配置实例
export const testConfig = new TestConfigManager();
