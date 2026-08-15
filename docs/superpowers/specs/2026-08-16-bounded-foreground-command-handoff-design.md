# Bounded Foreground Command Handoff Design

## Status

- Target: `blade-code@0.10.36`
- Capability: bounded foreground Bash handoff
- Scope: runtime, Headless, raw PTY TUI, Web, ACP, deterministic tests, real API

## Problem

Blade can start Bash directly in the background, but the model must predict that
need before launch by setting `run_in_background=true`. A foreground command
otherwise owns its tool execution slot until it exits or reaches the requested
timeout. At timeout Blade kills the process tree.

This creates a long-task progression failure:

- dependency installation, compilation, test, server, and watcher commands can
  block the Agent turn even after they have safely started;
- the model cannot inspect files, delegate independent work, or report progress
  while that command owns the foreground call;
- choosing foreground by mistake loses the running process at timeout instead
  of preserving its state;
- moving the call to the background after it starts is not currently possible
  without launching a second command and risking duplicate side effects;
- adding automatic handoff without a second admission boundary would convert
  bounded foreground execution into unbounded background processes;
- local, Web, raw PTY, and ACP do not have a common handoff result contract.

`0.10.35` bounds tool admission, but an admitted Bash call can still consume a
slot for its full foreground timeout. This patch moves a healthy, eligible
command to separately bounded background ownership after a short foreground
blocking budget without restarting it.

## Reference Implementations

### Claude Code

`src/tools/BashTool/BashTool.tsx`:

- emits foreground progress after two seconds;
- uses a 15-second assistant blocking budget;
- transfers the same command to its background task registry rather than
  killing or restarting it;
- preserves output and returns the background task ID;
- excludes standalone `sleep` from automatic backgrounding;
- gives each concurrent tool a child AbortController.

Its MCP path separately demonstrates that a long-running tool needs progress,
explicit cancellation, and an independent hard timeout rather than one
universal short `Promise.race`.

### Codex

`codex-rs/core/src/unified_exec/process_manager.rs` persists a live process
before its initial yield wait. `exec_command` defaults to a 10-second yield
window and returns the same process ID when it remains alive. `write_stdin`
continues against that process.

The important ownership order is:

```text
spawn
-> persist live process ownership
-> wait bounded foreground yield window
-> return completion or live process ID
```

### Neovate Code

`src/tools/bash.ts` starts one command, observes output and completion, and can
move the same process into `BackgroundTaskManager`. It does not replay the
command after deciding it should be background work.

### Grok Build

`xai-grok-tools` separates:

- the foreground timeout;
- a 15-second foreground block budget;
- foreground-to-background transfer;
- background lifetime;
- typed timeout/background notifications.

The terminal backend proves that a one-hour foreground timeout can hand off
after a 300 ms test budget while the same process remains queryable. Its
background default is unbounded and controlled by task tooling, while positive
background deadlines can provide an explicit kill backstop.

## Design Principles

1. **Never restart on handoff.** The PID or ACP terminal handle is identical
   before and after transfer.
2. **Ownership precedes response.** Blade must durably own or be able to kill
   the background work before returning its task ID.
3. **Background work is separately bounded.** Releasing a tool slot must not
   create unbounded process fan-out.
4. **Foreground timeout wins when earlier.** If the requested timeout is no
   greater than the handoff budget, the existing timeout behavior remains.
5. **Turn cancellation stops only foreground candidates.** After successful
   handoff, a later turn abort/discard does not kill the background command.
   Session/runtime/process shutdown still does.
6. **Output is continuous and bounded.** Bytes produced before and after
   handoff use one accounting stream and remain available through TaskOutput.
7. **ACP remains ACP.** A foreground command launched through a real IDE
   terminal is not silently replaced with a local child process.
8. **No false completion.** Handoff is a successful running result, not a
   terminal command result.

## Frozen Limits

```text
default foreground blocking budget = 15_000 ms
minimum non-zero configured budget = 1_000 ms
maximum configured budget          = 300_000 ms

process active background shells   = 16
Session active background shells   = 4

stdout retained bytes              = existing 1 MiB bound
stderr retained bytes              = existing 1 MiB bound
```

`bashForegroundHandoffMs=0` disables automatic handoff. The value is stored in
the normal Blade configuration and copied into each immutable Session runtime
snapshot. Tests inject shorter values only through the same production config
path.

The background limits count:

- explicitly backgrounded local commands;
- local foreground candidates that may hand off;
- ACP foreground candidates that may hand off;
- already handed-off local and ACP commands.

