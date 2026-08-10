# Workspace Plugin Lifecycle

Blade discovers plugins per canonical source project and applies one effective
enabled state before creating a Session resource snapshot.

## Persistent policy

Plugin state is stored in the `enabledPlugins` map:

```json
{
  "enabledPlugins": {
    "review-plugin": false
  }
}
```

Settings are merged by plugin name with this precedence:

```text
local > project > user > default enabled
```

- User scope: `~/.blade/settings.json`
- Project scope: `.blade/settings.json`
- Local scope: `.blade/settings.local.json`

Management surfaces call the user layer `global`. A state write records only
the selected `global`, `project`, or `local` layer; more specific layers still
win. The TUI and Web project each plugin's effective scope and the configured
layer values so a successful write cannot be mistaken for an effective state
change.

An untrusted project may set a plugin to `false`, but cannot enable a plugin
that a user layer disabled. Project plugins are not discovered until Workspace
Trust is granted.

Plugins loaded explicitly with `--plugin-dir` are invocation-scoped, always
active for that invocation, and cannot be changed through persistent settings.

## Managed packages and Marketplaces

Blade maintains a private package store under `~/.blade/plugin-state/`:

- `state.json` is an atomically written `0600` ledger;
- package and Marketplace roots are content-addressed immutable directories;
- every package records its normalized source, exact Git revision or local
  digest, content digest, version, and timestamps;
- managed package content is re-hashed before registry loading.

Remote Git sources must use HTTPS or SSH. Credentials embedded in URLs, URL
query/fragment refs, symbolic links, path escapes, oversized packages, and
non-regular filesystem entries are rejected. Git is invoked with an argument
array rather than through a shell.

Installing or updating executable plugin content requires explicit source
trust:

```text
/plugins install review-tools@team-market --trust
/plugins update review-tools --trust
```

This trust acknowledges that a plugin may provide Hooks, MCP servers, skills,
agents, and commands. Plugin Hooks still require their separate content-digest
Hook Trust approval.

Marketplaces are catalogs, not executable plugin projections:

```text
/plugins marketplace add owner/repository
/plugins marketplace add ./local-marketplace
/plugins marketplace list
/plugins marketplace update [name]
/plugins marketplace remove name --confirm
```

Blade supports `.blade-plugin/marketplace.json`,
`.claude-plugin/marketplace.json`, and root `marketplace.json`. Local
Marketplace sources require Workspace Trust. Relative plugin entries must stay
inside the materialized Marketplace root. A Marketplace cannot be removed
while installed plugins still reference it.

Directories placed manually in `~/.blade/plugins/` or `.blade/plugins/` remain
discoverable but are not package-manager controlled. Automatic update and
uninstall apply only to managed installations.

## Compatibility and dependencies

Plugin manifests may declare:

```json
{
  "bladeVersion": ">=0.9.0",
  "dependencies": {
    "shared-tools": "^2.0.0"
  }
}
```

Blade validates every semver range before loading code. Installing a managed
Marketplace plugin resolves its complete same-Marketplace dependency closure,
detects cycles, validates every Blade/dependency version, materializes all
members, then commits the closure in one ledger write. A direct URL or local
plugin cannot silently discover missing dependencies, and cross-Marketplace
dependencies must be installed explicitly.

At registry load time Blade repeats compatibility checks as a fixed-point
calculation. Missing, incompatible, disabled, policy-blocked, or transitively
broken dependencies put dependents into `error` state and remove their
resources from future Session snapshots. Uninstall refuses to remove a plugin
while another installed plugin declares it as a dependency.

## Source policy

`pluginSourcePolicy` is a workspace-effective, tighten-only security policy:

```json
{
  "pluginSourcePolicy": {
    "restrictToAllowedSources": true,
    "requireGitCommitSha": true,
    "allowedGitHosts": ["github.com", "*.corp.example"],
    "allowedMarketplaces": ["team-market"],
    "allowedLocalRoots": ["/opt/company/plugins"]
  }
}
```

User configuration establishes the base policy. Project and local layers may
only require stricter controls or intersect allowlists; they cannot relax user
requirements. `BLADE_PLUGIN_REQUIRE_SHA=1` also enables SHA enforcement and
cannot be overridden off.

When strict source mode is enabled, an empty allowlist denies that source kind.
Marketplace identity and its underlying Git/local source must both be allowed.
Full-SHA mode rejects mutable Git refs before network access and verifies the
checked-out `HEAD` matches the requested 40-character commit.

## Session snapshots

Commands, skills, agents, and effective Hook configuration are copied into the
Session snapshot. Changing plugin state:

- immediately updates the workspace registry for future Sessions;
- does not remove resources or Hooks from a Session that is already running;
- is inherited by foreground, background, Team, worktree, and resumed child
  Sessions through the parent snapshot.

Plugin MCP definitions are filtered by the same policy before a Session creates
its private MCP registry.

Managed updates publish a new immutable package root and atomically switch the
ledger. Old roots are retained, so a live Session can continue reading its
original skills and plugin root after a later Session receives the update.
Uninstall removes the ledger projection but does not delete roots that may
still be referenced by a live Session.

## Plugin Hooks

Plugin Hook matchers are collected as one set and swapped into the workspace
Hook configuration together. Multiple plugins can contribute to the same event
without overwriting each other.

Every Plugin Hook carries:

- plugin name;
- plugin source (`user`, `project`, or `cli`);
- plugin root used at execution time.

Command Hooks receive `BLADE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, and
`BLADE_PLUGIN_NAME`. The absolute plugin root is excluded from the Hook Trust
digest so equivalent Git worktrees do not invalidate approval, while plugin
identity and Hook content remain part of the reviewed digest.

External Plugin Hooks remain subject to Hook Trust and run with the owning
Session environment.

## Management surfaces

- TUI: `/plugins`, arrow keys, Space/Enter, `s` to select the write scope,
  `u`, `x`, and `r`
- CLI/headless/ACP: `/plugins install|update|uninstall`,
  `/plugins marketplace`, `/plugins policy`, and `/plugins enable|disable`
- Web: Settings > Plugins includes package and Marketplace lifecycle controls,
  write-scope selection, effective-scope badges, and layer provenance
- HTTP: `/plugins/install`, `/plugins/:name/update`,
  `/plugins/:name/uninstall`, `/plugins/catalog`, and
  `/plugins/marketplaces/*`, plus `/plugins/:name/state`; all require an
  explicit absolute `projectPath`

Install, update, and uninstall reconcile resources automatically. Uninstall
removes stale state entries from all editable scopes for the current project.
