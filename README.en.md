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

- 🤖 **Intelligent Conversations** - LLM-powered with context understanding and multi-turn dialogues
- 🛠️ **Rich Toolset** - 18+ built-in tools: file operations, code search, shell execution, Git, and more
- 🔗 **MCP Protocol** - Model Context Protocol support for seamless external tool integration
- 🎨 **Modern UI** - React + Ink based terminal UI with Markdown rendering and syntax highlighting
- 💾 **Session Management** - Multi-session, continuation, recovery, and forking support
- 🔒 **Secure & Controllable** - Three-tier permission system (allow/ask/deny), tool whitelisting

---

## 🚀 Quick Start

### Try Without Installation

```bash
npx blade-code
npx blade-code --print "Explain what TypeScript is"
```

### Global Installation

```bash
npm install -g blade-code
# or
pnpm add -g blade-code
```

### Basic Usage

```bash
blade                              # Interactive mode
blade "Help me analyze this project" # Enter with initial message
blade --print "Write a quicksort"   # Print mode (for piping)
blade --continue                   # Continue last conversation
```

> On first run, if no API key is configured, a setup wizard will appear automatically.

---

## 🔐 Configuration

### Config File

```bash
mkdir -p ~/.blade
cat > ~/.blade/config.json << 'EOF'
{
  "provider": "openai-compatible",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4"
}
EOF
```

Supports environment variable interpolation: `"apiKey": "${BLADE_API_KEY}"`

### Get API Keys

- **Qwen**: [DashScope Console](https://dashscope.console.aliyun.com/apiKey)
- **VolcEngine**: [Volcano Ark Console](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)

---

## 💬 Usage Examples

```bash
# Smart tool invocation
blade "List all TypeScript files"
blade "Find code containing TODO"
blade "Review code in src/utils"

# Session management
blade --session-id "my-project" "Start new project"
blade --resume <id>                # Resume session
blade --resume <id> --fork-session # Fork session

# Security control
blade --allowed-tools "Read,Grep" "Read-only operations"
blade --permission-mode plan "Plan only, no execution"
blade --yolo "Auto-approve all operations"
```

---

## 📚 Command Reference

### Main Commands

| Command | Description |
|---------|-------------|
| `blade` | Start interactive assistant |
| `blade config` | Configuration management |
| `blade mcp` | MCP server management |
| `blade doctor` | System health check |
| `blade update` | Check for updates |

### Common Options

| Option | Short | Description |
|--------|-------|-------------|
| `--print` | `-p` | Print response and exit |
| `--continue` | `-c` | Continue recent session |
| `--resume <id>` | `-r` | Resume specific session |
| `--model <name>` | | Specify model |
| `--yolo` | | Auto-approve all operations |

### Slash Commands

Use in interactive mode: `/init` `/help` `/clear` `/compact` `/context` `/agents` `/permissions` `/mcp` `/resume` `/theme` `/model`

---

## 📖 Documentation

- **[User Docs](https://echovic.github.io/blade-doc/#/)** - Installation, configuration, usage guides
- **[Developer Docs](docs/development/README.md)** - Architecture, implementation details
- **[Contributing Guide](CONTRIBUTING.md)** - Open source contribution

---

## 🤝 Contributing

Contributions welcome! See [Contributing Guide](CONTRIBUTING.md).

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code && pnpm install && pnpm dev
```

---

## 💬 Community

Add WeChat **VIc-Forever** with note "Blade" to join the group.

---

## 💬 Community

Add assistant on WeChat **VIc-Forever**, remark "Blade" to join the group.

---

## 🔗 Related Resources

- [NPM Package](https://www.npmjs.com/package/blade-code)
- [Report Issues](https://github.com/echoVic/blade-doc/issues)

---

## 📄 License

[MIT](LICENSE) - Made with ❤️ by [echoVic](https://github.com/echoVic)
