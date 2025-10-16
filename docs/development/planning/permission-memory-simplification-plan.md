# 权限记忆系统简化方案

> 基于对 Claude Code 的深入调研，优化 Blade 的权限记忆机制

## 背景

### 问题陈述

原设计包含三级权限记忆：`once`、`session`、`always`

经过对主流 CLI agent（Claude Code、Aider 等）的调研，发现：

1. **Always 是伪需求**：CLI 是项目级别的工作模式，全局权限使用场景极少
2. **Session 才是核心**：项目本地持久化，跨会话有效，不影响团队
3. **Claude Code 的设计**：UI 只提供 Once 和 Session，Always 需手动配置

### Claude Code 的实际行为

```
UI 确认选项:
1. Yes (once)                          → 内存，仅此一次
2. Yes, don't ask again this session   → 写入 settings.local.json
   ↑ Shift+Tab 快捷键

"Always" 的实现方式:
- 不在 UI 中提供
- 通过手动编辑配置文件
- 或使用 /allowed-tools 命令
```

**关键洞察**：Session 在 Claude Code 中**写入文件**（settings.local.json），而非仅保存在内存中。

---

## 解决方案

### 一、简化为两级权限记忆（Once + Session）

#### 1.1 类型定义

```typescript
// src/tools/types/ExecutionTypes.ts

export type PermissionApprovalScope = 'session';  // 移除 'always'

interface ConfirmationResponse {
  approved: boolean;
  scope?: 'once' | 'session';  // 移除 'always'
}
```

#### 1.2 删除文件

- `src/tools/execution/PermissionMemory.ts` - 不再需要单独的内存管理类

#### 1.3 UI 选项

```typescript
// src/ui/components/ConfirmationPrompt.tsx

const options = [
  {
    label: '[Y] Yes (once only)',
    value: { approved: true, scope: 'once' }
  },
  {
    label: '[S] Yes, remember for this project (Shift+Tab)',
    value: { approved: true, scope: 'session' }
  },
  {
    label: '[N] No',
    value: { approved: false }
  }
];
```

#### 1.4 Session 行为

- **写入位置**: `.blade/settings.local.json`
- **Git 状态**: 自动添加到 `.gitignore`（保持现有 `ensureGitIgnore()` 逻辑）
- **生命周期**: 项目内持久化，但不跨机器同步
- **适用场景**: "这个项目我信任这些操作，但仅限本机"

#### 1.5 全局权限的方式

如果用户需要全局或团队共享的权限配置：
- 手动编辑 `~/.blade/settings.json` (全局配置)
- 手动编辑 `.blade/settings.json` (项目共享配置，提交到 Git)

---

### 二、实现 `/permissions` 命令

#### 2.1 核心设计原则（对齐 Claude Code）

Claude Code 的 `/permissions` 命令特点：
- **只管理** `settings.local.json` (项目本地配置)
- **显示所有来源**的规则（全局+项目+本地），但只能编辑本地规则
- 提供 Add/Delete 功能，操作对象仅限 local 配置

**设计理念**：
```
/permissions 命令 → 只管理 settings.local.json (项目本地，不提交)
全局/共享配置 → 手动编辑文件
```

**好处**：
- ✅ 简单清晰：UI 工具只管理本地配置
- ✅ 避免混淆：不用问用户"要保存到哪个配置文件？"
- ✅ 安全：不会误操作影响团队或全局配置
- ✅ 对齐 Session 概念：`/permissions` 就是管理 "本项目的临时信任规则"

#### 2.2 UI 交互设计

##### 多 Tab 视图

```
Permissions: [Allow] [Ask] [Deny] [Info] (Tab to cycle)
```

使用 Tab 键在 4 个视图之间切换。

##### Allow 视图示例

```
> 1. Add a new rule...
  2. Read(file_path:**/*.ts)    [项目共享配置]
  3. Grep                        [用户全局配置]
  4. Bash(git status:*)          [本地配置] ← 可删除
```

