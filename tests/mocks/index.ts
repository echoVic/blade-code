import { jest } from '@jest/globals';

/**
 * Mock 和 Stub 工具集合
 * 提供 Blade 项目测试所需的通用 Mock 和 Stub 功能
 */

// 类型定义
export interface MockConfig<T = any> {
  defaultValue?: T;
  errorValue?: Error;
  delay?: number;
  implementation?: (...args: any[]) => T;
  returnValue?: T;
}

export interface StubConfig {
  responses?: any[];
  errors?: Error[];
  sequence?: 'sequence' | 'random' | 'round-robin';
  delay?: number | number[];
}

// 基础 Mock 工厂类
export abstract class MockFactory {
  static create<T = any>(config: MockConfig<T> = {}): jest.Mock {
    const mockFn = jest.fn();

    if (config.implementation) {
      mockFn.mockImplementation(config.implementation);
    } else if (config.returnValue !== undefined) {
      mockFn.mockReturnValue(config.returnValue);
    } else if (config.errorValue) {
      mockFn.mockImplementation(() => {
        throw config.errorValue;
      });
    } else if (config.default !== undefined) {
      mockFn.mockReturnValue(config.defaultValue);
    }

    if (config.delay) {
      mockFn.mockImplementation(async (...args: any[]) => {
        await new Promise((resolve) => setTimeout(resolve, config.delay));
        return config.implementation
          ? config.implementation(...args)
          : config.returnValue;
      });
    }

    return mockFn;
  }

  static createAsync<T = any>(config: MockConfig<Promise<T>> = {}): jest.Mock {
    const asyncConfig = {
      ...config,
      returnValue: config.returnValue ? Promise.resolve(config.returnValue) : undefined,
      defaultValue: config.defaultValue
        ? Promise.resolve(config.defaultValue)
        : undefined,
      implementation: config.implementation
        ? async (...args: any[]) => config.implementation!(...args)
        : undefined,
      errorValue: config.errorValue ? Promise.reject(config.errorValue) : undefined,
    };

    return this.create(asyncConfig);
  }
}

// 特定类型的 Mock 工厂
export class APIMockFactory extends MockFactory {
  static createSuccessResponse<T>(data: T): jest.Mock {
    return this.createAsync({
      returnValue: {
        success: true,
        data,
        timestamp: new Date().toISOString(),
      },
    });
  }

  static createErrorResponse(error: string | Error, code: number = 500): jest.Mock {
    const errorObj = typeof error === 'string' ? new Error(error) : error;
    return this.createAsync({
      errorValue: errorObj,
    });
  }

  static createPaginatedResponse<T>(
    items: T[],
    page: number = 1,
    limit: number = 10
  ): jest.Mock {
    return this.createAsync({
      returnValue: {
        success: true,
        data: {
          items: items,
          pagination: {
            page,
            limit,
            total: items.length,
            totalPages: Math.ceil(items.length / limit),
          },
        },
        timestamp: new Date().toISOString(),
      },
    });
  }
}

export class FileSystemMockFactory extends MockFactory {
  static createFileExists(exists: boolean): jest.Mock {
    return this.create({ returnValue: exists });
  }

  static createFileRead(content: string | Buffer): jest.Mock {
    return this.create({ returnValue: content });
  }

  static createFileWrite(success: boolean = true): jest.Mock {
    return success
      ? this.create({ returnValue: undefined })
      : this.create({ errorValue: new Error('Failed to write file') });
  }

  static createDirectoryListing(files: string[]): jest.Mock {
    return this.create({ returnValue: files });
  }
}

export class NetworkMockFactory extends MockFactory {
  static createFetch(config: MockConfig<Response> = {}): jest.Mock {
    return this.create(config);
  }

  static createWebSocketEvents(): {
    on: jest.Mock;
    send: jest.Mock;
    close: jest.Mock;
  } {
    return {
      on: this.create(),
      send: this.create(),
      close: this.create(),
    };
  }
}

// Stub 工具类
export class StubFactory {
  static createSequential(responses: any[], config: StubConfig = {}): jest.Mock {
    const stub = jest.fn();
    let index = 0;

    stub.mockImplementation((...args: any[]) => {
      const response = responses[index % responses.length];
      index++;
      return response;
    });

    if (config.delay) {
      const delays = Array.isArray(config.delay) ? config.delay : [config.delay];
      stub.mockImplementation(async (...args: any[]) => {
        const delay = delays[(index - 1) % delays.length];
        await new Promise((resolve) => setTimeout(resolve, delay));
        return responses[(index - 1) % responses.length];
      });
    }

    return stub;
  }

  static createConditional(
    conditions: Array<{ predicate: (...args: any[]) => boolean; response: any }>,
    defaultResponse?: any
  ): jest.Mock {
    const stub = jest.fn();

    stub.mockImplementation((...args: any[]) => {
      const condition = conditions.find((cond) => cond.predicate(...args));
      return condition ? condition.response : defaultResponse;
    });

    return stub;
  }

  static createErrorFirst(successResponses: any[], error: Error): jest.Mock {
    return this.createSequential([error, ...successResponses]);
  }
}