Completed records do not consume active capacity. Hidden foreground candidates
are not visible through `/tasks`, TaskOutput, KillShell, or WriteStdin until
handoff succeeds.

## Eligibility

Automatic handoff is enabled only when all conditions hold:

- `run_in_background` is false;
- an exact Session ID and workspace root exist;
- `bashForegroundHandoffMs > 0`;
- requested foreground timeout is greater than the handoff budget;
- the caller is not a read-only audit/verification subagent;
- the command is not an explicit standalone or leading `sleep`;
- process and Session background capacity can be reserved before spawn;
- the selected transport can retain and later terminate the same execution.

An ineligible or capacity-rejected command uses the existing foreground path.
The command is never restarted to obtain background ownership.

Explicit `run_in_background=true` still attempts immediate background
admission. Capacity failure returns a typed, retryable `tool_busy` result
without starting user code.

## Runtime State

`BackgroundShellManager` becomes the single process-local registry for explicit
background commands and handoff candidates.

Each record adds:

```ts
type BackgroundShellTransport = 'local' | 'acp';

interface BackgroundShellProcess {
  // Existing identity, command, output, terminal facts...
  transport: BackgroundShellTransport;
  visible: boolean;
  autoBackgrounded: boolean;
  backgroundReason?: 'explicit' | 'foreground_budget';
  foregroundBudgetMs?: number;
  completion: Promise<void>;
  terminationReason?: 'timeout' | 'aborted' | 'killed';
}
```

Private callbacks abstract transport ownership:

```ts
terminate(): Promise<void>;
release(): Promise<void>;
writeInput?(data: string, close: boolean): Promise<WriteInputResult>;
```

Local records retain `ChildProcess` and `OwnedProcessTree`. ACP records retain
the SDK terminal handle through closures; they do not manufacture a PID.

## Local Ownership Transfer

Local foreground candidates continue to start through
`prepareForegroundProcess()`, so the existing durable foreground lease and
command-admission gate remain authoritative before user code.

The transfer is:

```text
reserve Session/process background capacity
-> spawn under command-admission gate
-> commit foreground lease
-> release user code
-> wait for exit / timeout / abort / handoff budget
-> if budget wins:
     register background lease for the same root PID
     remove foreground lease
     mark record visible
     detach turn AbortSignal listener
     return background result
```

Background lease registration must complete before foreground lease removal.
If registration fails, the foreground lease remains authoritative and the
command continues in the foreground. No gap may exist in which neither lease
owns the process.

After handoff, normal process exit:

```text
finalize full process group
-> remove background lease
-> publish terminal record
-> release active background capacity
```

## ACP Ownership Transfer

`AcpTerminalService` creates the real client terminal first. If background
capacity was reserved, it registers a hidden external candidate containing:

- the ACP terminal handle;
- bounded cumulative output state;
- `waitForExit`, `kill`, and `release` ownership;
- Session identity and foreground budget.

The same race is then evaluated:

```text
waitForExit
requested foreground timeout
turn AbortSignal
foreground handoff budget
```

When the budget wins:

- the record becomes visible;
- polling and `waitForExit` continue in a detached owned finalizer;
- TaskOutput consumes bounded output from the same record;
- KillShell calls `terminal.kill()` and then `terminal.release()`;
- WriteStdin returns a typed unsupported result because the ACP terminal API
  does not expose stdin writes;
- Session/runtime shutdown kills and releases the terminal.

If the terminal exits before the budget, the existing ACP foreground result is
returned and the hidden record is removed.

## Timeout and Cancellation Semantics

Before handoff:

- requested Bash timeout kills and waits for the full process/terminal;
- turn cancellation kills and waits;
- timeout and cancellation preserve existing typed results;
- no task ID is exposed.

After handoff:

- the foreground timeout timer is cleared;
- the command lifetime is controlled by TaskOutput observation, KillShell,
  Session disposal, process shutdown, or natural exit;
- a later turn abort/discard does not kill it;
- shutdown remains bounded by the existing coordinated runtime barrier.

This matches the existing explicit-background lifetime and prevents a default
30-second foreground timeout from destroying a build that has already been
safely handed off.

## Result Contract

Automatic handoff returns:

