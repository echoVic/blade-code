---
name: knowledge-extension-ecosystem-skills-and-custom-commands
description: >
  覆盖 SkillRegistry、SKILL.md 延迟加载、自定义命令 Markdown 解析、来源覆盖、插件
  命名空间、Session 快照和模型/用户调用入口。进入条件：新增 Skill 或命令字段、调整
  发现优先级、调试 /command 或 Skill 工具、修改 Prompt 元数据或消费者集成。不包含：
  插件安装生命周期（见 ../plugin-lifecycle-and-marketplace/）、通用工具权限执行
  （见 ../../tool-and-automation-platform/）。关键词：SkillRegistry、SkillLoader、
  CustomCommandRegistry、SlashCommand、user-invocable、disable-model-invocation。
---

## Module Structure

Skills 与自定义命令共享“Markdown + frontmatter”的扩展形态，但加载与执行模型不同：
Skills 启动时只暴露元数据并按需读取正文，命令发现时即读取正文并在调用时展开动态内容。

### Directory Layout
- `packages/cli/src/skills/` — Skill 解析、发现、安装、元数据注入与注册表
- `packages/cli/src/slash-commands/custom/` — 自定义命令发现、解析、执行与注册表
- `packages/cli/src/tools/builtin/system/skill.ts` — 模型调用 Skill 的工具适配
- `packages/cli/src/tools/builtin/system/slashCommand.ts` — 模型调用自定义命令的工具适配
- `.blade/skills/` — 当前仓库的项目级 Skills
- `.blade/commands/` — 当前仓库的项目级自定义命令

### Key Entry Points
- `SkillRegistry.initialize()` in `packages/cli/src/skills/SkillRegistry.ts` — 按来源优先级发现 Skill 元数据
- `SkillRegistry.loadContent()` in `packages/cli/src/skills/SkillRegistry.ts` — 调用时加载完整 Skill 正文
- `CustomCommandRegistry.initialize()` in `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts` — 建立 Workspace 命令视图
- `CustomCommandRegistry.executeCommand()` in `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts` — 展开命令正文
- `snapshotWorkspaceAgentResources()` in `packages/cli/src/agent/resources/WorkspaceAgentResources.ts` — 将两类注册表冻结到 Session

## API Surface

### SkillRegistry
- `initialize()` — 安装默认 Skill fallback、扫描来源并返回发现错误
- `loadContent(name)` — 对文件系统 Skill 延迟重读 `SKILL.md`，内置 Skill 走内存内容
- `getModelInvocableSkills()` — 排除 `disable-model-invocation`
- `getUserInvocableSkills()` — 仅返回 `user-invocable: true`
- `generateAvailableSkillsList()` — 生成稳定排序、描述有界的 Prompt 元数据
- `snapshot()` — 深拷贝元数据和插件 Skill，形成 Session 私有视图

### CustomCommandRegistry
- `initialize(workspaceRoot)` — 发现命令并按 Workspace Trust 过滤项目来源
- `executeCommand(name, context)` — 执行参数、Shell 和文件引用展开
- `executePluginCommand(name, context)` — 将 namespaced plugin command 适配为普通命令执行
- `generateCommandListDescription(charBudget)` — 为 `SlashCommand` 工具生成有预算的目录
- `snapshot()` — 复制命令、插件命令和最近发现结果

### Loaders
- `loadSkillMetadata()` / `loadSkillContent()` — 分离 Skill 元数据与正文读取(`packages/cli/src/skills/SkillLoader.ts`)
- `CustomCommandLoader.discover()` — 递归读取四个命令来源(`packages/cli/src/slash-commands/custom/CustomCommandLoader.ts`)

## Usage Examples

### 冻结到 Session 资源快照 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
```typescript
return {
  projectRoot: path.resolve(projectRoot),
  subagents: resources.subagents.snapshot(),
  skills: resources.skills.snapshot(),
  commands: resources.commands.snapshot(),
  hooks: snapshotHookConfig(config),
};
```

### 将 Session 注册表注入工具 (`packages/cli/src/tools/builtin/index.ts`)
```typescript
const skillRegistry = opts?.agentResources?.skills ?? getSkillRegistry({ cwd: resourceRoot });
const commandRegistry =
  opts?.agentResources?.commands ?? CustomCommandRegistry.getInstance(resourceRoot);
createSkillTool(skillRegistry);
createSlashCommandTool(commandRegistry);
```

### 把可由用户调用的 Skill 路由为 slash command (`packages/cli/src/slash-commands/index.ts`)
```typescript
const skill = resources.skills
  .getUserInvocableSkills()
  .find((candidate) => candidate.name === command);
if (skill) {
  return createSkillSlashCommand(skill).handler(args, context);
}
```