- 显示所有来源的 allow 规则
- 标注规则来源（用户全局/项目共享/本地配置）
- 只有 [本地配置] 的规则可以删除

##### 添加规则界面

```
Add allow permission rule

Permission rules are a tool name, optionally followed by a specifier in
parentheses.
e.g., WebFetch or Bash(ls:*)

Enter permission rule…
┌────────────────────────────────────────────────┐
│                                                │
└────────────────────────────────────────────────┘

Enter to submit · Esc to cancel
```

- 提供清晰的格式说明
- 给出具体示例
- 使用 TextInput 组件

##### 删除规则确认（本地规则）

```
Delete allowed tool?

Bash(awk:*)
Any Bash command starting with awk
From project local settings

Are you sure you want to delete this permission rule?
> 1. Yes
  2. No

Esc to cancel
```

##### 尝试删除非本地规则时

```
Cannot delete this rule

Read(file_path:**/*.ts)
From project shared settings

This rule is defined in .blade/settings.json.
Please edit the file manually to remove it.

Press any key to continue
```

- 明确告知用户为什么不能删除
- 指导用户如何手动编辑

##### Info 视图

```
配置文件优先级（从高到低）:

1. .blade/settings.local.json  (本地配置，不提交 Git)
   ✓ 存在 - 3 条规则

2. .blade/settings.json  (项目配置，提交 Git)
   ✓ 存在 - 5 条规则

3. ~/.blade/settings.json  (用户全局配置)
   ✓ 存在 - 2 条规则

说明:
- /permissions 命令只管理本地配置 (settings.local.json)
- 修改全局或项目配置请直接编辑对应文件
- 本地配置会自动加入 .gitignore，不会提交到版本控制
```

#### 2.3 技术实现

##### 文件结构

```
src/slash-commands/
├── permissions.ts          # 命令入口
├── builtinCommands.ts      # 注册命令

src/ui/components/
├── PermissionsManager.tsx  # 交互式 UI 主组件
├── PermissionsList.tsx     # 规则列表组件
├── PermissionAddForm.tsx   # 添加规则表单
└── PermissionDeleteConfirm.tsx  # 删除确认对话框
```

##### 核心逻辑

```typescript
// src/slash-commands/permissions.ts

export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  description: '查看和管理工具权限规则',
  execute: async (args, context) => {
    // 渲染 PermissionsManager 组件
    // 传入 ConfigManager 实例
    // 处理用户交互
  }
};
```

```typescript
// src/ui/components/PermissionsManager.tsx

export const PermissionsManager: React.FC<Props> = ({ configManager }) => {
  const [currentTab, setCurrentTab] = useState<'allow' | 'ask' | 'deny' | 'info'>('allow');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<'list' | 'add' | 'delete'>('list');

  // 读取所有配置源
  const userConfig = configManager.loadUserSettings();
  const projectConfig = configManager.loadProjectSettings();
  const localConfig = configManager.loadLocalSettings();

  // 合并并标注来源
  const rules = mergeRulesWithSource([
    { rules: userConfig.permissions.allow, source: '用户全局配置' },
    { rules: projectConfig.permissions.allow, source: '项目共享配置' },
    { rules: localConfig.permissions.allow, source: '本地配置' },
  ]);

  // Tab 切换
  useInput((input, key) => {
    if (key.tab) {
      const tabs = ['allow', 'ask', 'deny', 'info'];
      const nextIndex = (tabs.indexOf(currentTab) + 1) % tabs.length;
      setCurrentTab(tabs[nextIndex]);
    }
  });

  // 添加规则
  const handleAddRule = async (rule: string) => {
    await configManager.appendLocalPermissionAllowRule(rule);
    setMode('list');
  };

  // 删除规则
  const handleDeleteRule = async (rule: RuleWithSource) => {
    if (rule.source !== '本地配置') {
      // 显示错误提示
      return;
    }
    await configManager.removeLocalPermissionRule(rule.pattern);
    setMode('list');
  };

  return (
    <Box flexDirection="column">
      {/* Tab 导航 */}
      <TabNavigation currentTab={currentTab} />

      {/* 内容区域 */}
      {mode === 'list' && (
        <PermissionsList
          rules={rules}
          onAdd={() => setMode('add')}
          onDelete={(rule) => setMode('delete')}
        />
      )}

      {mode === 'add' && (
        <PermissionAddForm
          category={currentTab}
          onSubmit={handleAddRule}
          onCancel={() => setMode('list')}
        />
      )}

      {mode === 'delete' && (
        <PermissionDeleteConfirm
          rule={selectedRule}
          onConfirm={handleDeleteRule}
          onCancel={() => setMode('list')}
        />
      )}
    </Box>
  );
};
```

