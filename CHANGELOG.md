# Changelog

All notable user-facing changes will be documented in this file.

## 0.6.0-alpha.5 - 2026-05-15

Public-preview surface polish + internal hygiene pass.

- README now leads with the actual differentiator: the orchestrator is a
  real CLI agent (claude / codex / opencode / gemini), not a human PM and
  not a script. Both English and Simplified Chinese versions updated.
- README gained a CI build-status badge and a "Try the demo first"
  section that surfaces the fully-client-side demo flow (shipped in
  alpha.1 but previously invisible to anyone who had not booted Hive).
- Bug-report and feature-request issue templates plus `CONTRIBUTING.md`
  landed; GitHub Community Standards checklist is now green. A
  `docs/growth-roadmap.md` working doc was added to track the
  positioning, brand, and protocol roadmap.
- Todo drawer rebuilt around the actual task it does: owner-colour
  pills, hover-revealed actions (edit / add subtask / delete), inline
  editing with `\n` sanitisation, optimistic UI with rollback, and a
  compact progress header.
- WorkerModal now opens at 50% of viewport width on first launch. Worker
  cards dropped the queued-count pill and the stale `useWorkspaceStats`
  hook was removed as dead code.
- IME composition for CJK terminal input no longer swallows characters.
  xterm.js gained `Unicode11Addon`, `WebglAddon`, `ClipboardAddon`, and
  `WebLinksAddon` alongside `FitAddon`.
- `team report` parser rewritten: any-order flags, errors embed the full
  usage block. Added `--stdin` for piping bodies past shell argument
  limits; `team status --stdin` covered the same way.
- `last_output_line` renamed to `last_pty_line` on the `team list`
  payload. Orchestrator system instructions now treat the field as PTY
  noise (never a worker reply) and are CLI-agnostic instead of
  Claude-Code-specific.
- All ten runtime store factories now require a real `Database`. The
  `if (!db)` in-memory fallback branches and their Map / Set / counter
  scaffolding were dead code carried only for tests that omitted
  `dataDir`; they are gone (~ 260 LOC removed). `openRuntimeDatabase`
  falls back to a `:memory:` SQLite engine when no `dataDir` is supplied
  so tests still exercise real schema.
- `MessageLogHandle.kind: 'db' | 'memory'` removed — the handle is now
  just `{ sequence: number }`. The empty `initialize` no-ops on the
  agent-run and message-log stores, their port slots, and the
  `markUnfinishedRunsStale?.` optional chaining are also gone. Six
  previously-failing `terminal-view.test.tsx` cases now pass with a
  one-line `unicode` stub addition on the four web-test Terminal mocks.

## 0.6.0-alpha.4 - 2026-05-15

Update-awareness pass for public-preview installs.

- Hive now checks npm for the latest published version through a cached
  `/api/version` endpoint.
- The CLI prints a non-blocking update hint after startup when a newer npm
  version is available.
- The app topbar surfaces the same update availability and install command in
  the UI.
- The workspace shell was split into smaller app-level components so future
  UI changes do not push `web/src/app.tsx` past its size budget.

## 0.6.0-alpha.3 - 2026-05-14

Runtime and team-protocol hardening after public-preview dogfooding.

- Added `team status` for worker check-ins when there is no open dispatch.
  `team report` now requires an open dispatch and returns 409 otherwise, so
  standby/status updates no longer accidentally close or pollute task history.
- Custom workspace startup commands can still run through the user's shell
  while retaining the selected preset's interactive behavior and session-id
  capture metadata. This supports alias-based resume commands without losing
  Hive's CLI-specific terminal handling.
- Worker and orchestrator startup instructions now distinguish assigned work
  (`team report`) from no-dispatch status updates (`team status`).
- OpenCode no longer receives Claude's `--dangerously-skip-permissions` flag;
  its permissions are documented as config-driven through `opencode.json`.
- Add Worker now avoids unavailable CLI presets by default and surfaces
  backend creation errors instead of collapsing them into generic UI failure.