## Gotchas
- Skill 覆盖顺序最终以 `.blade/skills` 最高，而命令最终以 `.claude/commands` 最高；两套看似对称的目录不能套用同一优先级假设(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandLoader.ts`)
- 未信任 workspace 下，SkillRegistry 根本不扫描项目 Skill 目录；命令 loader 会先读取项目 Markdown，再由 Registry 过滤项目来源，二者的信任边界发生在不同阶段(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)
- 活动 Session 持有注册表快照；调用 `/skills` 刷新 Workspace 注册表和插件资源不会改变已创建 Session 已看到的 Skill/命令集合(`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/src/slash-commands/skills.ts`, `git:f6a82242`)
- `Skill` 工具 schema 接受 `args`，但当前实现只按名称加载正文，没有把参数插入 Skill 指令；不要把 `argument-hint` 当作运行时参数传递保证(`packages/cli/src/tools/builtin/system/skill.ts`)
- Skill 运行时解析器只识别 `allowed-tools`、`argument-hint`、`user-invocable` 和 `disable-model-invocation` 等 kebab-case key；使用文档示例中的 camelCase key 会被静默忽略(`packages/cli/src/skills/SkillLoader.ts`, `docs/guides/skills.md`)
- Skill 的 `disable-model-invocation` 只影响 available list，`createSkillTool()` 本身不再次拒绝已知名称；自定义命令工具则在执行前显式检查该字段(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/tools/builtin/system/skill.ts`, `packages/cli/src/tools/builtin/system/slashCommand.ts`)
- 自定义命令的 `!` Shell 嵌入由 `execSync` 在正文送给模型前直接执行，不经过 ToolExecutor 的常规工具权限、Hook 和调度；其安全前提是命令来源本身已受信(`packages/cli/src/slash-commands/custom/CustomCommandExecutor.ts`)
- 自定义命令的 `@path` 使用 `path.resolve(workspaceRoot, value)`，当前没有强制 workspace containment；命令作者可引用父目录或绝对解析结果，不能把它视为受限 Read 工具(`packages/cli/src/slash-commands/custom/CustomCommandExecutor.ts`)
- 命令解析异常在 `CustomCommandParser.parse()` 内记录后返回 `null`，不会进入 loader 的结构化 `errors`；发现结果为空不代表没有解析错误日志(`packages/cli/src/slash-commands/custom/CustomCommandParser.ts`, `packages/cli/src/slash-commands/custom/CustomCommandLoader.ts`)
- 内置 slash command 的解析优先级高于自定义命令、插件命令和 user-invocable Skill；同名扩展不会覆盖内置命令(`packages/cli/src/slash-commands/index.ts`)
- 插件 Skill/命令短名只有在唯一时才解析；有多个插件提供同名资源时必须使用完整 `plugin:name`，否则返回未找到而非任选一个(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)
- 默认 Skill 安装失败只追加 discovery error，内置 `skill-creator` 和 `update-config` 仍作为离线 fallback，启动不会因此中断(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/skills/SkillInstaller.ts`)

## Architecture
- Progressive Disclosure 有两层：系统 Prompt 和 Skill 工具描述只注入 `name + description`，真正调用后才从当前快照记录的路径加载完整正文(`packages/cli/src/prompts/builder.ts`, `packages/cli/src/skills/SkillRegistry.ts`)
- Workspace 注册表按 canonical root 缓存，WorkspaceAgentResources 负责统一初始化 Skills、命令和插件后再做 Session snapshot；消费者不应自行拼接全局单例(`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- 插件资源使用 namespaced name 写入同一 Registry，但独立保留 plugin map，以支持完整名优先、唯一短名回退和刷新时只清插件资源(`packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)
- user-invocable Skill 不复制成持久命令；slash command 路由层临时创建 action，让 UI 再调用 `Skill` 工具并沿用 Skill 的模型与工具限制元数据(`packages/cli/src/slash-commands/index.ts`, `packages/cli/src/tools/builtin/system/skill.ts`)

## Decisions
- Skill 列表按名称稳定排序是 Prompt Cache 优化的一部分；注册或遍历 Map 时不能重新引入发现顺序抖动(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/tests/unit/services/skill-registry-prompt-order.test.ts`, `git:25d5a7d3`)
- Registry 改为按 workspace 缓存并提供显式 `releaseInstance`，是为了限制多项目服务进程中的常驻扩展状态，同时不回收仍由 Session 快照持有的对象(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`, `git:2db1b230`)
- Skill 正文按调用读取而命令正文按发现读取，是两种不同的成本模型；新增统一抽象时不能破坏 Skill 的 token 延迟披露或命令的动态展开语义(`packages/cli/src/skills/SkillLoader.ts`, `packages/cli/src/slash-commands/custom/CustomCommandLoader.ts`)

## Patterns
- 所有外部同名覆盖都通过“低优先级先注册、高优先级后写 Map”实现；调整扫描顺序等价于改变公开优先级契约(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)
- 模型调用入口只展示有 description 且允许模型调用的资源，用户 slash 建议则额外合并 user-invocable Skills；两套目录不可互相替代(`packages/cli/src/tools/builtin/system/slashCommand.ts`, `packages/cli/src/slash-commands/index.ts`)

## Consumer Analysis
- `packages/cli/src/agent/resources/WorkspaceAgentResources.ts` — 统一初始化、插件重整合和 Session snapshot，是两个 Registry 的生命周期所有者(`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- `packages/cli/src/prompts/builder.ts` — 消费稳定排序的 Skill 元数据；优先使用 Session 提供的 `availableSkills`，避免读取已变化的 Workspace registry(`packages/cli/src/prompts/builder.ts`)
- `packages/cli/src/tools/builtin/index.ts` — 将 Session 快照注入 `Skill` 与 `SlashCommand` 工具，避免工具闭包捕获错误 workspace 的单例(`packages/cli/src/tools/builtin/index.ts`)
- `packages/cli/src/slash-commands/index.ts` — 按内置、自定义、插件、Skill 顺序执行，并把 user-invocable Skills 加入补全与模糊搜索(`packages/cli/src/slash-commands/index.ts`)
- `packages/cli/src/plugins/PluginIntegrator.ts` — 以 namespaced identity 注入和清理插件 Skills/命令；刷新时必须与 Registry 的 snapshot 边界配合(`packages/cli/src/plugins/PluginIntegrator.ts`)
