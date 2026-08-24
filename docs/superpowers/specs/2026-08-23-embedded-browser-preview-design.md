# Embedded Browser Preview Design

## Objective

Add a user-controlled browser to the existing right-side Preview surface. The
browser must support local development workflows without changing the Agent
Runtime contract or granting the Agent new browser-control capabilities.

## Reference Findings

- Claude Code separates its user-facing browser surface from Agent browser
  automation. Its Chrome integration is an explicit MCP capability with
  site-level permissions.
- Codex exposes separate `in_app_browser`, `browser_use`, and external-browser
  controls. URL entry points validate schemes and credentials before opening.
- Grok Build treats browser verification as an end-to-end requirement and
  checks behavior, shared state, edge states, desktop, and mobile layouts.
- Neovate Code has a browser-hosted UI but no reusable embedded browser pane in
  the inspected source.

Blade should preserve that separation. This slice adds an in-app viewing
surface. Agent-driven browser automation remains a separate future capability
with its own permission, isolation, and audit model.

## User Experience

The existing Preview panel gains a fourth `Browser` tab.

The browser toolbar provides:

- back and forward navigation;
- reload;
- an editable URL field;
- explicit navigation;
- opening the current URL in the system browser.

The initial field contains `http://localhost:3000`, but no network request is
made until the user submits it. This makes the common local-development target
concrete without creating background traffic.

The page area reports idle, loading, ready, and failed states. Switching Preview
tabs preserves browser navigation state while the panel remains mounted.

## State And Bounds

Browser history is owned by `BrowserPreview` and capped at 50 entries. A new
navigation drops the forward branch. Reopening the Preview panel starts a fresh
browser surface, matching the existing ephemeral file-selection behavior.

`AppStore.PreviewTab` adds `browser` so existing callers can open the tab through
the same `openFilePreview` contract.

## URL Boundary

Only `http:` and `https:` URLs are accepted.

- `localhost`, loopback addresses, private-network hosts, and bare host/port
  pairs default to HTTP when the scheme is omitted.
- Other bare hosts default to HTTPS.
- Embedded credentials are rejected.
- The exact Blade Web origin is rejected to prevent a same-origin recursive
  frame from inheriting access to the host application.
- Invalid or oversized input never replaces the currently loaded page.

The iframe uses:

- `sandbox` without top-navigation permission;
- `referrerPolicy="no-referrer"`;
- no backend fetch proxy;
- no transfer of Blade credentials, Session state, or request headers.

Some sites deny framing through `X-Frame-Options` or CSP. The toolbar's external
open action is the supported fallback; Blade must not strip or proxy those
headers.

## Accessibility And Responsive Behavior

- Every icon button has an accessible name and tooltip.
- The URL field has an explicit accessible label.
- Status changes use a polite live region; errors use `role="alert"`.
- Existing Preview dialog focus containment remains authoritative on compact
  viewports.
- The toolbar has stable dimensions and permits the URL field to shrink without
  overlapping controls.

## Verification

Deterministic tests cover:

- URL normalization and rejection;
- bounded history and forward-branch replacement;
- back, forward, reload, submit, load, and error states;
- safe external opening;
- Preview tab integration.

Production Chromium verification covers:

- a real DeepSeek Session response in the same Web UI;
- loading two local fixture pages in the embedded frame;
- back, forward, reload, and external-open behavior;
- desktop and mobile panel bounds;
- zero unexpected console, page, and request failures;
- browser, server, port, and temporary-root cleanup.
