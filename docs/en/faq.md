# ❓ Frequently Asked Questions

## Getting Started

**Q: How do I get started?**  
A: After installation, run `blade`. If no model is configured, it automatically enters the model configuration wizard; you can also try it first with `npx blade-code`.

**Q: I get `command not found: blade`?**  
A: Make sure the global install path is in your `PATH`:
```bash
npm config get prefix
export PATH="$(npm config get prefix)/bin:$PATH"
```

**Q: Which Node.js versions are supported?**  
A: Node.js 22.19.0 minimum. Upgrade with `nvm` or `n`.

## Configuration and Models

**Q: How do I configure the API Key / model?**  
A: Two ways:
1. Run `blade` and follow the wizard to select a Provider / model and configure credentials
2. Manually edit `~/.blade/config.json` (or the project-level `.blade/config.json`); keys can reference environment variables with `${VAR}`

**Q: Which model providers are supported?**  
A: The Provider and model list is provided dynamically by the built-in catalog, including official Providers, cloud platforms, and custom
OpenAI/Anthropic-compatible channels. Run `/model add` to see the full list supported by the current version.

**Q: How do I configure multiple models?**  
A: Add multiple configurations to the `models` array in `config.json`, and switch between them with the `/model` command.

**Q: What if the configuration file format is wrong?**  
A: If no valid model is found, the wizard is triggered; a parse failure shows an error in the conversation area. After fixing the JSON, just restart.

## During Use

**Q: Slash commands / shortcuts don't work?**  
A: Make sure the input box is focused; commands only trigger completion when starting with `/`; `Shift+Tab` only switches permission modes in the UI.

**Q: Tool calls prompt too frequently?**  
A: Adjust the permission mode:
- `autoEdit`: auto-approve file edits
- `yolo`: auto-approve all operations
- Choose `Session` in the confirmation dialog: applies only in the current session's memory
- Explicitly choose `Project`: persists to `.blade/settings.local.json`

**Q: How do I resume a session?**  
A: Add `--resume` at startup (with no argument, a selector pops up); or type `/resume` in the UI.

**Q: How do I continue the last conversation?**  
A: Use `blade --continue` or `blade -c` to continue the most recent session.

## Permission Modes

**Q: How do permission modes work?**  
A: Four modes:
- `default`: read-only tools pass automatically, writes and execution require confirmation
- `autoEdit`: additionally auto-allow file writes
- `plan`: read-only research mode, rejects all modifications
- `yolo`: everything auto-allowed

**Q: How do I quickly switch permission modes?**  
A: 
- Shortcut: `Shift+Tab` cycles between `default`, `autoEdit`, and `plan`
- Command: `/permissions` or `/yolo`
- Launch argument: `--permission-mode <mode>` or `--yolo`

## Skills and Hooks

**Q: What are Skills?**  
A: Skills are a dynamic Prompt extension mechanism, defined via `SKILL.md` files, that can inject domain-specific knowledge and behavior guidance into the AI.

**Q: What are Hooks?**  
A: Hooks are tool execution hooks that can automatically run commands before and after tool execution, such as code formatting, lint checks, etc.

**Q: How do I create a custom Skill?**  
A: Create a `SKILL.md` file in the `.blade/skills/` or `~/.blade/skills/` directory, containing YAML metadata and Markdown content.

## MCP Protocol

**Q: What is MCP?**  
A: Model Context Protocol, a protocol for extending AI tool capabilities. Custom tools can be added via MCP servers.

**Q: How do I add an MCP server?**  
A: 
```bash
blade mcp add github -- npx -y @modelcontextprotocol/server-github
```

**Q: MCP server connection fails?**  
A: Check:
1. Whether the server command is correct
2. Whether dependencies are installed
3. Use `blade mcp list` to view the connection status

## Network and Performance

**Q: Slow installation / download?**  
A: Use a mirror source:
```bash
npm install -g blade-code --registry=https://registry.npmmirror.com
```

**Q: Slow response?**  
A: 
1. Check your network connection
2. Try switching to a faster model
3. Use `--fallback-model` to set a backup model

## Debugging

**Q: How do I view debug logs?**  
A: Use the `--debug` argument:
```bash
# View all logs
blade --debug

# Only view specific categories
blade --debug "agent,tool"

# Exclude certain categories
blade --debug "!chat,!loop"
```

**Q: How do I run an environment check?**  
A: Run `blade doctor` to check configuration, Node version, directory permissions, etc.

## Network Tools

**Q: Which search engines does WebSearch support?**  
A: It supports automatic failover across multiple providers: Exa (default, using the MCP public endpoint) → DuckDuckGo → SearXNG. No API key required.

**Q: How does WebFetch extract web page content?**  
A: Use the `extract_content` parameter to enable Jina Reader, which extracts web page content into clean Markdown format, automatically removing HTML clutter.

## Other

**Q: How do I update to the latest version?**  
A: 
```bash
npm update -g blade-code
```

**Q: Where do I report issues?**  
A: Submit issues at [GitHub Issues](https://github.com/echoVic/blade-code/issues).

**Q: How do I contribute code?**  
A: Fork the repository, create a branch, and submit a PR. See the project README for details.

**Q: How do I join the community?**  
A: 
- [Discord community](https://discord.gg/utXDVcv6) - Join our Discord server
- WeChat group: add the assistant's WeChat **VIc-Forever** with the note "Blade" to be added to the group
