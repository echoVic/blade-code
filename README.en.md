<div align="center">

# 🗡️ Blade Code

**Next-Generation AI Coding Assistant (CLI)**

[![npm version](https://img.shields.io/npm/v/blade-code.svg?style=flat-square)](https://www.npmjs.com/package/blade-code)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/blade-code.svg?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

English | [简体中文](README.md)

</div>

---

## ✨ Key Features

- 🤖 **Smart Chat** - Context-aware, multi-turn collaboration with session continuity
- 🆓 **Out of the Box** - Built-in free GLM-4.7 model, plus custom models
- 🛠️ **Rich Tooling** - 20+ built-in tools: file/search/shell/git/web and more
- 🔗 **Extensible** - MCP, plugins, and Skills system
- 📋 **Structured Workflows** - Spec / Plan / Subagents
- 🔒 **Secure Control** - Permission modes: default/autoEdit/plan/yolo + allow/deny lists
- 🎨 **Modern UI** - React + Ink TUI with Markdown and syntax highlighting

---

## 🚀 Quick Start

```bash
npx blade-code

npm install -g blade-code
# or
pnpm add -g blade-code

blade
blade "Help me analyze this project"
blade --print "Write a quicksort"
```

> Uses the built-in free model by default; run `blade` to configure your own provider.

---

## ⚙️ Optional Configuration

Config supports global and project scope: `~/.blade/config.json` or `.blade/config.json`.
See docs for the full schema.

```json
{
  "provider": "openai-compatible",
  "apiKey": "${BLADE_API_KEY}",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o-mini"
}
```

---

## 🧰 CLI At a Glance

**Common Commands**

- `blade` start interactive UI
- `blade mcp` manage MCP servers
- `blade doctor` environment check
- `blade update` check for updates
- `blade install` install a specific version (experimental)

**Common Options**

- `--print/-p` print mode (pipe-friendly)
- `--output-format` output: text/json/stream-json
- `--permission-mode` permission mode
- `--resume/-r` resume session / `--session-id` set session

---

## 📖 Documentation

- **[User Docs](https://echovic.github.io/blade-doc/#/)**
- **[Docs entry in repo](docs/README.md)**
- **[Contributing Guide](CONTRIBUTING.md)**

---

## 🤝 Contributing

```bash
git clone https://github.com/echoVic/blade-code.git
cd blade-code && pnpm install && pnpm dev
```

---

## 💬 Community

Add WeChat **VIc-Forever**, remark "Blade" to join the group.

---

## 🔗 Related Resources

- [NPM Package](https://www.npmjs.com/package/blade-code)
- [Discord Community](https://discord.gg/utXDVcv6) - Join our Discord server
- [Report Issues](https://github.com/echoVic/blade-code/issues)

---

## 📄 License

[MIT](LICENSE) - Made with ❤️ by [echoVic](https://github.com/echoVic)