##### ConfigManager 新增方法

```typescript
// src/config/ConfigManager.ts

/**
 * 将权限规则追加到项目本地 settings.local.json 的 allow 列表
 */
async appendLocalPermissionAllowRule(rule: string): Promise<void> {
  const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');

  // 读取现有配置
  const existingSettings = (await this.loadJsonFile(localSettingsPath)) ?? {};
  const permissions = existingSettings.permissions ?? { allow: [], ask: [], deny: [] };

  // 添加规则（去重）
  if (!permissions.allow.includes(rule)) {
    permissions.allow = [...permissions.allow, rule];
    existingSettings.permissions = permissions;

    // 写入文件
    await fs.writeFile(
      localSettingsPath,
      JSON.stringify(existingSettings, null, 2),
      { mode: 0o600, encoding: 'utf-8' }
    );
  }

  // 更新内存配置
  if (this.config && !this.config.permissions.allow.includes(rule)) {
    this.config.permissions.allow = [...this.config.permissions.allow, rule];
  }
}

/**
 * 从项目本地 settings.local.json 删除权限规则
 */
async removeLocalPermissionRule(rule: string, category: 'allow' | 'ask' | 'deny'): Promise<void> {
  const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');

  const existingSettings = (await this.loadJsonFile(localSettingsPath)) ?? {};
  const permissions = existingSettings.permissions ?? { allow: [], ask: [], deny: [] };

  // 删除规则
  permissions[category] = permissions[category].filter(r => r !== rule);
  existingSettings.permissions = permissions;

  // 写入文件
  await fs.writeFile(
    localSettingsPath,
    JSON.stringify(existingSettings, null, 2),
    { mode: 0o600, encoding: 'utf-8' }
  );

  // 更新内存配置
  if (this.config) {
    this.config.permissions[category] = this.config.permissions[category].filter(r => r !== rule);
  }
}

/**
 * 加载本地配置文件（单独读取，不合并）
 */
async loadLocalSettings(): Promise<Partial<BladeConfig>> {
  const localSettingsPath = path.join(process.cwd(), '.blade', 'settings.local.json');
  return (await this.loadJsonFile(localSettingsPath)) ?? {};
}
```

##### 集成到 Slash Commands

```typescript
// src/slash-commands/builtinCommands.ts

import { permissionsCommand } from './permissions.js';
import { themeCommand } from './theme.js';

export const builtinCommands: Record<string, SlashCommand> = {
  theme: themeCommand,
  permissions: permissionsCommand,  // 新增
};
```

---

### 三、变更总结

#### 删除

- `src/tools/execution/PermissionMemory.ts` - 不再需要内存管理类

#### 修改

1. **类型定义**:
   - `src/tools/types/ExecutionTypes.ts` - 移除 `'always'` 类型

2. **UI 组件**:
   - `src/ui/components/ConfirmationPrompt.tsx` - 移除 "Allow always" 选项

3. **执行管道**:
   - `src/tools/execution/PipelineStages.ts` - Session 写入 settings.local.json

