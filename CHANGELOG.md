# Changelog

All notable user-facing changes will be documented in this file.

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
