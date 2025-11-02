<div align="center">

# 🗡️ Blade Code

**Next-Generation AI-Powered Coding Assistant**

[![npm version](https://img.shields.io/npm/v/blade-code.svg?style=flat-square)](https://www.npmjs.com/package/blade-code)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

English | [简体中文](README.md)

</div>

---

## ✨ Key Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🤖 Intelligent Conversations</h3>
      <p>Natural language interactions powered by LLMs with context understanding and multi-turn dialogues. Simply run <code>blade</code> to launch the interactive UI.</p>
    </td>
    <td width="50%" valign="top">
      <h3>🛠️ Rich Toolset</h3>
      <p>Built-in tools for file operations, Git management, network requests, code analysis, and more</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔗 MCP Protocol</h3>
      <p>Model Context Protocol support for seamless external resource and tool integration</p>
    </td>
    <td width="50%" valign="top">
      <h3>🎨 Modern UI</h3>
      <p>Beautiful terminal interface powered by Ink with smooth interactions</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>💾 Session Management</h3>
      <p>Multi-session support with conversation continuation and recovery</p>
    </td>
    <td width="50%" valign="top">
      <h3>🔒 Secure & Controllable</h3>
      <p>Permission management, tool whitelisting, and operation confirmation</p>
    </td>
  </tr>
</table>

---

## 🚀 Quick Start

### ⚡ Try Without Installation

Experience Blade Code instantly without installation:

```bash
# Interactive mode
npx blade-code

# Quick Q&A (non-interactive)
npx blade-code --print "Explain what TypeScript is"

# Code generation (non-interactive)
npx blade-code --print "Write a quicksort algorithm in Python"
```

### 📦 Global Installation (Recommended)

```bash
# Using npm
npm install -g blade-code

# Using pnpm
pnpm add -g blade-code

# Using yarn
yarn global add blade-code
```

After installation, use the `blade` command:

```bash
# Interactive mode (default)
blade

# Quick Q&A (non-interactive)
blade --print "Hello, introduce yourself"
```

> On the first run, if no API key is detected, Blade will automatically open an interactive setup wizard in your terminal to collect Provider, Base URL, API Key, and model information before continuing.

---

## 🔐 Configure API Keys

Blade Code supports multiple LLM providers. You need to configure the appropriate API key:

### Method 1: Configuration File (Recommended)

```bash
# Create user-level configuration file
mkdir -p ~/.blade
cat > ~/.blade/config.json << 'EOF'
{
  "provider": "openai-compatible",
  "apiKey": "your-api-key",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-max"
}
EOF

# Or use environment variable interpolation in config file
cat > ~/.blade/config.json << 'EOF'
{
  "apiKey": "${BLADE_API_KEY}",
  "baseUrl": "${BLADE_BASE_URL:-https://apis.iflow.cn/v1}"
}
EOF
```

### Method 2: First-Run Setup Wizard (Recommended Experience)

```bash
blade
# If no API key is configured, an interactive wizard will guide you through Provider, Base URL, API Key, and model setup.
```

### Method 3: Config Command

```bash
# Use config command to manage configuration
blade config
```


### Get API Keys

- **Qwen**: [DashScope Console](https://dashscope.console.aliyun.com/apiKey)
- **VolcEngine**: [Volcano Ark Console](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)

---

## 💬 Usage Examples

### Basic Conversations

```bash
# Interactive mode (default)
blade

# Non-interactive quick answer (print mode)
blade --print "What is artificial intelligence?"

# Code generation (print mode)
blade --print "Write a debounce function in JavaScript"
```

### Smart Tool Invocation

Blade Code automatically selects appropriate tools based on your needs:

```bash
# File operations (print mode)
blade --print "List all TypeScript files in the current directory"

# Git operations (print mode)
blade --print "Show the last 5 commit logs"

# Code review (print mode)
blade --print "Review code quality in src/utils directory"
```

### Session Management

```bash
# Create or use named session (print mode)
blade --session-id "project-alpha" --print "Start new project"

# Continue recent session
blade --continue

# Resume specific conversation
blade --resume <conversation-id>

# Fork session (create new session from existing)
blade --resume <id> --fork-session
```

### Print Mode

Perfect for piping and scripting:

```bash
# Print mode (non-interactive, direct output)
blade --print "Generate a README template" > README.md

# Specify output format
blade --print --output-format json "Get project info"

# Stream JSON output
blade --print --output-format stream-json "Analyze code"
```

### Input/Output Options

```bash
# Read from stdin (stream JSON format)
cat input.json | blade --input-format stream-json --print

# Include partial message chunks
blade --print --include-partial-messages "Generate long text"

# Replay user messages
blade --replay-user-messages < input.txt
```

---

## 🔧 Advanced Features

### MCP Server Integration

Model Context Protocol allows integration of external tools and resources:

```bash
# Configure and manage MCP servers
blade mcp

# Load MCP config from JSON file
blade --mcp-config config.json "Use external tools"

# Strict mode (only use specified MCP config)
blade --mcp-config config.json --strict-mcp-config "Query"
```

### Configuration Management

```bash
# Configuration management
blade config

# System health check
blade doctor

# Check for updates
blade update
```

### AI Model Options

```bash
# Specify model
blade --model qwen-max --print "Complex question"

# Set fallback model
blade --fallback-model qwen-turbo --print "Question"

# Custom system prompt
blade --append-system-prompt "You are a senior architect" --print "Design microservices architecture"

# Replace default system prompt entirely
blade --system-prompt "You are a TypeScript expert" --print "Explain decorators"

# Custom agent config
blade --agents '{"reviewer": {"model": "qwen-max"}}' --print "Review code"
```

### Security & Permissions

Blade ships with a three-tier permission system (`allow` / `ask` / `deny`). You can fine-tune runtime behavior with CLI flags:

```bash
# Allow specific tools only
blade --allowed-tools "read,write" --print "Handle files"

# Disallow specific tools
blade --disallowed-tools "bash,execute" --print "Safe operations"

# Permission modes
blade --permission-mode plan --print "Plan task"       # Plan only, no execution
blade --permission-mode autoEdit --print "Modify code" # Auto-approve edits
blade --yolo --print "Run high-trust operations"       # Approve every tool call

# Add allowed directories
blade --add-dir /path/to/dir --print "Access directory"
```

### IDE Integration

```bash
# Auto-connect to IDE on startup
blade --ide
```

### Configuration Files

```bash
# Use settings file
blade --settings settings.json

# Specify config sources
blade --setting-sources "global,user,local"
```

---

## 📚 Command Reference

### Main Commands

| Command | Description | Example |
|---------|-------------|---------|
| `blade` | Start interactive AI assistant (default) | `blade` |
| `blade config` | Configuration management | `blade config` |
| `blade mcp` | Configure and manage MCP servers | `blade mcp` |
| `blade doctor` | System health check | `blade doctor` |
| `blade update` | Check and install updates | `blade update` |
| `blade install [target]` | Install specific version (stable/latest/version) | `blade install latest` |

### Debug Options

| Option | Short | Description |
|--------|-------|-------------|
| `--debug [category]` | `-d` | Enable debug mode with optional category filtering |

### Output Options

| Option | Short | Description |
|--------|-------|-------------|
| `--print` | `-p` | Print response and exit (for piping) |
| `--output-format <format>` | | Output format: text/json/stream-json (with --print only) |
| `--include-partial-messages` | | Include partial message chunks |

### Input Options

| Option | Description |
|--------|-------------|
| `--input-format <format>` | Input format: text/stream-json |
| `--replay-user-messages` | Re-emit user messages from stdin |

### Security Options

| Option | Description |
|--------|-------------|
| `--allowed-tools <tools>` | Allowed tools list (comma or space separated) |
| `--disallowed-tools <tools>` | Disallowed tools list (comma or space separated) |
| `--permission-mode <mode>` | Permission mode: default/autoEdit/yolo/plan |
| `--yolo` | Shortcut for `--permission-mode yolo` |
| `--add-dir <dirs>` | Additional directories for tool access |

### MCP Options

| Option | Description |
|--------|-------------|
| `--mcp-config <files>` | Load MCP servers from JSON files or strings |
| `--strict-mcp-config` | Only use servers from --mcp-config |

### AI Options

| Option | Description |
|--------|-------------|
| `--append-system-prompt <text>` | Append system prompt to default |
| `--system-prompt <text>` | Replace default system prompt |
| `--model <name>` | Model for current session |
| `--fallback-model <name>` | Enable automatic fallback to specified model |
| `--agents <json>` | Custom agent configuration JSON |

### Session Options

| Option | Short | Description |
|--------|-------|-------------|
| `--continue` | `-c` | Continue recent session |
| `--resume <id>` | `-r` | Resume specific session |
| `--fork-session` | | Create new session ID when resuming |
| `--session-id <id>` | | Use specific session ID |

### Configuration Options

| Option | Description |
|--------|-------------|
| `--settings <path>` | Settings JSON file path or JSON string |
| `--setting-sources <sources>` | Setting sources to load (comma separated) |

### Integration Options

| Option | Description |
|--------|-------------|
| `--ide` | Auto-connect to IDE on startup |

### Other Options

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help |
| `--version` | `-V` | Show version number |

---

## 🏗️ Technical Architecture

Blade Code features a modern flat architecture design:

```
src/
├── agent/          # Agent core logic
├── cli/            # CLI config and middleware
├── commands/       # Command handlers
├── config/         # Configuration management
├── tools/          # Tool system
├── ui/             # UI components (Ink-based)
├── services/       # Shared services
└── utils/          # Utility functions
```

### Core Features

- 🚀 **Lightning Fast**: Built with Bun for exceptional performance
- 📦 **Single File Deploy**: Build output ~1MB only
- 🎨 **React for CLI**: Modern UI powered by Ink
- 🔧 **TypeScript**: Full type support
- ✅ **Comprehensive Testing**: Unit, integration, and E2E test coverage

---

## 🔨 Development Guide

### Requirements

- Node.js >= 16.0.0
- pnpm (recommended) or npm

### Clone Project

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code
pnpm install
```

### Development Commands

```bash
# Development mode (hot reload)
pnpm dev

# Build
pnpm build

# Run tests
pnpm test

# Test coverage
pnpm test:coverage

# Code linting
pnpm check:fix

# Type checking
pnpm type-check
```

### Project Structure

```
blade-code/
├── src/              # Source code
├── tests/            # Test files
├── dist/             # Build output
├── scripts/          # Build scripts
└── docs/             # Documentation
```

---

## 🤝 Contributing

We welcome all forms of contributions!

- 🐛 [Report Bug](https://github.com/echoVic/blade-code/issues/new?template=bug_report.md)
- 💡 [Feature Request](https://github.com/echoVic/blade-code/issues/new?template=feature_request.md)
- 📖 [Improve Documentation](https://github.com/echoVic/blade-code/pulls)
- 🔧 [Submit Code](CONTRIBUTING.md)

### Contribution Process

1. Fork this repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

See [Contributing Guide](CONTRIBUTING.md) for details.

---

## 📄 License

This project is licensed under the MIT License - see [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

Blade Code is built upon these excellent open-source projects:

- [Ink](https://github.com/vadimdemedes/ink) - React for CLI
- [OpenAI](https://github.com/openai/openai-node) - OpenAI API client
- [Biome](https://github.com/biomejs/biome) - Code formatting and linting
- [Vitest](https://github.com/vitest-dev/vitest) - Testing framework
- [Bun](https://github.com/oven-sh/bun) - Fast build tool

---

## 📞 Contact

- **Author**: echoVic
- **Homepage**: [https://github.com/echoVic/blade-code](https://github.com/echoVic/blade-code)
- **Issue Tracker**: [GitHub Issues](https://github.com/echoVic/blade-code/issues)

---

## 🌟 Star History

If Blade Code helps you, please give us a ⭐️ Star!

[![Star History Chart](https://api.star-history.com/svg?repos=echoVic/blade-code&type=Date)](https://star-history.com/#echoVic/blade-code&Date)

---

<div align="center">

**🗡️ Blade Code - Make AI Your Command Line Companion!**

Made with ❤️ by [echoVic](https://github.com/echoVic)

</div>
