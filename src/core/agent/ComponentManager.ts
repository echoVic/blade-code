import { EventEmitter } from 'events';
import { BaseComponent } from './BaseComponent.js';
import { LoggerComponent } from './LoggerComponent.js';

/**
 * 组件管理器配置
 */
export interface ComponentManagerConfig {
  debug?: boolean;
  autoInit?: boolean;
}

/**
 * 组件事件接口
 */
export interface ComponentEvent {
  id: string;
  component?: BaseComponent;
  error?: Error;
}

/**
 * 组件管理器
 * 负责管理所有组件的生命周期和状态
 */
export class ComponentManager extends EventEmitter {
  private components = new Map<string, BaseComponent>();
  private config: ComponentManagerConfig;
  private isInitialized = false;
  private isDestroyed = false;
  private logger: LoggerComponent = new LoggerComponent('component-manager');

  constructor(config: ComponentManagerConfig = {}) {
    super();
    this.config = {
      debug: false,
      autoInit: true,
      ...config,
    };
  }

  /**
   * 初始化所有组件
   */
  public async init(): Promise<void> {
    if (this.isInitialized) {
      this.log('组件管理器已经初始化');
      return;
    }

    if (this.isDestroyed) {
      throw new Error('组件管理器已被销毁，无法重新初始化');
    }

    this.log('初始化组件管理器...');

    try {
      // 初始化所有组件
      for (const [name, component] of this.components) {
        this.log(`初始化组件: ${name}`);
        try {
          await component.init();
          this.emit('componentInitialized', { id: name, component });
        } catch (error) {
          this.log(`组件 ${name} 初始化失败: ${error}`);
          this.emit('componentInitializationFailed', {
            id: name,
            component,
            error: error as Error,
          });
          throw error;
        }
      }

      this.isInitialized = true;
      this.log('组件管理器初始化完成');
      this.emit('initialized');
    } catch (error) {
      this.log(`组件管理器初始化失败: ${error}`);
      throw error;
    }
  }

  /**
   * 销毁所有组件
   */
  public async destroy(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.log('销毁组件管理器...');

    try {
      // 销毁所有组件
      for (const [name, component] of this.components) {
        this.log(`销毁组件: ${name}`);
        try {
          await component.destroy();
          this.emit('componentDestroyed', { id: name, component });
        } catch (error) {
          this.log(`组件 ${name} 销毁失败: ${error}`);
          this.emit('componentDestructionFailed', { id: name, component, error: error as Error });
        }
      }

      this.isDestroyed = true;
      this.log('组件管理器已销毁');
      this.emit('destroyed');
    } catch (error) {
      this.log(`组件管理器销毁失败: ${error}`);
      throw error;
    }
  }

  /**
   * 注册组件
   */
  public async registerComponent(component: BaseComponent): Promise<void> {
    const id = component.getId();

    if (this.components.has(id)) {
      throw new Error(`组件 "${id}" 已存在`);
    }

    this.components.set(id, component);
    this.log(`组件 "${id}" 已注册`);
    this.emit('componentRegistered', { id, component });

    // 如果管理器已初始化且启用自动初始化，立即初始化新组件
    if (this.isInitialized && this.config.autoInit) {
      try {
        await component.init();
        this.log(`组件 "${id}" 已自动初始化`);
        this.emit('componentInitialized', { id, component });
      } catch (error) {
        this.log(`组件 "${id}" 自动初始化失败: ${error}`);
        this.emit('componentInitializationFailed', { id, component, error: error as Error });
        throw error;
      }
    }
  }

  /**
   * 获取组件
   */
  public getComponent<T extends BaseComponent>(id: string): T | undefined {
    return this.components.get(id) as T;
  }

  /**
   * 检查组件是否存在
   */
  public hasComponent(id: string): boolean {
    return this.components.has(id);
  }

  /**
   * 移除组件
   */
  public async removeComponent(id: string): Promise<boolean> {
    const component = this.components.get(id);
    if (!component) {
      return false;
    }

    try {
      // 如果管理器已初始化，先销毁组件
      if (this.isInitialized) {
        await component.destroy();
        this.emit('componentDestroyed', { id, component });
      }

      this.components.delete(id);
      this.log(`组件 "${id}" 已移除`);
      this.emit('componentRemoved', { id });
      return true;
    } catch (error) {
      this.log(`移除组件 "${id}" 失败: ${error}`);
      this.emit('componentRemovalFailed', { id, component, error: error as Error });
      throw error;
    }
  }

