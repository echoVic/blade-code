# Workspace Model/Provider Runtime Isolation

Blade's process Store only represents the UI projection of the launch project. Web multi-project, ACP multi-cwd, Task worktrees, and background Subagents cannot look up running models or Provider endpoints from that Store.

## Session Model Snapshot

`SessionRuntime.create()` first determines the immutable source `projectRoot`, then rebuilds that project's model configuration via `resolveWorkspaceModelResources()`:

1. User `config.json` and `settings.json`
2. Target project `config.json` that has passed Workspace Trust
3. Target project `settings.json` and `settings.local.json`
4. Explicit runtime settings for the current invocation
5. `BLADE_MODEL` selection

`models` are replaced wholesale by later layers; `modelProviders` are merged by channel ID. When the target project is untrusted, its models, endpoints, environment variables, and default selection are all ignored.

The resolved result contains:

- A deep-copied `BladeConfig`
- A Session-private `PiModelCatalog`
- The canonical source `projectRoot`

The catalog uses a shared secure CredentialStore, but Provider definitions, model metadata, endpoints, and lazy fallback registrations do not share mutable state. `resolveModelConfig()` continues to bind this catalog to `ChatConfig`, so the initial model, runtime switching, and fallbacks all use the same snapshot.

## Sub-Sessions and Hooks

Task, Team, foreground/background Subagents, and resume explicitly inherit the parent Session's `SessionModelResources`, and the child Runtime copies the catalog again. Changes to project configuration after the parent Session is created do not alter the child's model routing.

Prompt Hooks are bound to their owning Runtime snapshot via `(sessionId, executionRoot)`. Worktrees register both the source root and execution root; Runtime disposal unbinds them and cleans up the Hook ChatService. Only independent Hook calls without a Session owner are temporarily resolved against the exact `projectDir`.

## Surface Consistency

- CLI/TUI: Explicit `--model` undergoes fail-closed validation within the source project snapshot.
- Web: Task dispatch resolves by `sourceProjectPath`; message switching validates against the existing Runtime; `/models` uses `x-blade-directory`. The frontend discards late old-workspace responses.
- ACP: Model config options for `session/new`, `session/load`, and `session/fork` come from the initialized Session, not from reading the launch Store.
- Worktree: Only changes the file execution directory; model and Provider identity still come from the source project.

## Qualification Verification

Deterministic tests have projects A/B use the same provider ID and model config ID with different endpoints. After creating snapshots, both the on-disk configuration and global catalog are modified, yet the two Pi runtimes can still only resolve their respective endpoints.

Real API tests have two local recording proxies forwarding to the same GPT upstream. Two concurrent Sessions each go through one proxy and complete sampling successfully; after the disk and global catalog are changed to a faulty port, active Sessions still maintain their original routing. The Production Web GUI binds two projects A/B; after project switching, model buttons and expanded lists respectively only show `GUI Model A` or `GUI Model B`, switch back recovers, and the browser console is empty.

## Related Resources

- [Workspace Agent Resource Isolation](/en/reference/workspace-agent-resources.md)
- [Workspace Trust](/en/guides/workspace-trust.md)
- [Model Transport Recovery](/en/reference/model-transport-recovery.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
