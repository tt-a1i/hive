# Changelog

All notable user-facing changes will be documented in this file.

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
