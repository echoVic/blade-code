# Blade

**Blade** is an AI coding assistant built for real engineering work. CLI, Web,
Headless, and ACP share the same Session Runtime, tooling, permission, and
persistence semantics.

[View Changelog](/en/changelog.md)

## Core Features

### 🌐 Multiple Entry Points

- **CLI mode**: use it in the terminal, with Markdown rendering and syntax highlighting
- **Web UI mode**: use it in the browser, with a full graphical experience
- **Headless mode**: stable JSONL events for scripts, CI, and automation
- **ACP mode**: integrate with editors and hosts that support the Agent Client Protocol

```bash
blade                                      # CLI mode
blade web                                  # Web UI mode
blade serve                                # Headless HTTP server
blade --headless --output-format jsonl "Analyze the project"  # Headless agent
```

### 📡 Provider Catalog

Providers, model capabilities, context windows, and pricing are all read
dynamically from a built-in catalog, so there is no stale static model table to
maintain in docs. Official providers, cloud platforms, and custom-compatible
channels all use the same configuration flow.

3-step setup wizard: choose Provider → enter API Key → select model

### 🛡️ Secure Permission Control

- Requests confirmation before sensitive operations
- Permission rules with glob pattern support
- Four permission modes (default, autoEdit, plan, yolo)

### 🔧 Powerful Toolset

- **File operations**: read, write, edit, search
- **Code analysis**: linting, type checking, test runs
- **Terminal execution**: a safe command execution environment
- **Git integration**: version control operations
- **Web search**: automatic failover across multiple providers

### 📝 Flexible Working Modes

- **Plan mode**: plan first, then execute
- **Subagents**: parallel task processing

### 🔌 MCP Extensions

Supports the Model Context Protocol to connect external tools and services.

## Quick Start

```bash
# Install
npm install -g blade-code

# CLI mode
blade

# Web UI mode
blade web

# Add a model from the Provider Catalog
# In Blade, type: /model add
```

## Documentation

### Getting Started

- [Installation](/en/getting-started/installation.md)
- [Quick Start](/en/getting-started/quick-start.md)

### Configuration

- [Configuration System](/en/configuration/config-system.md) - model and credential configuration
- [Permissions](/en/configuration/permissions.md)
- [Workspace Trust](/en/guides/workspace-trust.md)
- [Themes](/en/configuration/themes.md)

### Guides

- [@ File Mentions](/en/guides/at-file-mentions.md)
- [Slash Commands](/en/guides/slash-commands.md)
- [Plan Mode](/en/guides/plan-mode.md)
- [Subagents](/en/guides/subagents.md)
- [Hooks](/en/guides/hooks.md)
- [Skills](/en/guides/skills.md)
- [Markdown Support](/en/guides/markdown-support.md)

### Reference

Reference pages are being progressively translated. Untranslated pages fall
back to the Chinese version automatically. See the sidebar for the full list.

### Other

- [Changelog](/en/changelog.md)
- [FAQ](/en/faq.md)

## Supported Providers

Run `/model add` to see the providers and models supported by your installed
version. Custom OpenAI- or Anthropic-compatible endpoints can be configured as
independent channels, with credentials stored in isolation from other channels.

## License

MIT License
