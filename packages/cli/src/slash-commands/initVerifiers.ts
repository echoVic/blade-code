import type { SlashCommand } from './types.js';

export const INIT_VERIFIERS_PROMPT = `Create project verification skills from this workspace's actual configuration.

1. Read project instructions, manifests, lockfiles, CI workflows, test configuration,
   scripts, and existing .blade/skills/verify-*/SKILL.md. Determine the actual package
   manager, checks, app entry points, and local development commands. Trace commands
   to source files. Never invent a script, URL, port, test result, or supported tool.
2. Create only relevant skills under .blade/skills/verify-<scope>/SKILL.md.
   Use YAML frontmatter with name matching the directory, a description explaining
   what it verifies and when to use it, and user-invocable: true. Body sections must
   include scope, prerequisites, exact commands and working directories, expected
   observable behavior, evidence to capture, and cleanup. Keep existing unrelated
   skills intact; read before updating a matching skill.
3. Cover available automated checks (tests, lint, type checking), browser UI flows,
   HTTP endpoints, and interactive CLI/tmux flows only where the project has those
   surfaces. Prefer the native Browser tools for rendered UI evidence. Discover
   deferred tools with ToolSearch when available. Use tmux only when it is installed
   and the CLI requires a terminal. Specify local fixture data and concrete assertions.
4. Inspect commands before running them. Use existing dependencies, bounded timeouts,
   and isolated temporary data. If a check starts a server or terminal session,
   record ownership and stop only that process or session when finished. Do not
   install packages, deploy, publish, or contact external services unless already
   authorized. Redact credentials from recorded evidence.
5. Include an independent-audit section in every skill: verification agents have
   Read/Glob/Grep/Bash only, a read-only workspace, and a restricted verification
   command policy. A skill never grants permissions. Supply a supported no-write
   command when possible. Browser interaction, server startup, curl, tmux, or a build
   that emits files may need the primary agent. Mark unavailable checks explicitly;
   never claim a pass from a command that did not run.
6. Validate generated frontmatter and referenced paths. Run safe, relevant smoke
   checks where available; distinguish inspected configuration from executed evidence.
   Report files created or updated, commands run, outcomes, and unavailable checks.
   Project skills are loaded only after Workspace Trust accepts them and a new
   Session captures them. Tell the user to review /trust and start a new Session
   after generation; /skills refresh alone does not replace an active Session snapshot.
`;

const initVerifiersCommand: SlashCommand = {
  name: 'init-verifiers',
  description: '从实际项目配置生成可复用的验证 Skills',
  usage: '/init-verifiers',
  async handler(args, context) {
    if (args.length > 0) {
      return { success: false, error: 'Usage: /init-verifiers' };
    }
    if (context.workspaceKind === 'acp-remote') {
      return { success: false, error: '远程工作区暂不支持生成项目验证 Skills' };
    }
    return {
      success: true,
      data: {
        action: 'invoke_custom_command',
        commandName: 'init-verifiers',
        processedContent: INIT_VERIFIERS_PROMPT,
      },
    };
  },
};

export default initVerifiersCommand;
