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
      <p>Natural language interactions powered by LLMs with context understanding and multi-turn dialogues</p>
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

---

## 🔐 Configure API Keys

Blade Code supports multiple LLM providers. You need to configure the appropriate API key:

### Method 1: Environment Variables (Recommended)

```bash
# Qwen (Alibaba Cloud)
export QWEN_API_KEY="your-qwen-api-key"
export BLADE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# VolcEngine
export VOLCENGINE_API_KEY="your-volcengine-api-key"
export BLADE_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
```

### Method 2: Command Line Arguments

```bash
blade --print "Hello"  # Uses configured API key
```

### Method 3: Configuration File

```bash
# Copy example config
cp config.env.example .env

# Edit .env file with your credentials
nano .env
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

# Direct message (with --print for non-interactive)
blade --print "What is artificial intelligence?"

# Code generation
blade --print "Write a debounce function in JavaScript"
```

### Smart Tool Invocation

Blade Code automatically selects appropriate tools based on your needs:

```bash
# File operations
blade --print "List all TypeScript files in the current directory"

# Git operations
blade --print "Show the last 5 commit logs"

# Code review
blade --print "Review code quality in src/utils directory"
```

### Session Management

```bash
# Create or use named session
blade --sessionId "project-alpha" "Start new project"

# Continue recent session
blade --continue

# Resume specific conversation
blade --resume <conversation-id>

# Fork session (create new session from existing)
blade --resume <id> --forkSession
```

### Print Mode

Perfect for piping and scripting:

```bash
# Print mode (non-interactive, direct output)
blade --print "Generate a README template" > README.md

# Specify output format
blade --print --outputFormat json "Get project info"

# Stream JSON output
blade --print --outputFormat stream-json "Analyze code"
```

### Input/Output Options

```bash
# Read from stdin (stream JSON format)
cat input.json | blade --inputFormat stream-json --print

# Include partial message chunks
blade --print --includePartialMessages "Generate long text"

# Replay user messages
blade --replayUserMessages < input.txt
```

---

## 🔧 Advanced Features

### MCP Server Integration

Model Context Protocol allows integration of external tools and resources:

```bash
# Configure and manage MCP servers
blade mcp

# Load MCP config from JSON file
blade --mcpConfig config.json "Use external tools"

# Strict mode (only use specified MCP config)
blade --mcpConfig config.json --strictMcpConfig "Query"
```

### Configuration Management

```bash
# Configuration management
blade config

# System health check
blade doctor

# Check for updates
blade update

# Set up authentication token
blade setup-token
```

### AI Model Options

```bash
# Specify model
blade --model qwen-max --print "Complex question"

# Set fallback model
blade --fallbackModel qwen-turbo --print "Question"

# Custom system prompt
blade --appendSystemPrompt "You are a senior architect" --print "Design microservices architecture"

# Custom agent config
blade --agents '{"reviewer": {"model": "qwen-max"}}' --print "Review code"
```

### Security & Permissions

```bash
# Skip permission checks (dangerous)
blade --dangerouslySkipPermissions --print "Execute command"

# Allow specific tools only
blade --allowedTools "read,write" --print "Handle files"

# Disallow specific tools
blade --disallowedTools "bash,execute" --print "Safe operations"

# Permission modes
blade --permissionMode plan --print "Plan task"  # Plan only, no execution
blade --permissionMode acceptEdits --print "Modify code"  # Auto-accept edits

# Add allowed directories
blade --addDir /path/to/dir --print "Access directory"
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
blade --settingSources "global,user,local"
```

---

## 📚 Command Reference

### Main Commands

| Command | Description | Example |
|---------|-------------|---------|
| `blade [message..]` | Send message or launch interactive mode (default) | `blade "Hello"` |
| `blade config` | Configuration management | `blade config` |
| `blade mcp` | Configure and manage MCP servers | `blade mcp` |
| `blade doctor` | System health check | `blade doctor` |
| `blade update` | Check and install updates | `blade update` |
| `blade install [target]` | Install specific version (stable/latest/version) | `blade install latest` |
| `blade setup-token` | Set up authentication token | `blade setup-token` |
| `blade completion` | Generate shell completion script | `blade completion` |

### Debug Options

| Option | Short | Description |
|--------|-------|-------------|
| `--debug [category]` | `-d` | Enable debug mode with optional category filtering |
| `--verbose` | | Enable verbose output mode |

### Output Options

| Option | Short | Description |
|--------|-------|-------------|
| `--print` | `-p` | Print response and exit (for piping) |
| `--outputFormat <format>` | | Output format: text/json/stream-json (with --print only) |
| `--includePartialMessages` | | Include partial message chunks |

### Input Options

| Option | Description |
|--------|-------------|
| `--inputFormat <format>` | Input format: text/stream-json |
| `--replayUserMessages` | Re-emit user messages from stdin |

### Security Options

| Option | Description |
|--------|-------------|
| `--dangerouslySkipPermissions` | Skip all permission checks (dangerous) |
| `--allowedTools <tools>` | Allowed tools list (comma or space separated) |
| `--disallowedTools <tools>` | Disallowed tools list (comma or space separated) |
| `--permissionMode <mode>` | Permission mode: acceptEdits/bypassPermissions/default/plan |
| `--addDir <dirs>` | Additional directories for tool access |

### MCP Options

| Option | Description |
|--------|-------------|
| `--mcpConfig <files>` | Load MCP servers from JSON files or strings |
| `--strictMcpConfig` | Only use servers from --mcpConfig |

### AI Options

| Option | Description |
|--------|-------------|
| `--appendSystemPrompt <text>` | Append system prompt to default |
| `--model <name>` | Model for current session |
| `--fallbackModel <name>` | Enable automatic fallback to specified model |
| `--agents <json>` | Custom agent configuration JSON |

### Session Options

| Option | Short | Description |
|--------|-------|-------------|
| `--continue` | `-c` | Continue recent session |
| `--resume <id>` | `-r` | Resume specific session |
| `--forkSession` | | Create new session ID when resuming |
| `--sessionId <id>` | | Use specific session ID |

### Configuration Options

| Option | Description |
|--------|-------------|
| `--settings <path>` | Settings JSON file path or JSON string |
| `--settingSources <sources>` | Setting sources to load (comma separated) |

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
