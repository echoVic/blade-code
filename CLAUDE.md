# CLAUDE.md

always respond in Chinese

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blade Code is a modern AI-powered CLI coding assistant built with React + Ink and TypeScript. The project uses **pnpm workspace monorepo** architecture.

## Quick Commands

```bash
pnpm dev              # Start all packages in dev mode
pnpm dev:cli          # Start CLI dev mode only
pnpm dev:web          # Start Web UI dev mode only
pnpm build            # Build all packages
pnpm test:all         # Run all tests
pnpm lint             # Run linter
pnpm type-check       # TypeScript type checking
pnpm preflight        # Full check (clean, install, format, lint, build, type-check, test)
```

## Architecture

### Monorepo Structure

```
Blade/
├── packages/
│   ├── cli/            # @blade/cli - CLI core
│   │   └── src/
│   │       ├── agent/          # Stateless Agent core
│   │       ├── tools/          # Tool system (builtin, execution, registry)
│   │       ├── mcp/            # MCP protocol support
│   │       ├── context/        # Context management
│   │       ├── config/         # Configuration management
│   │       ├── ui/             # UI components (React + Ink)
│   │       ├── store/          # State management (Zustand)
│   │       ├── services/       # Service layer
│   │       ├── cli/            # CLI configuration
│   │       ├── commands/       # Command handlers
│   │       ├── prompts/        # Prompt templates
│   │       ├── slash-commands/ # Slash commands
│   │       └── blade.tsx       # Entry point
│   ├── web/            # @blade/web - Web UI
│   ├── vscode/         # @blade/vscode - VSCode extension
│   └── shared/         # @blade/shared - Shared utilities
├── docs/               # Documentation
├── pnpm-workspace.yaml # Workspace config
└── tsconfig.base.json  # Shared TypeScript config
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
- Run tests: `pnpm test:all`

## Documentation

- User docs: `docs/`

## More Information

- [README.md](README.md) - Project overview
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guide
- [BLADE.md](BLADE.md) - Detailed project context (Chinese)