  /**
   * 获取所有组件ID
   */
  public getComponentIds(): string[] {
    return Array.from(this.components.keys());
  }

  /**
   * 获取所有组件
   */
  public getAllComponents(): Map<string, BaseComponent> {
    return new Map(this.components);
  }

  /**
   * 按类型获取组件
   */
  public getComponentsByType<T extends BaseComponent>(
    componentClass: new (...args: any[]) => T
  ): T[] {
    const result: T[] = [];
    for (const component of this.components.values()) {
      if (component instanceof componentClass) {
        result.push(component as T);
      }
    }
    return result;
  }

  /**
   * 搜索组件
   */
  public searchComponents(predicate: (component: BaseComponent) => boolean): BaseComponent[] {
    const result: BaseComponent[] = [];
    for (const component of this.components.values()) {
      if (predicate(component)) {
        result.push(component);
      }
    }
    return result;
  }

  /**
   * 批量注册组件
   */
  public async registerComponents(components: BaseComponent[]): Promise<void> {
    for (const component of components) {
      await this.registerComponent(component);
    }
  }

  /**
   * 批量移除组件
   */
  public async removeComponents(ids: string[]): Promise<{ [id: string]: boolean }> {
    const results: { [id: string]: boolean } = {};

    for (const id of ids) {
      try {
        results[id] = await this.removeComponent(id);
      } catch (error) {
        results[id] = false;
      }
    }

    return results;
  }

  /**
   * 重启组件
   */
  public async restartComponent(id: string): Promise<boolean> {
    const component = this.components.get(id);
    if (!component) {
      return false;
    }

    try {
      this.log(`重启组件: ${id}`);

      // 销毁组件
      await component.destroy();
      this.emit('componentDestroyed', { id, component });

      // 重新初始化组件
      await component.init();
      this.emit('componentInitialized', { id, component });

      this.log(`组件 "${id}" 重启完成`);
      this.emit('componentRestarted', { id, component });
      return true;
    } catch (error) {
      this.log(`组件 "${id}" 重启失败: ${error}`);
      this.emit('componentRestartFailed', { id, component, error: error as Error });
      throw error;
    }
  }

  /**
   * 获取组件状态
   */
  public getComponentStatus(id: string): {
    exists: boolean;
    initialized: boolean;
    component?: BaseComponent;
  } {
    const component = this.components.get(id);
    return {
      exists: !!component,
      initialized: this.isInitialized,
      component,
    };
  }

  /**
   * 获取管理器状态
   */
  public getStatus() {
    return {
      isInitialized: this.isInitialized,
      isDestroyed: this.isDestroyed,
      componentCount: this.components.size,
      componentIds: this.getComponentIds(),
      config: this.config,
    };
  }

  /**
   * 获取健康状态
   */
  public async getHealthStatus(): Promise<{
    healthy: boolean;
    components: { [id: string]: { healthy: boolean; error?: string } };
  }> {
    const components: { [id: string]: { healthy: boolean; error?: string } } = {};
    let overallHealthy = true;

    for (const [id] of this.components) {
      try {
        // 这里可以添加组件健康检查逻辑
        // 目前简单检查组件是否存在
        components[id] = { healthy: true };
      } catch (error) {
        components[id] = { healthy: false, error: (error as Error).message };
        overallHealthy = false;
      }
    }

    return {
      healthy: overallHealthy && this.isInitialized && !this.isDestroyed,
      components,
    };
  }

  /**
   * 等待组件初始化完成
   */
  public async waitForInitialization(timeout: number = 30000): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('组件初始化超时'));
      }, timeout);

      this.once('initialized', () => {
        clearTimeout(timer);
        resolve();
      });

      this.once('initializationFailed', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * 日志记录
   */
  private log(message: string): void {
    if (this.config.debug) {
      this.logger.debug(`[ComponentManager] ${message}`, { 
        component: 'component-manager', 
        action: 'log' 
      });
    }
  }
}
