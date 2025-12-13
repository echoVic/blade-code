# 🗄️ Zustand 状态管理系统

## 📋 概述

Blade 采用 **Zustand** 作为全局状态管理解决方案，取代了之前的 React Context 实现。这种架构转变提供了更简洁的 API、更好的性能和更灵活的使用方式，同时保持了单一数据源的原则。

## 🏗️ 架构设计

### 核心架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Zustand Store                          │
├─────────────────────────────────────────────────────────────┤
│  • 单一数据源（Single Source of Truth）                      │
│  • Slice 模块化设计                                         │
│  • 中间件支持（DevTools、Selector 订阅）                       │
│  • React & 非 React 环境共享                                 │
└─────────┬───────────────────────────────────────────────────┘
          │
┌─────────▼─────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐
│ Session Slice     │  │ Config Slice│  │ Focus Slice  │  │ Command Slice │
├───────────────────┤  ├─────────────┤  ├──────────────┤  ├───────────────┤
│ • 会话 ID 管理      │  │ • 配置管理    │  │ • 焦点管理    │  │ • 命令执行    │
│ • 消息历史管理      │  │ • 持久化集成  │  │ • 键盘导航    │  │ • 进度跟踪    │
│ • 思考状态          │  │              │  │              │  │               │
└─────────┬─────────┘  └─────────────┘  └──────────────┘  └───────────────┘
          │
┌─────────▼───────────────────────────────────────────────────┐
│                     React 组件层                            │
├─────────────────────────────────────────────────────────────┤
│  • 使用 useBladeStore Hook 订阅状态                          │
│  • 选择器（Selector）优化性能                                │
│  • Actions 更新状态                                          │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **单一数据源**：所有应用状态集中在一个 Store 中管理
2. **Slice 模块化**：状态按功能划分为独立模块
3. **只读状态**：组件只能通过 Actions 更新状态
4. **选择器优化**：使用选择器减少不必要的重渲染
5. **环境无关**：同时支持 React 和非 React 环境

## 📁 文件结构

```
src/store/
├── index.ts           # React Hook 入口
├── vanilla.ts         # 核心 Store 实例
├── types.ts           # 类型定义
├── slices/            # Slice 集合
│   ├── index.ts       # Slice 导出
│   ├── sessionSlice.ts# 会话状态
│   ├── configSlice.ts # 配置状态
│   ├── focusSlice.ts  # 焦点管理
│   └── commandSlice.ts# 命令执行
└── selectors/         # 优化的选择器
    └── index.ts       # 选择器导出
```

## 🚀 核心 API

### 1. React 组件使用

```typescript
import { useBladeStore } from '@/store';

// 基本使用（单一状态）
const messages = useBladeStore((state) => state.session.messages);
const isThinking = useBladeStore((state) => state.session.isThinking);

// 批量选择（使用对象选择器）
const { sessionId, messages } = useBladeStore((state) => ({
  sessionId: state.session.sessionId,
  messages: state.session.messages,
}));

// 更新状态（使用 Actions）
import { sessionActions } from '@/store';

sessionActions().addUserMessage('Hello Blade!');
sessionActions().setThinking(true);
```

### 2. 非 React 环境使用

```typescript
import { sessionActions, getState } from '@/store/vanilla';

// 获取状态
def getCurrentMessages():
  return getState().session.messages;

// 更新状态
def sendUserMessage(content: string):
  sessionActions().addUserMessage(content);
```

### 3. 配置管理

```typescript
import { configActions } from '@/store';

// 更新配置（自动持久化）
await configActions().setPermissionMode('yolo', { immediate: true });
await configActions().setTheme('dark');
await configActions().setCurrentModel('gpt-4');
```

### 4. 会话管理

```typescript
import { sessionActions } from '@/store';

// 添加消息
sessionActions().addUserMessage('帮我分析这个问题');
sessionActions().addAssistantMessage('好的，我来帮您分析');
sessionActions().addToolMessage('执行了文件分析工具');

// 管理会话状态
sessionActions().setThinking(true); // 开始思考
sessionActions().setThinking(false); // 思考结束
sessionActions().resetSession(); // 重置会话
```

## 🎯 Slice 职责

### Session Slice
- **核心职责**：管理对话会话
- **主要功能**：
  - 会话 ID 生成与管理
  - 消息历史 CRUD
  - 思考状态（isThinking）控制
  - 会话重置与恢复

