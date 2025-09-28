/**
 * 组件基类
 * 提供组件的基本实现，可被具体组件继承
 */
export abstract class BaseComponent {
  protected id: string;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * 获取组件ID
   */
  public getId(): string {
    return this.id;
  }

  /**
   * 获取组件名称（兼容性方法）
   */
  get name(): string {
    return this.id;
  }

  /**
   * 初始化组件
   * 子类应重写此方法实现具体的初始化逻辑
   */
  public async init(): Promise<void> {
    // 基础实现，子类应重写
  }

  /**
   * 销毁组件
   * 子类应重写此方法实现具体的销毁逻辑
   */
  public async destroy(): Promise<void> {
    // 基础实现，子类应重写
  }
}
