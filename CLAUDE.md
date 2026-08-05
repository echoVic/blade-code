# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blade Code is a modern AI-powered coding assistant with CLI + Web UI, built with React + Ink (CLI) and React + Vite (Web), using TypeScript. Current version: **0.8.0**.

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
│   │       ├── services/pi/    # pi-ai runtime adapter
│   │       ├── schema/         # TypeBox runtime wrapper
│   │       ├── commands/       # CLI subcommands (serve, web, mcp, etc.)
│   │       ├── prompts/        # Prompt templates
│   │       ├── slash-commands/ # Slash commands
│   │       ├── skills/         # Skills system
│   │       ├── hooks/          # Hooks system
│   │       └── blade.tsx       # Entry point
│   └── vscode/         # blade-vscode - VSCode extension
├── docs/               # User documentation (Docsify)
└── .blade/             # Project-level config
```

## Key Design Principles

1. **Stateless Agent**: Agent doesn't store session state; all state passed via context
2. **Tool System**: Unified tool registration, execution, and validation with TypeBox schemas
3. **Permission Control**: Three-level permission system (allow/ask/deny)
4. **Session Management**: Multi-session support with resume and fork capabilities
5. **pi-ai Runtime**: Single LLM abstraction layer; model metadata from catalog, not hardcoded

## Code Style

- TypeScript strict mode
- Biome for linting and formatting (single quotes, semicolons, 88 char line width)
- Avoid `any` type
- Use TypeBox schemas for tool parameters (not Zod)

## Testing

- Test framework: Vitest
- Tests location: `packages/cli/tests/`
- Run tests: `bun run test:all`

## Documentation

- User docs: `docs/`

## gstack

Use the /browse skill from gstack for all web browsing, never use mcp__claude-in-chrome__* tools.

Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.

## More Information

- [README.md](README.md) - Project overview
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guide
- [BLADE.md](BLADE.md) - Detailed project context (Chinese)