// 环境变量 Mock
export class EnvMock {
  private originalEnv: Record<string, string | undefined>;
  private mockValues: Record<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.originalEnv = { ...process.env };
    this.mockValues = values;
  }

  set(key: string, value: string): void {
    this.mockValues[key] = value;
    process.env[key] = value;
  }

  get(key: string): string | undefined {
    return this.mockValues[key];
  }

  restore(): void {
    Object.assign(process.env, this.originalEnv);
  }

  static create(values: Record<string, string>): EnvMock {
    const mock = new EnvMock(values);
    Object.assign(process.env, values);
    return mock;
  }
}

// 模块 Mock 工具
export class ModuleMock {
  private static mockedModules = new Set<string>();

  static mock(modulePath: string, mockExports: any): void {
    jest.doMock(modulePath, () => mockExports);
    this.mockedModules.add(modulePath);
  }

  static unmock(modulePath: string): void {
    jest.unmock(modulePath);
    this.mockedModules.delete(modulePath);
  }

  static unmockAll(): void {
    this.mockedModules.forEach((modulePath) => {
      jest.unmock(modulePath);
    });
    this.mockedModules.clear();
  }

  static clearAllMocks(): void {
    jest.clearAllMocks();
  }

  static restoreAllMocks(): void {
    jest.restoreAllMocks();
  }
}

// 定时器 Mock 工具
export class TimerMock {
  private originalDate: typeof Date;
  private originalSetTimeout: typeof setTimeout;
  private originalSetInterval: typeof setInterval;
  private originalClearTimeout: typeof clearTimeout;
  private originalClearInterval: typeof clearInterval;

  constructor() {
    this.originalDate = Date;
    this.originalSetTimeout = setTimeout;
    this.originalSetInterval = setInterval;
    this.originalClearTimeout = clearTimeout;
    this.originalClearInterval = clearInterval;
  }

  static setup(): void {
    jest.useFakeTimers();
  }

  static advanceBy(ms: number): void {
    jest.advanceTimersByTime(ms);
  }

  static advanceTo(nextTime: number | Date): void {
    jest.advanceTimersToNextTimer(nextTime);
  }

  static runAll(): void {
    jest.runAllTimers();
  }

  static runOnlyPending(): void {
    jest.runOnlyPendingTimers();
  }

  static restore(): void {
    jest.useRealTimers();
  }
}

// 事件 Mock 工具
export class EventEmitterMock {
  private events: Map<string, Function[]> = new Map();
  private onceEvents: Map<string, Function[]> = new Map();

  on(event: string, listener: Function): this {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event)!.push(listener);
    return this;
  }

  once(event: string, listener: Function): this {
    if (!this.onceEvents.has(event)) {
      this.onceEvents.set(event, []);
    }
    this.onceEvents.get(event)!.push(listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    let hasListeners = false;

    // 处理常规监听器
    const listeners = this.events.get(event);
    if (listeners) {
      listeners.forEach((listener) => {
        listener(...args);
      });
      hasListeners = true;
    }

    // 处理一次性监听器
    const onceListeners = this.onceEvents.get(event);
    if (onceListeners) {
      onceListeners.forEach((listener) => {
        listener(...args);
      });
      this.onceEvents.delete(event);
      hasListeners = true;
    }

    return hasListeners;
  }

  off(event: string, listener?: Function): this {
    if (listener) {
      const listeners = this.events.get(event);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    } else {
      this.events.delete(event);
    }
    return this;
  }

  removeAllListeners(): this {
    this.events.clear();
    this.onceEvents.clear();
    return this;
  }

  static create(): EventEmitterMock {
    return new EventEmitterMock();
  }
}

// 数据库 Mock 工具
export class DatabaseMock {
  private data: Map<string, any> = new Map();
  private tables: Map<string, Map<string, any>> = new Map();

  constructor() {
    this.data.set('users', new Map());
    this.data.set('sessions', new Map());
    this.data.set('logs', new Map());
  }

  createTable(name: string): void {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
    }
  }

  insert(table: string, id: string, data: any): void {
    const tableData = this.tables.get(table) || new Map();
    tableData.set(id, { ...data, id, createdAt: new Date().toISOString() });
    this.tables.set(table, tableData);
  }

  find(table: string, id: string): any {
    return this.tables.get(table)?.get(id);
  }

  findAll(table: string): any[] {
    const tableData = this.tables.get(table) || new Map();
    return Array.from(tableData.values());
  }

  update(table: string, id: string, data: Partial<any>): boolean {
    const tableData = this.tables.get(table);
    if (!tableData || !tableData.has(id)) {
      return false;
    }

    const existing = tableData.get(id);
    tableData.set(id, {
      ...existing,
      ...data,
      updatedAt: new Date().toISOString(),
    });

    return true;
  }

  delete(table: string, id: string): boolean {
    const tableData = this.tables.get(table);
    if (!tableData || !tableData.has(id)) {
      return false;
    }

    tableData.delete(id);
    return true;
  }

  query(table: string, filter: (item: any) => boolean): any[] {
    const tableData = this.tables.get(table) || new Map();
    return Array.from(tableData.values()).filter(filter);
  }

  clear(): void {
    this.tables.clear();
  }

  static create(): DatabaseMock {
    return new DatabaseMock();
  }
}

// 导出所有工具
export {
  MockFactory,
  APIMockFactory,
  FileSystemMockFactory,
  NetworkMockFactory,
  StubFactory,
  EnvMock,
  ModuleMock,
  TimerMock,
  EventEmitterMock,
  DatabaseMock,
};