- Local runtime endpoints now reject non-local Host/Origin requests and cap
  JSON request bodies at 1 MiB.
- Workspace creation validates local paths more defensively, and README /
  SECURITY / release notes were updated for the current npm release path.

## 0.6.0-alpha.2 - 2026-05-14

Follow-up to alpha.1 — corrects a handful of inconsistencies and tightens the
runtime-down experience that was deferred from the alpha.1 review.

- Removed the OrchestratorHintOverlay introduced in alpha.1. The hint card on
  the Orchestrator pane was judged as unnecessary; agent terminals are now
  back to a clean full-bleed PTY.
- Runtime-down handling is no longer half-finished: when the local Hive
  runtime is unreachable on startup, the WelcomePane "Add your first
  workspace" CTA is disabled with an explicit footnote, and `createWorkspace`
  failures now surface as an error toast instead of being swallowed.
- npm releases are now published with `--provenance`, matching the prior
  claim in README/CHANGELOG. The alpha.0 / alpha.1 tarballs do not have
  provenance attestations; alpha.2 is the first release that actually does.
- Toast ids no longer use `Math.random()` (AGENTS.md §6); switched to a
  module-level monotonic counter — `crypto.randomUUID` was the previous
  fallback but a future LAN deployment would not have a secure context.
- README and SECURITY no longer pin a specific version number in the public
  preview banner — the npm badge now carries that responsibility.
- Windows is documented as Tier 2 (CI smoke + manual verification before
  release) rather than Tier 1; the previous wording oversold what the CI
  matrix actually covers.

## 0.6.0-alpha.1 - 2026-05-14

UI onboarding revamp. Three audits (visual / UX / competitive) called the
first-run state too sparse to ship publicly; this release answers all of them
in one batch.

- Empty main area now renders a WelcomePane with a 3-step guide and a primary
  CTA, replacing the previous black null branch in WorkspaceDetail.
- Sidebar EmptyState absorbs the New workspace CTA so the call-to-action sits
  in the eye-flow center; the bottom dashed Add Workspace button still appears
  once the list is non-empty.
- Topbar drops the hardcoded `v0.1` and reads the real package version. The
  Blueprint and Notifications actions hide while no workspace is active.
- Cards lose the `translateY(-1px)` hover lift. Role badges now blend the
  status color into the surface with `color-mix(in oklab, ... 22%, var(--bg-2))`
  so they ride the token system instead of hardcoded hex.
- Runtime-down on first load surfaces an explicit error toast instead of
  falling through to "No workspaces."
- Orchestrator pane shows a Cursor-style hint overlay on the first run; any
  keystroke or the explicit Dismiss button removes it.
- Worker cards expose the last terminal output line for working workers,
  backed by a new `last_output_line` field on the team list payload and a new
  per-run `worker-output-tracker` on the runtime.
- New Try Demo flow renders a fully client-side demo workspace (fake
  orchestrator + two workers, prerecorded scrollback, prefilled tasks
  checklist). The demo never touches the server.
- New first-run wizard auto-opens once per browser via a localStorage flag and
  routes users into Add Workspace, Try Demo, or Skip.
- Server: duplicate-start guard in `agent-runtime.startAgent` reuses the
  active run rather than spawning a second PTY when the orchestrator autostart
  collides with a manual start.
- App refactor: split into `AppProviders` + `AppInner`, extracted
  `useFirstRunWizard`, `useEffectiveWorkspaceState`, and
  `WorkspaceTaskDrawer` so `web/src/app.tsx` stays under the 150-line hard
  cap.

## 0.6.0-alpha.0 - 2026-05-13

- Prepared Hive for public preview package distribution.
- Added Apache-2.0 licensing metadata and repository support documents.
- Documented supported platforms, supported CLI presets, first-run flow, safety
  model, and troubleshooting guidance.
- Added package smoke validation for packaged runtime startup.
