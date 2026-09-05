# Provider Rate-Limit Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one authoritative `429 + Retry-After` response immediately establish a bounded, process-wide cooldown for the exact Provider failure domain, while preserving the existing TUI, Web, ACP, and Headless recovery contract.

**Architecture:** Extend the existing `ProviderCircuitRegistry` rather than adding another state store or public protocol. A qualifying regular failure becomes an immediate `opened` transition; all subsequent admission, half-open probe, generation, capacity, and presentation behavior continues through the current circuit and `provider.recovery` pipeline.

**Tech Stack:** TypeScript strict, pi-ai adapter, process-wide Provider circuit registry, TypeBox, React + Ink, React + Vite, Hono SSE, ACP SDK, Vitest, Playwright Chromium, `bun-pty`, real DeepSeek API.

---

## File Structure

- Modify `packages/cli/src/services/pi/providerCircuitBreaker.ts` — immediate authoritative rate-limit opening rule.
- Modify `packages/cli/tests/unit/services/provider-circuit-breaker.test.ts` — pure state-machine boundary tests.
- Modify `packages/cli/tests/unit/services/pi-ai-chat-service.test.ts` — retry orchestration and cross-service request suppression.
- Create `packages/cli/tests/integration/provider-rate-limit-cooldown.test.ts` — production-dist deterministic Headless/ACP/TUI/Web lifecycle with one shared failure domain.
- Create `packages/cli/tests/integration/real-api/provider-rate-limit-cooldown-trajectory.test.ts` — DeepSeek Flash/Pro real upstream recovery matrix.
- Create focused runner files under `packages/cli/tests/support/` only when a production ACP or raw-PTY child cannot reuse an existing bounded runner.
- Modify `packages/cli/scripts/test-config.js` and `packages/cli/tests/unit/scripts/qualification.test.ts` — release-blocking registration and source contracts.
- Modify bilingual Provider recovery reference, qualification, evidence, sidebar/changelog files, and `packages/cli/package.json` for the independent patch release.

### Task 1: Prove and implement immediate circuit opening

- [ ] Add a reducer test where the first regular failure is `{ reason: 'rate_limit', statusCode: 429, retryAfterMs: 45_000 }`; require `phase: 'opened'`, one sample, one failure, and a 45-second boundary.
- [ ] Add negative cases for missing, zero, negative, non-finite, and over-limit directives, plus `rate_limit` without status 429; require the existing minimum-sample threshold.
- [ ] Run `bunx vitest run --config vitest.config.ts --project=unit tests/unit/services/provider-circuit-breaker.test.ts` and preserve the RED result.
- [ ] In `ProviderCircuitRegistry.#record`, after recording the sanitized failure sample and before threshold evaluation, call the existing `#open` only for status 429 with a positive sanitized retry directive. Do not add public fields or another registry.
- [ ] Rerun the focused test, `bun run type-check`, Biome, and `git diff --check`; commit as `feat(runtime): honor provider rate-limit cooldowns`.

### Task 2: Verify retry orchestration and cross-Session suppression

- [ ] Add a `PiAIChatService` test with two service instances sharing one registry and failure domain. The first physical stream returns 429 with Retry-After; the second stream must receive circuit rejection/waiting without invoking `streamPiModel`.
- [ ] Advance the monotonic clock to expiry and call both services in the same tick; require exactly one probe and one blocked caller.
- [ ] Prove the initiating foreground turn uses `max(retryDelay, circuitDelay)` once, remains within its recovery deadline, and closes the circuit after probe success.
- [ ] Prove `shouldRetry=false`, quota/billing classification, and a 429 without a positive directive do not create immediate shared cooldown.
- [ ] Run the two focused service suites and commit as `test(runtime): cover shared rate-limit cooldown`.

### Task 3: Qualify existing protocol and user surfaces deterministically

- [ ] Add a production fixture that returns one `429` with a short `Retry-After`, records every request, then forwards a deterministic tool lifecycle after the cooldown.
- [ ] Assert Headless JSONL emits bounded `provider_circuit`/`provider_recovery` waiting state, then activity/tool progress and terminal clears without response body or credentials.
- [ ] Assert real ACP stdio emits the same lifecycle through `blade/providerRecovery` and existing `blade/turnActivity`, with monotonic deduplicated revisions.
- [ ] Assert raw PTY displays the rate-limit countdown, then resumes to active tool progress and the exact final marker.
- [ ] Assert production Chromium Web displays the accessible recovery banner, survives reload during cooldown, proceeds to activity after release, and clears both surfaces at terminal state.
- [ ] Start a second same-domain Session during cooldown and require zero additional proxy traffic before the first half-open probe.
- [ ] Build once, run the deterministic suite three consecutive times, run the qualification contract, and commit as `test(runtime): qualify shared rate-limit cooldown`.

### Task 4: Run the real Provider matrix

- [ ] Register a DeepSeek Flash/Pro × Headless/ACP/raw PTY/Web matrix with framework retry `0` and model `maxRetries=0`.
- [ ] For each cell, inject one `429 + Retry-After` before forwarding to the real Provider; hold a same-domain secondary Session through the cooldown and prove it creates no early upstream request.
- [ ] Require one half-open probe, exact Bash execution, exact final artifact, terminal clear, bounded cleanup, and absence of credentials/private response data.
- [ ] Run the full `8/8` matrix from current production `dist`, retain only bounded structural evidence, and commit as `test(runtime): verify rate-limit cooldown with real APIs`.

### Task 5: Document, audit, and release

- [ ] Update `docs/reference/model-transport-recovery.md` and its English counterpart with the authoritative 429 rule, scope, expiry, fallback, and non-goals.
- [ ] Add bilingual qualification evidence with exact candidate SHA, commands, model/surface cells, request counts, cleanup, privacy scans, failures, and rerun facts.
- [ ] Run `bun run build`, `bun run type-check`, `bun run lint`, `bun run test:all`, `bun run test:coverage`, `bun run test:web`, and `git diff --check`. Record failures truthfully and rerun unchanged intermittent tests exactly.
- [ ] Audit the original objective against Runtime ownership, stability, performance bounds, long-task continuation, TUI, Web GUI, ACP, Headless, real APIs, and the no-worktree constraint. Scan the patch for `any`, unsafe casts, suppressions, secrets, placeholders, generated changelog edits, and unbounded retained state.
- [ ] Bump one patch version, update `CHANGELOG.md` and `CHANGELOG.zh.md`, commit, create an annotated tag, push `main` and the tag, wait for `publish.yml`, and verify `npm view blade-code version`.

## Self-review

- Every design requirement maps to a task: immediate 429 opening (Task 1), same-domain suppression and probe ownership (Task 2), four-surface compatibility and reload (Task 3), real APIs (Task 4), privacy/docs/release (Task 5).
- No new account API, CTA contract, persistence format, fallback policy, or second UI state machine is introduced.
- `retryAfterMs`, `nextProbeAt`, `provider.circuit`, `provider.recovery`, and existing generation/revision names stay consistent across all tasks.
- The plan contains no deferred implementation placeholders.
