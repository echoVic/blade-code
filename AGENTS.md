# AGENTS.md

Always respond in Chinese.

## Project Overview

Blade Code is a modern AI-powered coding assistant with CLI + Web UI, built with React + Ink (CLI) and React + Vite (Web), using TypeScript.

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
- Integration tests must use real API calls, no mocks

## Release Process

1. Bump version in `packages/cli/package.json`
2. Update `CHANGELOG.md` with the new version's changes (what was added/changed/fixed)
3. Update related documentation if the feature affects user-facing behavior (docs/, README.md, AGENTS.md, etc.)
4. Build and run full test suite: `bun run build && bun run test:all`
5. Commit and tag: `git tag v<version>`
6. Push tag: `git push origin v<version>`
7. GitHub Actions (`publish.yml`) automatically publishes to npm and creates GitHub Release
8. Verify: `npm view blade-code version`

Each independent feature or fix must be released as a separate npm patch version.

## Documentation

- User docs: `docs/`
- [README.md](README.md) - Project overview
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guide
