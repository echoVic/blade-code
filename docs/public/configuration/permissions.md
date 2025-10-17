# 🔒 Blade 权限系统指南

Blade 提供了强大的权限控制系统,让你可以精细地控制工具的执行权限,保护敏感文件和危险操作。

## 📋 目录

- [权限级别](#权限级别)
- [匹配模式](#匹配模式)
- [配置方式](#配置方式)
- [常用示例](#常用示例)
- [最佳实践](#最佳实践)
- [/permissions 命令](#permissions-命令)

## 权限级别

Blade 支持三级权限控制:

### 1. `allow` - 允许执行
工具调用自动允许,无需用户确认。

**优先级**: 最高(仅次于 deny)

**使用场景**:
- 读取项目源代码文件
- 执行安全的查询操作
- 访问公开的文档文件

### 2. `ask` - 需要确认  
工具调用前需要用户确认。

**优先级**: 中等

**使用场景**:
- 写入或修改文件
- 执行构建命令
- 提交代码

### 3. `deny` - 拒绝执行
工具调用被阻止,直接拒绝。

**优先级**: 最高

**使用场景**:
- 访问敏感文件(.env, .key, .secret)
- 危险的系统命令(rm -rf, sudo)
- 禁止的操作

## 匹配模式

权限规则支持多种匹配模式:

### 1. 精确匹配
```json
{
  "deny": ["Read(file_path:.env)"]
}
```
**说明**: 精确匹配完整的工具调用签名

### 2. 工具名匹配  
```json
{
  "allow": ["Read", "Grep"]
}
```
**说明**: 允许该工具的所有调用

### 3. 通配符匹配
```json
{
  "deny": ["Read(file_path:*.env)"]
}
```
**说明**: `*` 匹配任意字符(不包括 `/`)

### 4. Glob 模式
```json
{
  "deny": [
    "Read(file_path:**/.env)",
    "Read(file_path:**/*.{env,key,secret})"
  ]
}
```
**说明**: 
- `**` 匹配任意层级的目录
- `{env,key,secret}` 匹配多个扩展名
- `?` 匹配单个字符

### 5. 通配所有工具
```json
{
  "allow": ["*"]
}
```
**说明**: 匹配所有工具调用(谨慎使用)

## 配置方式

### 文件位置

**项目级别** (推荐):
```
.blade/settings.json
```

**用户级别**:
```
~/.blade/settings.json
```

**本地级别** (不提交到 git):
```
.blade/settings.local.json
```

### 配置示例

```json
{
  "permissions": {
    "allow": [
      "Read(file_path:**/*.ts)",
      "Read(file_path:**/*.js)",
      "Grep",
      "Glob"
    ],
    "ask": [
      "Write",
      "Edit",
      "Bash(command:npm *)",
      "Bash(command:git *)"
    ],
    "deny": [
      "Read(file_path:.env)",
      "Read(file_path:**/.env*)",
      "Read(file_path:**/*.{key,secret})",
      "Bash(command:rm -rf *)",
      "Bash(command:sudo *)",
      "Delete"
    ]
  }
}
```

## 常用示例

### 保护敏感文件

```json
{
  "deny": [
    "Read(file_path:.env)",
    "Read(file_path:.env.*)",
    "Read(file_path:**/.env)",
    "Read(file_path:**/*.key)",
    "Read(file_path:**/*.pem)",
    "Read(file_path:**/*.secret)",
    "Read(file_path:**/*credentials*)"
  ]
}
```

### 允许读取代码文件

```json
{
  "allow": [
    "Read(file_path:**/*.{ts,tsx,js,jsx})",
    "Read(file_path:**/*.{md,json,yaml,yml})",
    "Read(file_path:**/*.css)",
    "Grep",
    "Glob"
  ]
}
```

### 控制命令执行

```json
{
  "ask": [
    "Bash(command:npm *)",
    "Bash(command:yarn *)",
    "Bash(command:pnpm *)",
    "Bash(command:git commit*)",
    "Bash(command:git push*)"
  ],
  "deny": [
    "Bash(command:rm *)",
    "Bash(command:sudo *)",
    "Bash(command:chmod *)",
    "Bash(command:curl *| sh)"
  ]
}
```

### 保护重要配置文件

```json
{
  "ask": [
    "Write(file_path:package.json)",
    "Write(file_path:tsconfig.json)",
    "Write(file_path:.github/**/*)",
    "Edit(file_path:**/config.*)"
  ]
}
```

## 智能模式抽象

从 v0.0.10 开始，Blade 实现了**智能权限模式抽象**机制，自动将具体的工具调用转换为模式规则。

### 工作原理

当你在确认提示中选择 **"Yes, don't ask again this session"**（记住本项目会话）时，Blade 不会保存精确的参数，而是根据工具类型自动生成模式规则：

**优化前（旧行为）**：
```json
{
  "permissions": {
    "allow": [
      "Bash(command:cd /path && npm run typecheck)",
      "Bash(command:cd /path && npm test)",
      "Edit(file_path:/path/src/a.ts, old_string:..., new_string:...)",
      "Edit(file_path:/path/src/b.ts, old_string:..., new_string:...)"
    ]
  }
}
```

**优化后（新行为）**：
```json
{
  "permissions": {
    "allow": [
      "Bash(command:*npm*)",      // 覆盖所有 npm 命令
      "Edit(file_path:**/*.ts)"   // 覆盖所有 TS 文件编辑
    ]
  }
}
```

### 抽象策略

不同工具类型采用不同的抽象策略：

#### Bash 命令
- **安全命令**（cd/ls/pwd）→ `Bash(command:*)`
- **包管理器**（npm/pnpm/yarn）→ `Bash(command:*npm*)`
- **Git 命令**（git status）→ `Bash(command:git status*)`
- **开发工具**（test/build/lint）→ `Bash(command:*)`
- **其他命令** → `Bash(command:<主命令>*)`

#### 文件操作（Read/Edit/Write）
- **有扩展名** → `Tool(file_path:**/*.ext)`
- **源码目录** → `Tool(file_path:**)`
- **其他目录** → `Tool(file_path:<dir>/*)`

#### 搜索操作（Grep/Glob）
- **有类型限制** → `Grep(pattern:*, type:ts)`
- **有 glob 限制** → `Grep(pattern:*, glob:*.ts)`
- **有路径限制** → `Grep(pattern:*, path:**/*.ts)`
- **默认** → `Grep(pattern:*)`

#### Web 请求（WebFetch）
- **按域名分组** → `WebFetch(domain:api.github.com)`

### 优势

1. **减少权限文件大小**：从数百条规则减少到几条模式
2. **避免重复确认**：相似操作自动复用权限
3. **更符合直觉**："记住"意味着"信任这类操作"，而非"仅记住此确切操作"

### 规则覆盖与清理

当添加新的模式规则时，Blade 会自动检测并移除被覆盖的旧规则：

```
添加 "Edit(file_path:**/*.ts)" 后：
✅ 保留：Read(file_path:**/*.json)  (不冲突)
❌ 删除：Edit(file_path:/path/a.ts)  (被覆盖)
❌ 删除：Edit(file_path:/path/b.ts)  (被覆盖)
```

## 权限模式

Blade 提供了三种权限模式，控制工具调用的默认行为。

### 模式对比

| 模式 | Read | Search | Edit | Write | Bash | 其他 | 适用场景 |
|------|------|--------|------|-------|------|------|----------|
| **DEFAULT** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 日常开发（默认） |
| **AUTO_EDIT** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | 频繁修改代码 |
| **YOLO** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 演示/高度信任 |

✅ = 自动批准 | ❌ = 需要确认

### DEFAULT 模式（默认）

自动批准只读操作，其他操作需要确认。

**设计理念**：
- Read/Search 是只读操作，不会修改文件，默认安全
- Edit/Write/Bash 可能修改系统，需要用户确认

**适用场景**：
- 日常开发任务
- 不确定 AI 行为时的保守策略

### AUTO_EDIT 模式

在 DEFAULT 基础上，额外自动批准 Edit 操作。

**设计理念**：
- 信任 AI 的文件修改能力
- 减少频繁确认，提升效率
- 仍需确认 Write（创建新文件）和 Bash（执行命令）

**适用场景**：
- 重构代码
- 批量修改文件
- 频繁的编辑任务

**配置方式**：
```json
{
  "permissionMode": "autoEdit"
}
```

或通过命令行：
```bash
blade --permission-mode autoEdit
```

### YOLO 模式

自动批准所有工具调用，完全信任 AI。

**⚠️ 警告**：
- 跳过所有确认，AI 可以执行任何操作
- 可能删除文件、执行危险命令
- 仅在高度可控的环境使用

**适用场景**：
- 演示场景
- 测试环境
- 一次性任务

**配置方式**：
```json
{
  "permissionMode": "yolo"
}
```

### 权限规则优先级

权限模式与权限规则的优先级关系：

```
DENY 规则 > ALLOW 规则 > 权限模式 > ASK（默认）
```

**示例**：
- 即使在 YOLO 模式下，`deny` 规则仍然生效
- `allow` 规则可以覆盖模式的 ASK 行为
- 权限模式只影响未匹配任何规则的工具调用

## /permissions 命令

交互式管理项目本地权限规则（`.blade/settings.local.json`）。

### 使用方法

1. 输入 `/permissions` 进入权限管理器。
2. 使用 `Tab` 在 `Allow / Ask / Deny / Info` 视图之间切换。
3. 方向键选择规则，`Enter` 确认操作。
4. 选择 `Add a new rule...` 可添加新规则（写入 local 配置）。
5. 选择已有规则可删除（仅限本地配置的规则）。

### 注意事项

- 此命令只管理 `.blade/settings.local.json`。
- 全局或项目共享配置需手动编辑对应文件。
- 本地配置不会提交到 Git，适合个人偏好或临时授权。

## 最佳实践

### 1. 默认拒绝敏感操作

```json
{
  "deny": [
    "Read(file_path:**/.env*)",
    "Read(file_path:**/*.key)",
    "Bash(command:rm -rf *)",
    "Bash(command:sudo *)",
    "Delete"
  ]
}
```

### 2. 明确允许安全操作

```json
{
  "allow": [
    "Read(file_path:**/*.{ts,js,tsx,jsx})",
    "Read(file_path:**/*.md)",
    "Grep",
    "Glob(pattern:**/*)"
  ]
}
```

### 3. 危险操作需要确认

```json
{
  "ask": [
    "Write",
    "Edit",
    "Bash",
    "Delete"
  ]
}
```

### 4. 使用分层配置

**全局配置** (`~/.blade/settings.json`):
```json
{
  "deny": [
    "Read(file_path:**/.env*)",
    "Bash(command:sudo *)"
  ]
}
```

**项目配置** (`.blade/settings.json`):
```json
{
  "allow": [
    "Read(file_path:src/**/*)",
    "Read(file_path:docs/**/*)"
  ]
}
```

### 5. 使用注释说明规则

虽然 JSON 不支持注释,但你可以在文档中说明:

```markdown
## 权限规则说明

- `Read(file_path:**/*.ts)` - 允许读取所有 TypeScript 文件
- `deny` 中的 `.env*` 规则保护所有环境变量文件
- `ask` 规则确保所有写操作都需要确认
```

## 优先级规则

权限检查按以下优先级执行（由 `PermissionChecker` 实现）:

1. **deny** (最高优先级) - 直接拒绝，不会请求用户确认
2. **allow** - 自动允许执行，不需要用户确认
3. **ask** - 需要用户确认后执行
4. **默认** - 未匹配任何规则时，默认需要确认（ask）

**示例**:
```json
{
  "allow": ["Read"],
  "deny": ["Read(file_path:.env)"]
}
```

结果:
- `Read(file_path:.env)` → **DENY** (deny 优先，直接拒绝)
- `Read(file_path:test.txt)` → **ALLOW** (自动允许)
- `Write(file_path:test.txt)` → **ASK** (默认需要确认)

## 技术实现

### PermissionChecker 类

位于 [src/config/PermissionChecker.ts](../src/config/PermissionChecker.ts):

```typescript
export class PermissionChecker {
  constructor(private config: PermissionConfig) {}

  // 检查工具调用权限
  check(descriptor: ToolInvocationDescriptor): PermissionCheckResult {
    const signature = this.buildSignature(descriptor);

    // 1. 检查 deny (最高优先级)
    if (this.matchRules(signature, this.config.deny)) {
      return { result: PermissionResult.DENY, ... };
    }

    // 2. 检查 allow
    if (this.matchRules(signature, this.config.allow)) {
      return { result: PermissionResult.ALLOW, ... };
    }

    // 3. 检查 ask
    if (this.matchRules(signature, this.config.ask)) {
      return { result: PermissionResult.ASK, ... };
    }

    // 4. 默认策略: 需要确认
    return { result: PermissionResult.ASK, ... };
  }
}
```

### 集成到执行管道

权限检查在第 2 阶段（PermissionStage）执行：

```
ExecutionPipeline.execute()
  ↓
1. DiscoveryStage      - 查找工具
2. PermissionStage     ← Zod验证(含默认值处理) + 检查权限 (PermissionChecker.check)
3. ConfirmationStage   - 如果需要确认，请求用户
4. ExecutionStage      - 执行工具
5. FormattingStage     - 格式化结果
```

### 工具调用签名格式

```typescript
// 格式: ToolName(param1:value1, param2:value2)

// 示例:
"Read(file_path:/path/to/file.txt)"
"Bash(command:npm run test)"
"Write(file_path:output.txt, content:Hello World)"
```

## 调试权限规则

### 使用调试模式

启用调试模式查看详细的权限检查日志:

```bash
# 启用调试模式
export BLADE_DEBUG=1
blade "your command"

# 或使用 --debug 参数
blade --debug "your command"
```

调试输出示例:
```
[Permission] Checking: Read(file_path:.env)
[Permission] Matched deny rule: Read(file_path:.env)
[Permission] Result: DENY - 工具调用被拒绝规则阻止
```

### 常见问题排查

1. **规则不匹配**
   - 检查工具调用签名格式是否正确
   - 确认参数名称与实际工具参数一致
   - 使用 `*` 测试是否是匹配模式问题

2. **Glob 模式不生效**
   - 确认使用了正确的 glob 语法（`*`, `**`, `{}`, `?`）
   - 测试简单的通配符是否工作
   - 查看 PermissionChecker 日志确认匹配类型

3. **优先级问题**
   - 记住: `deny` > `allow` > `ask` > 默认
   - 检查是否有多条规则匹配同一工具
   - 更具体的规则应该放在前面

### 检查当前配置

```bash
# 查看权限配置
blade config show permissions

# 追踪配置来源
blade config trace permissions.allow
```

## 常见问题

### Q: 如何完全禁用权限检查?

不建议这样做,但如果必须:
```json
{
  "allow": ["*"]
}
```

### Q: 权限规则可以动态更新吗?

是的,通过 `PermissionChecker.updateConfig()` 可以在运行时更新。

### Q: 如何查看当前的权限配置?

```bash
blade config get permissions
```

### Q: 支持正则表达式吗?

不直接支持正则表达式,但 glob 模式已经足够强大。

## 相关代码

### 核心文件

- [src/config/PermissionChecker.ts](../src/config/PermissionChecker.ts) - 权限检查器实现
- [src/config/types.ts](../src/config/types.ts) - 权限配置类型定义
- [src/tools/execution/PipelineStages.ts](../src/tools/execution/PipelineStages.ts) - PermissionStage 实现
- [src/tools/execution/ExecutionPipeline.ts](../src/tools/execution/ExecutionPipeline.ts) - 执行管道

### 测试文件

- [tests/unit/config/PermissionChecker.test.ts](../tests/unit/config/PermissionChecker.test.ts) - 权限检查器单元测试
- [tests/integration/permissions.integration.test.ts](../tests/integration/permissions.integration.test.ts) - 权限系统集成测试

## 相关文档

- [配置系统文档](./config-system.md) - 完整的配置系统说明
- [用户确认流程](./architecture/confirmation-flow.md) - 了解用户确认机制
- [执行管道架构](./architecture/execution-pipeline.md) - 5 阶段执行管道详解
