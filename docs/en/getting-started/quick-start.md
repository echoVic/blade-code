# 🚀 Quick Start

This guide helps you start using Blade in 5 minutes.

## Installation

```bash
# with npm
npm install -g blade-code

# or pnpm
pnpm add -g blade-code

# or yarn
yarn global add blade-code
```

## Launch

### CLI mode

```bash
# Start inside a project directory
cd /path/to/project
blade

# Or start with an initial message
blade "Help me analyze this project's architecture"
```

### Web UI and server modes

```bash
# Start the Web UI and open the browser automatically
blade web

# Or start a headless server (good for remote access)
blade serve --port 3000 --hostname 0.0.0.0
```

## Configure a Model

On first launch you need to configure a model. Type `/model add` to start the setup wizard:

### 3 steps to configure

1. **Choose a Provider** - pick from the built-in Provider Catalog
2. **Enter an API Key** - the wizard shows the env var name and documentation links
3. **Select a model** - choose from that provider's built-in model list

Once configured, use the `/model` command to switch models.

### Custom Providers

Both the TUI and Web "Add Model" flows offer `Custom OpenAI Endpoint` and
`Custom Anthropic Endpoint`. Fill in a stable Channel ID, name, Base URL, and
Model ID to create an independent channel. Each channel has its own endpoint and
credentials and never shares an API key just because the protocol matches. See
[Model & Configuration System](/en/configuration/config-system.md) for the full
format; API keys are always stored separately in `~/.blade/auth.json`.

## Basic Interaction

### Conversation

Just type your question to start a conversation:

```
You: Help me write a React component: a dropdown selector with search

Blade: Sure, let me create a searchable dropdown selector component...
```

### @ File Mentions

Use `@` to reference files so the AI understands context:

```
You: @src/components/Button.tsx help me add a loading state

You: @src/utils/api.ts:10-50 what's wrong with this code?
```

### Common Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help information |
| `/model` | Switch/manage models |
| `/model add` | Add a model from the Provider Catalog |
| `/clear` | Clear conversation history |
| `/compact` | Compact the context |
| `/status` | View current status |
| `/config` | View/modify configuration |

### Keyboard Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+C` | Interrupt the current operation |
| `Ctrl+D` | Exit Blade |
| `↑/↓` | Browse message history |
| `Tab` | Autocomplete |

## Permission Control

Blade requests confirmation before executing sensitive operations:

```
┌─────────────────────────────────────────────────────────┐
│  🔧 Blade wants to run the following operation:          │
│                                                         │
│  Tool: Write                                            │
│  File: src/components/SearchSelect.tsx                  │
│                                                         │
│  [y] Allow  [n] Deny  [a] Allow all this session        │
└─────────────────────────────────────────────────────────┘
```

You can preset permission rules in the config file. See
[Permissions](/en/configuration/permissions.md) for details.

## Configuration File

### Model reference example

Create `~/.blade/config.json`:

```json
{
  "currentModelId": "claude",
  "models": [
    {
      "id": "claude",
      "displayName": "Claude Sonnet",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5"
    }
  ]
}
```

Credentials are stored in `~/.blade/auth.json`; configuring via `/model add` is recommended.

More providers and models can be selected directly in the TUI or Web Provider Catalog.

## Next Steps

- [Configuration System](/en/configuration/config-system.md) - model and credential configuration
- [Permissions](/en/configuration/permissions.md) - permission rule configuration
- [@ File Mentions](/en/guides/at-file-mentions.md) - advanced file references
- [Slash Commands](/en/guides/slash-commands.md) - all available commands
- [Plan Mode](/en/guides/plan-mode.md) - using plan mode
- [Subagents](/en/guides/subagents.md) - subagent features
