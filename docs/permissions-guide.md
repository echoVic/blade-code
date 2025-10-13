# 🔒 Blade 权限系统指南

Blade 提供了强大的权限控制系统,让你可以精细地控制工具的执行权限,保护敏感文件和危险操作。

## 📋 目录

- [权限级别](#权限级别)
- [匹配模式](#匹配模式)
- [配置方式](#配置方式)
- [常用示例](#常用示例)
- [最佳实践](#最佳实践)

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

权限检查按以下优先级执行:

1. **deny** (最高优先级) - 直接拒绝
2. **allow** - 允许执行  
3. **ask** - 需要确认
4. **默认** - 需要确认 (未匹配任何规则时)

**示例**:
```json
{
  "allow": ["Read"],
  "deny": ["Read(file_path:.env)"]
}
```

结果:
- `Read(file_path:.env)` → **DENY** (deny 优先)
- `Read(file_path:test.txt)` → **ALLOW**

## 调试权限规则

如果权限规则不按预期工作,可以:

1. 检查规则语法是否正确
2. 确认工具调用签名格式: `ToolName(param:value)`
3. 测试 glob 模式是否匹配
4. 检查优先级是否符合预期

**测试工具** (即将推出):
```bash
blade permissions check "Read(file_path:.env)"
# Output: DENY - 匹配规则: Read(file_path:.env)
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

## 相关链接

- [配置系统文档](./config-system.md)
- [工具系统文档](./tool-system.md)
- [Hooks 系统文档](./hooks-guide.md)
