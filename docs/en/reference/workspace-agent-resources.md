# Workspace Agent Resource Isolation

Blade manages subagents, skills, custom commands, plugins, communication styles, and contextual project rules on a per-source-project basis. The process current directory and Store are only used for the launch surface and cannot serve as the resource lookup source for concurrent Web, ACP, TUI, or Task Sessions.

## Two-Tier Resource Model

Each canonical project path corresponds to a set of refreshable workspace registries:

- `SubagentRegistry`
- `SkillRegistry`
- `CustomCommandRegistry`
- `PluginRegistry`
- `CommunicationStyleCatalog`
- `ProjectRuleCatalog`

`resolveWorkspaceAgentResources(projectRoot)` is responsible for loading user-level resources in one pass, project resources that have passed Workspace Trust, explicit `--plugin-dir`, and then integrating plugin commands, skills, and agents into the same project's registry. Different projects do not share mutable registries.

When creating a `SessionRuntime`, Blade copies out a Session-private snapshot:

- Subagent configurations and tool/skill lists are deep-copied;
- Skill metadata and plugin skill mappings are copied;
- Custom/plugin command configurations are copied;
- Effective plugin Hook configurations are copied and bound by Session identity;
- Custom output style prompts and project rule catalogs are deep-copied;
- Task, Team, Skill, and SlashCommand tools are bound to this snapshot via closures.

Project refreshes, plugin enable/disable, trust revocation, or UI management operations only update the workspace registry and do not alter tool descriptions or execution lookup results already exposed to an active model turn.

## Sources and Priority

The workspace registry is loaded according to existing compatibility priority:

1. Built-in resources
2. Claude Code user-level resources
3. Blade user-level resources
4. Claude Code-compatible resources from trusted projects
5. Blade resources from trusted projects
6. Namespaced resources from user/project/CLI plugins
7. `--agents` override for the current invocation

`--agents` only writes to the Session snapshot and does not modify the workspace base table. `--plugin-dir` is resolved before CLI mode dispatch, so TUI, print, headless, serve, and ACP all use the same explicit plugin sources.

Untrusted projects can only use built-in, user-level, and explicit CLI sources. Project plugins, commands, skills, and agents all fail closed.

## Sub-Sessions and Worktrees

When Task or Team creates foreground, background, or resume sub-Sessions, it explicitly passes the parent Session's resource snapshot. The sub-Session copies it once more, so:

- Invocation agents can continue to be used in nested Tasks;
- Plugin refreshes do not change a running child;
- Resume retains the resource view from when the parent Session was created;
- Resources from project A cannot enter a child of project B.

`projectRoot` represents resource and configuration identity; `workspaceRoot` represents the file execution path. A Task worktree only replaces `workspaceRoot`; resources, plugin MCP, hooks, project rules, and default configuration are still resolved against the source project. Contextual rule trigger paths are mapped back from the execution workspace to the source project before matching.

## Surface Consistency

- CLI/TUI: `useAgent` passes invocation agents to `SessionRuntime`, and management plane operations precisely target the current workspace registry.
- Web: Each `sessionId + projectPath` Runtime holds an independent snapshot; multi-project tasks can run concurrently; Folder Trust updates rebuild the workspace registry.
- ACP: Each `session/new` `cwd` resolves resources independently; Sessions with different cwds in the same ACP connection do not share project resources.

## Qualification Verification

Deterministic tests use two real temporary directories to load native and plugin agents/skills/commands, then clear the workspace registry to prove that Session tools still retain their original snapshot and the other side's resources have zero hits.

Real API qualification includes:

- GPT dual `SessionRuntime` concurrently calling respective plugin commands;
- GPT calling respective plugin commands in dual-cwd Sessions within the same ACP connection;
- DeepSeek Flash/Pro completing Read/Edit/Bash via production CLI `--agents -> Task`;
- Production Web GUI binding and trusting two projects A/B, calling `plugin-a:reveal` and `plugin-b:reveal` respectively in independent worktrees, maintaining independent projections after switching back, and a fresh tab having zero console errors.

## Related Resources

- [Workspace Trust](/en/guides/workspace-trust.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [Tool Concurrency Model](/en/reference/tool-concurrency.md)
- [Trusted Contextual Project Rules](/en/reference/trusted-contextual-project-rules.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