4. **配置管理**:
   - `src/config/ConfigManager.ts` - 新增本地配置读写方法

5. **Slash Commands**:
   - `src/slash-commands/builtinCommands.ts` - 注册 permissions 命令

6. **文档**:
   - `docs/development/architecture/confirmation-flow.md` - 更新权限记忆说明
   - `docs/public/configuration/permissions.md` - 添加 `/permissions` 命令用法

#### 新增

1. **Slash Command**:
   - `src/slash-commands/permissions.ts` - 命令实现

2. **UI 组件**:
   - `src/ui/components/PermissionsManager.tsx` - 主界面
   - `src/ui/components/PermissionsList.tsx` - 规则列表
   - `src/ui/components/PermissionAddForm.tsx` - 添加表单
   - `src/ui/components/PermissionDeleteConfirm.tsx` - 删除确认

#### 保持不变

- `ConfigManager.ensureGitIgnore()` - 继续自动添加 settings.local.json 到 .gitignore
- 配置文件优先级逻辑（本地 > 项目 > 用户）

---

## 设计理念

### 四级权限模型

```
1. Once (不保存)
   - 仅此一次操作
   - 不留任何痕迹
   - 适合临时需求

2. Session (settings.local.json)
   - 项目本地持久化
   - 跨会话有效
   - 不提交到 Git
   - 适合："这个项目我信任这些操作，但仅限本机"

3. 全局配置 (~/.blade/settings.json)
   - 所有项目生效
   - 需要深思熟虑
   - 手动编辑文件
   - 适合："我在所有项目都信任这个操作"

4. 项目共享配置 (.blade/settings.json)
   - 团队协作
   - 提交到 Git
   - 手动编辑文件
   - 适合："团队一致的权限策略"
```

### 关键原则

1. **UI 只提供 Once 和 Session**
   - Session 已覆盖 99% 的"记住权限"需求
   - 全局配置应该是主动决定，不应该是"确认时顺手点了 Always"

2. **`/permissions` 只管理本地配置**
   - 简单清晰，不会误操作
   - 对齐 Session 的语义
   - 全局/共享配置需要手动编辑

3. **对齐 Claude Code 设计**
   - 学习成熟产品的设计哲学
   - 降低用户学习成本

---

## 实施步骤

### Phase 1: 权限记忆简化（核心）

1. 修改类型定义，移除 `'always'`
2. 更新 ConfirmationPrompt UI
3. 删除 PermissionMemory.ts
4. 更新 PipelineStages 逻辑
5. 单元测试和集成测试

### Phase 2: `/permissions` 命令实现

1. 创建 Slash Command 入口
2. 实现 PermissionsManager 主组件
3. 实现子组件（列表、表单、确认框）
4. ConfigManager 新增方法
5. 集成测试

### Phase 3: 文档更新

1. 更新架构文档
2. 更新用户文档
3. 添加 `/permissions` 使用指南

---

## 预期效果

### 用户体验提升

1. **更简单的权限模型**
   - 只需理解 Once 和 Session
   - 减少选择困难

2. **便捷的权限管理**
   - `/permissions` 命令可视化管理
   - 不需要记住配置文件路径

3. **更安全的默认行为**
   - Session 写入本地，不影响团队
   - 全局配置需要主动决定

### 技术优势

1. **对齐主流实践**
   - 学习 Claude Code 的成熟设计
   - 降低维护成本

2. **代码简化**
   - 删除 PermissionMemory 类
   - 统一配置管理逻辑

3. **可扩展性**
   - `/permissions` 命令可以继续扩展功能
   - 为未来的权限增强预留空间

---

## 参考资料

- [Claude Code 权限系统调研](https://github.com/anthropics/claude-code/issues/7472)
- [Claude Code 官方文档 - Settings](https://docs.claude.com/en/docs/claude-code/settings)
- [Blade 配置系统文档](../configuration/config-system.md)
- [Blade 确认流程文档](../architecture/confirmation-flow.md)
