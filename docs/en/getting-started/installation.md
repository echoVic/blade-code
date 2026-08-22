# 📦 Installation Guide

## 🚀 Installation Methods

### 1. Zero-install Trial

No installation required, try it directly with npx:

```bash
npx blade-code
npx blade-code "Hello, introduce yourself"
npx blade-code --print "Explain what TypeScript is"
```

> 💡 On first run you need to configure a model. Type `/model add` to enter the wizard.

### 2. Global Installation (Recommended)

```bash
# npm
npm install -g blade-code

# pnpm
pnpm add -g blade-code

# yarn
yarn global add blade-code
```

After installation you can use the `blade` command:

```bash
# CLI mode
blade                    # Enter interactive interface
blade "Analyze my code"  # Start with an initial message
blade --print "Hello"    # Print mode

# Web UI and server mode
blade web                # Start the Web UI and open the browser
blade serve              # Start a headless server
```

### 3. Project-local Installation

```bash
npm install blade-code
npx blade "Analyze my code"
```

## 🔐 Configuring Models

You need to configure a model on first launch. There are several ways:

### Wizard Configuration

On first run of `blade`, type `/model add` and select in order:

1. Provider
2. A model from the Provider Catalog
3. Provider credentials (if not yet configured)

Providers, models, default endpoints, context windows, and pricing are provided dynamically by the built-in catalog.

### Manual Configuration Example

You can also edit `~/.blade/config.json` manually:

```json
{
  "currentModelId": "primary",
  "models": [
    {
      "id": "primary",
      "displayName": "DeepSeek Pro",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    }
  ]
}
```

The API Key is written by the wizard into `~/.blade/auth.json` and never enters `config.json`.

### Getting API Keys

- **Qwen**: [DashScope Console](https://dashscope.console.aliyun.com/apiKey)
- **DeepSeek**: [DeepSeek Platform](https://platform.deepseek.com/api_keys)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)
- **Anthropic**: [Anthropic Console](https://console.anthropic.com/)
- **Google Gemini**: [Google AI Studio](https://aistudio.google.com/apikey)

## ✅ Verifying the Installation

```bash
blade --version    # Show the currently installed version
blade --help       # Show help
blade doctor       # Environment check
blade --print "Just a test"  # Test API connectivity
blade web          # Test the Web UI
```

## 🔧 System Requirements

- **Node.js**: ≥ 22.19.0
- **Terminal**: UTF-8 and color output support
- **OS**: macOS / Linux / Windows 10+

## 🐛 Common Issues

### Permission Error (EACCES)

```bash
# Option 1: Use sudo
sudo npm install -g blade-code

# Option 2: Change the npm global directory
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
# Add the export above to ~/.bashrc or ~/.zshrc
```

### Node.js Version Too Old

```bash
# Using nvm
nvm install 22.19 && nvm use 22.19

# Or using n
npm install -g n && n latest
```

### Slow Network / Installation Failure

```bash
# Use a China mirror
npm install -g blade-code --registry=https://registry.npmmirror.com
```

### Configuration / Key Issues

```bash
# Check configuration and runtime environment
blade doctor

# View model configuration without credentials
cat ~/.blade/config.json
```

## 🔄 Updating and Uninstalling

### Update to the Latest Version

```bash
# Check for updates
blade update

# Manual update
npm update -g blade-code

# Install a specific version
npm install -g blade-code@latest
```

### Uninstall

```bash
# Uninstall the global installation
npm uninstall -g blade-code

# Clean up configuration files (optional)
rm -rf ~/.blade
```

## 🎯 Next Steps

After installation, we recommend:

1. [Read the Quick Start guide](/en/getting-started/quick-start.md) - Get started in 5 minutes
2. [Understand the configuration system](/en/configuration/config-system.md) - Deep dive into configuration
3. [View the tool list](/en/reference/tool-list.md) - Learn about the available tools
