# 🌐 Web UI

Blade Code 提供与 CLI 共用 Session Runtime 的 Web UI，可在浏览器中派发任务、
查看执行状态并管理会话。

<div align="center">
  <img src="../assets/screenshots/web.png" alt="Blade Code Web UI" width="800" />
</div>

## 启动 Web UI

### 快速启动

```bash
blade web
```

这将启动 Web 服务器并自动打开浏览器。

### 无头服务器模式

如果你需要远程访问或不想自动打开浏览器：

```bash
blade serve --port 3000 --hostname 0.0.0.0
```

## 命令选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--port <port>` | 监听端口（0 为自动选择） | `0` |
| `--hostname <host>` | 监听主机名 | `127.0.0.1` |
| `--cors <domains>` | 额外允许的 CORS 域名 | `[]` |

## 安全配置

### Basic Auth 认证

设置 `BLADE_SERVER_PASSWORD` 环境变量可启用 Basic Auth 认证：

```bash
# Linux/macOS
export BLADE_SERVER_PASSWORD=your-secret-password
blade serve --port 3000

# Windows
set BLADE_SERVER_PASSWORD=your-secret-password
blade serve --port 3000
```

启用后，访问 Web UI 时需要输入：
- 用户名：`blade`
- 密码：你设置的密码

### 局域网访问

默认情况下，服务器只监听 `127.0.0.1`（本机）。要允许局域网访问：

```bash
blade serve --hostname 0.0.0.0 --port 3000
```

⚠️ **安全提示**：在局域网或公网环境中使用时，强烈建议启用 Basic Auth 认证。

## Web UI 功能

Web UI 支持 Blade Code 的所有核心功能：

- 💬 **智能对话** - 与 AI 进行多轮对话
- 📊 **任务看板** - 绑定多个项目，派发任务并按执行阶段集中管理
- 📁 **文件操作** - 读取、编辑、搜索文件
- 🧭 **内嵌浏览器** - 在右侧预览区查看并刷新本地开发页面
- 🖥️ **终端** - 执行命令并查看输出
- 📋 **会话管理** - 创建、切换、恢复会话
- ⚙️ **模型配置** - 添加和切换模型
- 🔒 **权限控制** - 切换权限模式
- 🌍 **多语言** - 中英文界面切换

## 任务看板

从左侧导航打开“任务看板”。看板只显示通过 Web、Headless 或 ACP 派发的顶层
任务，不会混入 Agent 在单个会话中维护的 `TaskCreate`/`TaskList` 待办清单。

任务按运行时状态自动进入四个阶段：

| 看板阶段 | 运行时状态 |
|----------|------------|
| 等待认领 | 等待进程级执行槽位的 `queued` 任务 |
| 处理中 | 正在执行且不需要人工输入的 `running` 任务 |
| 遇到阻碍 | 等待授权/回答的任务，以及 `failed`、`interrupted`、`cancelled` 任务 |
| 等你确认 | 已完成、等待查看或归档的 `completed` 任务 |

看板支持：

- 绑定本地项目，并按单个项目或全部项目筛选；
- 以 `local` 模式直接在目标项目中派发任务；
- 设置和编辑任务标题、类型、优先级与截止时间；
- 通过全局 SSE 实时接收状态和人工交互提醒；
- 打开任务、处理中止、失败后重试、查看变更并验收归档；
- 暂停或恢复自动认领。暂停后，运行中的任务继续执行，新任务进入有界队列；
  恢复后按 FIFO 顺序继续调度。

看板地址使用 `?view=board`，可与 `project` 参数组合形成项目级深链。

## 内嵌浏览器预览

任务详情右侧的预览区包含“浏览器”标签，可直接打开本地开发服务器或 HTTP(S)
页面。工具栏支持后退、前进、刷新、地址跳转和在系统浏览器中打开。

浏览器历史仅保留在当前预览面板生命周期内，最多 50 项。Blade 仅接受 HTTP(S)
地址，拒绝包含凭据的 URL 和 Blade Web 自身 origin。页面在无 referrer 的 sandbox
iframe 中运行，Blade 不会代理页面或移除目标站点的 `X-Frame-Options` / CSP；拒绝
嵌入的站点应使用工具栏中的“在系统浏览器中打开”。

## 与 CLI 的区别

| 功能 | CLI | Web UI |
|------|-----|--------|
| 启动方式 | `blade` | `blade web` |
| 界面 | 终端 | 浏览器 |
| 远程访问 | 需要 SSH | 直接访问 |
| 会话共享 | 同一目录 | 同一目录 |
| 文件操作 | ✅ | ✅ |
| 内嵌浏览器预览 | ❌ | ✅ |
| 终端执行 | ✅ | ✅ |

## 常见问题

### 端口被占用

如果默认端口被占用，可以指定其他端口：

```bash
blade web --port 8080
```

或使用 `--port 0` 让系统自动选择可用端口。

### 无法访问

1. 检查防火墙设置
2. 确认 `--hostname` 设置正确
3. 如果是远程访问，确保使用 `--hostname 0.0.0.0`

### 认证失败

确保 `BLADE_SERVER_PASSWORD` 环境变量设置正确，且浏览器中输入的密码与之匹配。