### Config Slice
- **核心职责**：管理应用配置
- **主要功能**：
  - 配置数据存储
  - 配置更新与验证
  - 与 ConfigService 集成实现持久化

### Focus Slice
- **核心职责**：管理 UI 焦点
- **主要功能**：
  - 焦点状态跟踪
  - 键盘导航支持
  - 焦点自动管理

### Command Slice
- **核心职责**：管理命令执行
- **主要功能**：
  - 命令状态跟踪
  - 进度报告
  - 命令中止与恢复

## 🔧 最佳实践

### 1. 组件中使用

```typescript
// ✅ 推荐：使用选择器只订阅需要的状态
const messages = useBladeStore((state) => state.session.messages);

// ❌ 不推荐：订阅整个状态树
const state = useBladeStore((state) => state);

// ✅ 推荐：使用 Actions 更新状态
import { sessionActions } from '@/store';

sessionActions().addUserMessage('Hello');

// ❌ 不推荐：直接修改状态
// （Zustand 不允许直接修改，会抛出错误）
```

### 2. 非 React 环境

```typescript
// ✅ 推荐：使用专门的 Actions API
import { sessionActions, getState } from '@/store/vanilla';

// ✅ 推荐：使用预定义的优化选择器
import { selectSessionMessages } from '@/store/selectors';
const messages = selectSessionMessages(getState());
```

### 3. 性能优化

```typescript
// ✅ 推荐：使用 memoized 选择器
import { useCallback } from 'react';

const selectMessages = useCallback((state) => state.session.messages, []);
const messages = useBladeStore(selectMessages);

// ✅ 推荐：使用预定义的优化选择器
import { selectSessionMessages } from '@/store/selectors';
const messages = useBladeStore(selectSessionMessages);
```

### 4. 错误处理

```typescript
// ✅ 推荐：使用 try-catch 包装异步 Actions
async function updateConfig() {
  try {
    await configActions().setPermissionMode('yolo');
  } catch (error) {
    console.error('配置更新失败:', error);
  }
}
```

## 🔄 迁移指南

### 从旧的 Context API 迁移

#### 旧代码（React Context）

```typescript
// 旧的 Context 使用方式
import { useContext } from 'react';
import { AppContext } from '@/context/AppContext';

const { state, dispatch } = useContext(AppContext);

// 更新状态
dispatch({ type: 'ADD_USER_MESSAGE', payload: 'Hello' });
```

#### 新代码（Zustand）

```typescript
// 新的 Zustand 使用方式
import { useBladeStore, sessionActions } from '@/store';

// 获取状态
const messages = useBladeStore((state) => state.session.messages);

// 更新状态
sessionActions().addUserMessage('Hello');
```

### 关键变化

1. **API 简化**：
   - 不再需要定义 Action Types
   - 不再需要编写 Reducer
   - 直接调用命名清晰的 Actions

2. **性能提升**：
   - 内置选择器优化
   - 避免不必要的重渲染
   - 支持部分订阅

3. **灵活性增强**：
   - 支持非 React 环境
   - 中间件扩展
   - 更简单的测试

## 📊 性能特性

### 1. 选择器订阅
- **功能**：只订阅状态树中需要的部分
- **优势**：减少不必要的组件重渲染
- **使用**：`useBladeStore((state) => state.session.messages)`

### 2. 中间件支持
- **DevTools**：Redux DevTools 集成，支持时间旅行调试
- **subscribeWithSelector**：支持使用选择器订阅状态变化
- **Persist**：可选的持久化中间件（Blade 中通过专门系统实现）

### 3. 并发安全
- **特性**：同一时刻只允许一个更新操作
- **优势**：避免状态不一致
- **实现**：内置的队列机制

## 🔮 未来发展

### 1. 类型安全增强
- 更严格的 TypeScript 类型检查
- 自动生成的 Action 类型

### 2. 性能优化
- 更高效的选择器实现
- 延迟加载 Slice

### 3. 功能扩展
- 内置持久化支持
- 更丰富的中间件生态

## 🎉 总结

Zustand 状态管理系统为 Blade 提供了：

- **📦 简洁的 API**：减少样板代码，提高开发效率
- **⚡ 优秀的性能**：选择器优化和中间件支持
- **🔄 灵活的架构**：支持 React 和非 React 环境
- **🛡️ 类型安全**：完整的 TypeScript 支持
- **🔧 易于调试**：DevTools 集成和清晰的状态变更记录

这种架构设计不仅简化了状态管理，还提高了应用的整体性能和可维护性，为未来的功能扩展提供了坚实的基础。