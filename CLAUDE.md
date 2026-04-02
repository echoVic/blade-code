# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blade Code is a modern AI-powered coding assistant with CLI + Web UI, built with React + Ink (CLI) and React + Vite (Web), using TypeScript. Current version: **0.2.0**.

## Quick Commands

```bash
# Development
bun run dev           # Start CLI dev mode (watch)
bun run dev:web       # Start CLI + Web server
bun run build         # Build CLI

# Running
blade                 # Start interactive CLI
blade web             # Start Web UI (opens browser)
blade serve           # Start headless server

# Testing & Quality
bun run test:all      # Run all tests
bun run lint          # Run linter
bun run type-check    # TypeScript type checking
```

## Architecture

### Monorepo Structure

```
Blade/
├── packages/
│   ├── cli/            # blade-code - CLI core (npm package)
│   │   └── src/
│   │       ├── agent/          # Stateless Agent core
│   │       ├── tools/          # Tool system (builtin, execution, registry)
│   │       ├── server/         # Web server (Hono)
│   │       ├── mcp/            # MCP protocol support
│   │       ├── context/        # Context management
│   │       ├── config/         # Configuration management
│   │       ├── ui/             # Terminal UI (React + Ink)
│   │       ├── store/          # State management (Zustand)
│   │       ├── services/       # Service layer (Chat, Session, etc.)
│   │       ├── commands/       # CLI subcommands (serve, web, mcp, etc.)
│   │       ├── prompts/        # Prompt templates
│   │       ├── slash-commands/ # Slash commands
│   │       ├── skills/         # Skills system
│   │       ├── hooks/          # Hooks system
│   │       ├── spec/           # Spec mode
│   │       └── blade.tsx       # Entry point
│   └── vscode/         # blade-vscode - VSCode extension
├── docs/               # User documentation (Docsify)
└── .blade/             # Project-level config
```

## Key Design Principles

1. **Stateless Agent**: Agent doesn't store session state; all state passed via context
2. **Tool System**: Unified tool registration, execution, and validation with Zod schemas
3. **Permission Control**: Three-level permission system (allow/ask/deny)
4. **Session Management**: Multi-session support with resume and fork capabilities

## Code Style

- TypeScript strict mode
- Biome for linting and formatting (single quotes, semicolons, 88 char line width)
- Avoid `any` type
- Use Zod schemas for tool parameters

## Testing

- Test framework: Vitest
- Tests location: `packages/cli/tests/`
- Run tests: `bun run test:all`

## Documentation

- User docs: `docs/`

## More Information

- [README.md](README.md) - Project overview
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guide
- [BLADE.md](BLADE.md) - Detailed project context (Chinese)
