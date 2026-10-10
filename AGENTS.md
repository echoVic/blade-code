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

### Release Boundaries

- `packages/cli/package.json` is the only authoritative npm version. The root
  `package.json` version is private monorepo metadata.
- Release each independent feature or fix as its own npm patch version.
- Keep implementation, release metadata, and any qualification fix in separate
  commits so the exact candidate is auditable.
- Serialize releases. Do not push multiple new release tags in one batch:
  npm assigns `latest` when each publish completes, so concurrent releases can
  leave `latest` pointing at an older version.

### Prepare and Qualify the Exact Candidate

1. Start from a clean `main` synchronized with `origin/main`.
2. Commit the implementation or fix before preparing release metadata.
3. Bump `packages/cli/package.json`.
4. Update both changelogs with the same version heading and equivalent content:
   - `CHANGELOG.md` is the English authoritative source consumed by npm and
     `VersionChecker`.
   - `CHANGELOG.zh.md` is the manually synchronized Chinese source.
5. Update related bilingual user documentation when behavior is user-facing.
   Do not edit generated `docs/changelog.md` or `docs/en/changelog.md`.
6. Commit release metadata as `chore: release v<version>`.
7. On that exact commit, run every release gate:

   ```bash
   bun install --frozen-lockfile
   bun run build
   bun run test:all
   bun run lint
   bun run type-check
   ```

   `bun run lint` includes the repository-wide Biome format check. Package-only
   lint commands are not an equivalent release gate. Paid real-API
   qualification remains separate and must be run when the affected release
   matrix requires it.
8. Confirm the worktree is still clean and the npm version and remote tag do
   not already exist.
9. Extract the exact English changelog section into a temporary notes file and
   create an annotated tag:

   ```bash
   git tag -a v<version> -F <release-notes-file>
   git cat-file -t v<version>       # must print: tag
   git rev-list -n 1 v<version>     # must equal the qualified candidate SHA
   ```

10. Push the branch and one release tag:

    ```bash
    git push origin main
    git push origin v<version>
    ```

### Automated Publication

- `.github/workflows/publish.yml` runs the full reusable CI workflow before
  publishing.
- The workflow validates that `v<version>` matches
  `packages/cli/package.json`, builds again, upgrades npm, publishes with
  Trusted Publishing (OIDC), and ensures a GitHub Release exists.
- npm publishing must use `npm publish --access public --tag latest`.
- Do not add a separate `npm dist-tag add` step unless the npm Trusted Publisher
  is explicitly configured with **Allow npm dist-tag**. Without that permission
  npm returns `E403` after a successful publish and prevents later workflow
  steps, including GitHub Release creation.
- Do not use legacy long-lived npm tokens or the old token helper scripts.
- Publication is idempotent: an existing npm version is skipped and an existing
  GitHub Release is retained.

### Monitor and Recover

Monitor the tag workflow until the `publish` job completes:

```bash
gh run list --workflow=publish.yml --limit=5
gh run view <run-id> --json status,conclusion,jobs
gh run view <run-id> --log-failed
```

If `npm publish` succeeds but a later step fails:

1. Do not rewrite the public tag or attempt to republish the immutable npm
   version.
2. Verify `npm view blade-code@<version> version` and the `latest` dist-tag.
3. Create only the missing GitHub Release from the matching `CHANGELOG.md`
   section with `gh release create ... --verify-tag`.
4. Fix the workflow in a separate patch release.

If CI exposes a newly disclosed transitive vulnerability, update the smallest
compatible dependency or lockfile entry, run `bun audit --audit-level=critical`,
and qualify that fix as its own patch release.

### Post-Release Verification

1. Verify the immutable version, `latest`, GitHub Release, remote tag, and clean
   worktree:

   ```bash
   npm view blade-code@<version> version
   npm view blade-code dist-tags.latest
   gh release view v<version>
   git ls-remote --tags origin refs/tags/v<version>
   git status --short --branch
   ```

2. npm metadata can appear before the tarball CDN is ready. If installation
   returns tarball `404`, wait and retry; do not publish the version again.
3. Finish with a clean-directory installation smoke test:

   ```bash
   tmpdir="$(mktemp -d)"
   trap 'rm -rf "$tmpdir"' EXIT
   cd "$tmpdir"
   npm init -y >/dev/null 2>&1
   npm install --ignore-scripts blade-code@latest
   node -p "require('./node_modules/blade-code/package.json').version"
   ./node_modules/.bin/blade --version
   ```

   The installed package version, CLI-reported version, and npm `latest`
   dist-tag must all equal the released version.

The docs site (`docs/`) is bilingual: Chinese is the default under the docs root
and English lives under `docs/en/`. `docs/changelog.md` (zh) and
`docs/en/changelog.md` (en) are build artifacts synced from `CHANGELOG.zh.md`
and `CHANGELOG.md` by the Deploy Docs workflow — do not edit them directly.

## Documentation

- User docs: `docs/`
- [README.md](README.md) - Project overview
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution guide