```ts
{
  success: true,
  llmContent: {
    command,
    background: true,
    auto_backgrounded: true,
    background_reason: 'foreground_budget',
    foreground_budget_ms: number,
    pid?: number,
    bash_id: string,
    shell_id: string,
    terminal_transport: 'local' | 'acp'
  },
  metadata: {
    summary: string,
    background: true,
    auto_backgrounded: true,
    background_reason: 'foreground_budget',
    foreground_budget_ms: number,
    pid?: number,
    bash_id: string,
    shell_id: string,
    terminal_transport: 'local' | 'acp',
    sandboxed: boolean
  }
}
```

Capacity rejection returns:

```ts
{
  success: false,
  error: {
    type: 'resource_exhausted',
    code: 'background_shell_busy'
  },
  metadata: {
    background_shell_admission: {
      code: 'background_shell_busy',
      scope: 'session' | 'global',
      limit: number,
      retryable: true
    }
  }
}
```

## Surface Projection

### Headless

JSONL tool results preserve the typed metadata. Text mode prints that the
command is still running and includes the shell ID.

### TUI

The Bash card transitions from running to background without creating a second
tool card. The terminal result includes the task ID and remains queryable via
TaskOutput.

### Web

Live SSE and fresh Session load project the same background metadata. The tool
card shows `Running in background` and the shell ID. A later TaskOutput updates
the independent task result without rewriting the original Bash identity.

### ACP

The standard tool-call update reports completion of the Bash call with a
running background payload. The real ACP terminal remains owned by Blade until
exit, KillShell, or Session disposal.

## Deterministic Tests

The patch must cover:

- frozen foreground budget and background capacity constants;
- config validation, persistence, workspace isolation, and Session snapshot;
- fast local completion remains foreground;
- budget handoff keeps one PID and does not re-execute the command;
- foreground output produced before handoff remains in TaskOutput;
- post-handoff output appends in order under the existing byte bounds;
- foreground lease is replaced by one background lease without a gap;
- foreground timeout before budget kills the process tree;
- abort before budget kills the process tree;
- abort after handoff does not kill the process;
- Session dispose after handoff kills the process;
- `sleep` and read-only audit commands do not auto-background;
- process and Session background limits include hidden candidates;
- explicit background overflow fails before spawn;
- auto-handoff capacity exhaustion continues foreground without replay;
- local handoff preserves sandbox ownership and cleanup;
- ACP fast completion, handoff, completion, timeout, abort, KillShell, release,
  output regression, and stalled final read;
- ACP handoff never launches a local fallback process;
- WriteStdin remains supported locally and fails explicitly for ACP;
- Headless/TUI/Web/ACP metadata projection and strict sanitizer behavior;
- all timers, listeners, reservations, leases, records, terminals, and process
  trees clean up on every terminal path.

Static tests reject:

- a second command spawn during handoff;
- an unbounded active-background default;
- returning a task ID before ownership commit;
- releasing ACP terminal on successful handoff;
- using a test-only bypass in production runtime code.

## Real API Qualification

The release-blocking matrix runs:

```text
DeepSeek V4 Flash x Headless / ACP / raw PTY TUI / Web
DeepSeek V4 Pro   x Headless / ACP / raw PTY TUI / Web
```

Each cell:

1. starts one real Provider turn;
2. makes the model launch one canonical foreground Bash child with
   `run_in_background=false`;
3. waits for the child to cross a host-visible started barrier;
4. proves the Bash result returns `auto_backgrounded=true` before the child is
   released;
5. proves the original PID or ACP terminal child remains alive;
6. requires the model to perform an independent Read while the command runs;
7. releases the child;
8. requires one blocking TaskOutput call to observe its terminal marker;
9. produces one exact final marker;
10. reloads the durable Session where supported;
11. proves there was one command launch, one Bash call/result identity, no
    timeout, no duplicate side effect, and ordered output;
12. proves all leases, capacity reservations, processes, terminals, ports,
    browser pages/profiles, PTYs, SSE readers, temporary roots, and credentials
    are gone.

Web uses the production build and pinned Chromium. ACP uses the real stdio
Agent connection and a child-backed terminal. TUI uses a real raw PTY; Computer
Use remains optional because the raw PTY provides an automated release gate.

## Release Gate

- targeted deterministic tests pass;
- `bun run qualify:local` passes;
- `bun run qualify:production` passes all checks;
- the eight-cell real API matrix passes;
- `docs/testing/bounded-foreground-command-handoff-evidence.md` records exact
  counts, timings, retries, and cleanup evidence;
- package, lockfile, built CLI, npm artifact, GitHub tag, Release, docs, and CI
  all report `0.10.36`;
- feature worktree, branch, profiles, processes, and temporary roots are
  removed after release.
