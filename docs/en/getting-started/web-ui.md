# 🌐 Web UI

Blade Code provides a Web UI that shares the Session Runtime with the CLI, letting you
dispatch tasks, view execution status, and manage sessions in the browser.

<div align="center">
  <img src="../assets/screenshots/web.png" alt="Blade Code Web UI" width="800" />
</div>

## Starting the Web UI

### Quick Start

```bash
blade web
```

This starts the web server and automatically opens the browser.

### Headless Server Mode

If you need remote access or don't want the browser to open automatically:

```bash
blade serve --port 3000 --hostname 0.0.0.0
```

## Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Listening port (0 for auto-select) | `0` |
| `--hostname <host>` | Listening hostname | `127.0.0.1` |
| `--cors <domains>` | Additional allowed CORS domains | `[]` |

## Security Configuration

### Basic Auth

Setting the `BLADE_SERVER_PASSWORD` environment variable enables Basic Auth:

```bash
# Linux/macOS
export BLADE_SERVER_PASSWORD=your-secret-password
blade serve --port 3000

# Windows
set BLADE_SERVER_PASSWORD=your-secret-password
blade serve --port 3000
```

Once enabled, accessing the Web UI requires entering:
- Username: `blade`
- Password: the password you set

### LAN Access

By default, the server only listens on `127.0.0.1` (localhost). To allow LAN access:

```bash
blade serve --hostname 0.0.0.0 --port 3000
```

⚠️ **Security note**: When using it on a LAN or public network, it is strongly recommended to enable Basic Auth.

## Web UI Features

The Web UI supports all of Blade Code's core features:

- 💬 **Smart conversation** - Multi-turn dialogue with the AI
- 📊 **Task board** - Bind multiple projects, dispatch tasks, and manage them centrally by execution stage
- 📁 **File operations** - Read, edit, and search files
- 🧭 **Embedded browser** - Inspect and reload local development pages in the right preview panel
- 🖥️ **Terminal** - Run commands and view output
- 📋 **Session management** - Create, switch, and resume sessions
- ⚙️ **Model configuration** - Add and switch models
- 🔒 **Permission control** - Switch permission modes
- 🌍 **Multilingual** - Switch between Chinese and English interfaces

## Task Board

Open the "Task Board" from the left navigation. The board only shows top-level tasks
dispatched via Web, Headless, or ACP; it does not mix in the `TaskCreate`/`TaskList`
todo lists that the Agent maintains within a single session.

Tasks automatically enter four stages based on their runtime status:

| Board Stage | Runtime Status |
|-------------|----------------|
| Awaiting claim | `queued` tasks waiting for a process-level execution slot |
| In progress | `running` tasks that are executing and need no human input |
| Blocked | Tasks waiting for authorization/answers, plus `failed`, `interrupted`, and `cancelled` tasks |
| Awaiting your confirmation | `completed` tasks awaiting review or archival |

The board supports:

- Binding local projects and filtering by a single project or all projects;
- Dispatching tasks directly in the target project in `local` mode;
- Setting and editing task title, type, priority, and due date;
- Receiving real-time status and human-interaction alerts via a global SSE;
- Opening tasks, handling interruptions, retrying after failure, viewing changes, and reviewing/archiving;
- Pausing or resuming auto-claim. When paused, running tasks continue to execute and new tasks
  enter a bounded queue; after resuming, scheduling continues in FIFO order.

The board address uses `?view=board` and can be combined with the `project` parameter to form a project-level deep link.

## Embedded Browser Preview

The right-side Preview panel includes a Browser tab for local development
servers and HTTP(S) pages. Its toolbar provides back, forward, reload, address
navigation, and an explicit open-in-system-browser action.

Use the global control in the upper-right corner to maximize Preview across the
workspace, then select it again to restore the previous split width. Maximized
Preview keeps the sidebar and application header visible and floats the current
Session composer over the bottom of the content. Expand its status row to inspect
the conversation, context usage, cache hit rate, and current run phase.

Browser history lives only for the current Preview panel lifecycle and is capped
at 50 entries. Blade accepts only HTTP(S) addresses and rejects credential-bearing
URLs and Blade Web's own origin. Pages run in a no-referrer sandboxed iframe.
Blade does not proxy pages or remove their `X-Frame-Options` or CSP; use the
external-open action for sites that deny embedding.

## Differences from the CLI

| Feature | CLI | Web UI |
|---------|-----|--------|
| Launch method | `blade` | `blade web` |
| Interface | Terminal | Browser |
| Remote access | Requires SSH | Direct access |
| Session sharing | Same directory | Same directory |
| File operations | ✅ | ✅ |
| Embedded browser preview | ❌ | ✅ |
| Terminal execution | ✅ | ✅ |

## Common Issues

### Port Already in Use

If the default port is occupied, you can specify another port:

```bash
blade web --port 8080
```

Or use `--port 0` to let the system automatically select an available port.

### Cannot Access

1. Check firewall settings
2. Confirm the `--hostname` setting is correct
3. For remote access, make sure to use `--hostname 0.0.0.0`

### Authentication Failure

Make sure the `BLADE_SERVER_PASSWORD` environment variable is set correctly and that the password entered in the browser matches it.
