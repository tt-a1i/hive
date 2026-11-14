# Changelog

All notable user-facing changes will be documented in this file.

## 3.0.0 - 2026-11-14

A smaller desktop team workbench with CLI switching and quieter collaboration.

### Breaking changes

- Remove Codex App external control, Hive MCP servers and Supervisor goal commands.
  Run the Orchestrator as a CLI inside Hive; Codex CLI remains supported.
- Remove Team Memory, Dream, their commands and UI. Keep `team recall` for message
  and report history. Schema v46 deletes retired controller and memory tables;
  v47 refreshes unchanged built-in Orchestrator templates and preserves customized text.
- Stop Hive and its agents gracefully, then back up the entire Hive data directory
  before the first launch after upgrading. Restoring removed data requires the
  complete pre-upgrade backup and the matching older executable. See
  [upgrade steps](docs/release.md#upgrading-to-300).

### Added and improved

- Switch an existing Orchestrator or member to another CLI from the desktop UI.
  Preserve open responsibilities and temporary members, clear the previous engine's
  session binding, and hand current ledger context to the replacement.
- Ask blocking questions with `team ask`, receive the answer as text, and resume saved
  questions after a timeout or interruption. Start configured stopped members on demand.
- Send short messages inline, keep long, multiline or control-bearing messages in
  private inbox files, and combine nearby reports. Reduce repeated role instructions
  and omit unnecessary zero-watermark reminders.
- Keep idle native session resumes silent. When work remains, synchronize current
  responsibilities, pending questions, role instructions, task summaries and members.
- Improve terminal paste submission after large output, stopped-process cleanup,
  workspace switching, acknowledgement flow control and hidden WebGL resource use.
- Strengthen local HTTP/WebSocket origin checks, JSON request validation and private
  data-file permissions. Remove the gateway's production test-header override.
- Include Kimi Code CLI support and Windows terminal scrolling fixes merged since 2.2.1.

## 2.2.1 - 2026-09-08

Task-focused collaboration guidance and reliable role instructions.

- Share task selection and acceptance principles across startup, recovery and
  external controllers, considering coordination effort and user-selected resources.
- Read current workspace guidance on demand through `team guide` and the
  external controller guide; distinguish offline references from live capabilities.
- Clarify questions, progress, acknowledgements and final reports, with corrected
  reply routing for ordinary and recovered task messages.
- Preserve custom workflow role descriptions in the actual member startup prompt.
- Include installation fixes for fresh npm installs with lifecycle scripts disabled.

## 2.2.0 - 2026-09-06

Task conversations and consistent coordination across Hive and Codex App.

- Keep questions, answers and additional requirements attached to the original task;
  link review and follow-up work without losing report history.
- Use existing members and their configured CLI/model choices, with shared
  coordination rules for the built-in Orchestrator and Codex App controller.
- Restore open responsibilities and new inputs from the task ledger; require
  reports to explicitly account for the messages received.
- Connect a Codex App conversation as a workspace controller, with confirmation,
  persistent result receipts and identifiable delayed notifications.
- Show task discussions and related work in Action Center; distinguish submitted
  reports from accepted outcomes.
- Improve npm 12 native dependency installation and package verification.

Existing databases migrate automatically. Back up your Hive data before upgrading;
rollback requires the pre-upgrade database backup and matching older binary.

## 2.1.19 - 2026-07-22

Terminal restore reliability, clearer report delivery, and a larger agent marketplace.

- Restores SGR mouse encoding with terminal snapshots, preventing mouse movement
  and wheel input from appearing as raw characters after reconnecting or opening
  a restored terminal, including on Windows remote sessions.
- Keeps `team report` delivery status accurate until the Orchestrator PTY write
  settles, with clearer sanitized diagnostics when queued delivery cannot drain.
- Expands and refreshes the bundled English and Chinese agent marketplace across
  engineering, security, GIS, operations, marketing, and other specialist roles.

## 2.1.18 - 2026-07-12

Workspace polish, broader member names, and more reliable Dream runs.

- Refreshes the workspace sidebar, team member cards, task drawer, and Memory
  drawer for clearer hierarchy and better compact/mobile layouts.
- Draws generated member names from one shared 1,111-name bank across roles,
  languages, Add Member, and scenario presets.
- Runs scheduled Dream maintenance with the workspace Orchestrator's configured
  Claude or Codex CLI and preset environment instead of assuming Claude.
- Improves scheduled Dream command resolution and timeout cleanup on Windows,
  including npm command shims and child process trees.

## 2.1.17 - 2026-07-08

Team role cleanup and quieter dispatches.

- Removes the retired Sentinel patrol role from team-member creation, role
  templates, prompts, random names, icons, and settings surfaces.
- Cleans stale Sentinel templates and workers from existing local databases on
  upgrade, including related dispatch/report/session records.
- Keeps Reviewer, Coder, Tester, and Custom as the supported worker roles.
- Stops asking workers to send an immediate "accepted dispatch" status for
  every task; members now start work directly and report when done, blocked,
  failed, or partially complete.

## 2.1.16 - 2026-07-08

Codex resume context reliability.

- Preserves a Codex worker's saved conversation pointer when a resumed start
  exits because of a temporary CLI, configuration, or resource failure and the
  underlying Codex session still exists.
- Treats matching but temporarily unreadable Codex session files as
  unverifiable instead of clearing the saved session too aggressively.
- Clears truly stale or missing saved Codex session pointers after a failed
  resume, so Hive can start fresh instead of repeatedly retrying a broken
  session id.
- Uses one shared session-existence path for supported native session stores,
  keeping resume cleanup behavior consistent across CLI presets.

## 2.1.15 - 2026-07-02

Worker avatars, terminal rendering reliability, and clearer team report delivery.

- Adds custom worker avatars, including upload, crop, validation, persistence,
  and display across the team UI.
- Keeps worker avatars out of CLI team-list responses while still showing them
  in the browser workspace.
- Improves terminal rendering under heavy output and reconnect/restore flows,
  reducing stale or duplicated terminal frames.
- Tightens Dream memory consolidation instructions so procedure references are
  only used for real saved workflows, skills, procedures, templates, or docs.
- Makes `team report` delivery wording more accurate when Hive accepts a report
  and durable Orchestrator delivery is still in progress.
- Adjusts Orchestrator guidance so accepted dispatches are usually left alone
  until a member reports, reducing premature status checks or cancels.

## 2.1.14 - 2026-06-25

Terminal focus and Dream memory reliability.

- Focuses the active Orchestrator terminal automatically when you return to
  the Hive browser tab, so you can resume typing without clicking the terminal
  first.
- Focuses a member terminal automatically when you open the member panel, while
  preserving focus in normal text fields and leaving workspace shell terminals
  alone.
- Tightens Dream memory consolidation instructions so ordinary workflow advice
  is saved as normal memory instead of being misclassified as a procedure
  reference without the required structured reference.

## 2.1.12 - 2026-06-25

Default port and Pi agent support.

- Changes Hive's default local runtime port from `3000` to `9483`, reducing
  collisions with common local development services while keeping `--port 0`
  available for OS-assigned ports.
- Updates the local Supervisor MCP adapter and Vite dev proxy to follow the
  same default port.
- Adds Pi as a built-in agent preset with `pi --approve`, including workflow
  CLI policy support, prompt-readiness handling, and migration support for
  existing Hive databases.

## 2.1.11 - 2026-06-25

Supervisor MCP bridge and terminal input polish.

- Adds a local Supervisor MCP adapter so external agents such as Codex App,
  Claude, or Hermes can hand a goal to the Hive Orchestrator and wait on
  durable structured goal events.
- Adds `team goal report` for Orchestrators to report external goal progress,
  completion, blocked states, or failures without giving external supervisors
  direct member or PTY control.
- Keeps the Supervisor MCP surface intentionally narrow: list/inspect
  workspaces, start/wait/continue/cancel goals, with no direct member spawn,
  member send, raw scrollback, or PTY write tools.
- Improves OpenCode prompt readiness detection for completed turns and
  interrupt-status screens, making post-start input delivery more reliable.
- Preserves Codex prompt edit repaint frames after Backspace/Delete-style input,
  so terminal editing stays visually in sync.

## 2.1.10 - 2026-06-23

Scenario teams and terminal delivery polish.

- Starts members created from one-click scenarios immediately, so the team is
  ready for the Orchestrator to assign work instead of sitting stopped.
- Uses the shared member-name pool for scenario-created members, matching the
  Add Member dialog and avoiding generated stem-only names.
- Improves OpenCode dispatch delivery after startup by recognizing its completed
  turn footer as a ready signal, while waiting briefly for the terminal output
  to settle before injecting the next dispatch.
- Adds an explicit accepted-dispatch status instruction to member tasks, making
  it easier to see that a member received a dispatch before it starts working.
- Keeps optimistic terminal panels tied to real run lifecycle events and
  preserves Codex cursor-position repaint frames, improving terminal display
  during editing and fast start/stop flows.

## 2.1.9 - 2026-06-23

Lean Hive guidance and desktop terminal polish.

- Replaces the large Orchestrator startup instruction block with a shorter
  core prompt that points agents to focused `team guide` topics for dispatch,
  task tracking, memory, workflow, and member rules.
- Adds `team guide <topic>` so agents can read the relevant Hive runtime
  protocol slice on demand, backed by the generated workspace protocol when
  available.
- Standardizes user-facing collaboration language around Hive **members**
  instead of "workers", matching the UI and product model.
- Includes the Codex terminal input repaint fix for Chinese/CJK backspace and
  the cleaner desktop member-window outside-click close behavior.

## 2.1.8 - 2026-06-23

Codex terminal editing and member-window polish.

- Fixes Codex terminal input repainting for Chinese/CJK text so pressing
  backspace updates the visible input line immediately instead of leaving stale
  characters on screen.
- Removes the visible desktop member-window close button from the terminal
  corner and adds an outside-click close hint, giving the terminal more clean
  space while keeping mobile's full-screen close affordance.

## 2.1.7 - 2026-06-23

Team delivery recovery and remote-access hardening.

- Makes worker reports durable when the Orchestrator is offline or restarting,
  so completed work is queued for redelivery instead of being silently lost.
- Tightens cancel, worker-dismiss, and queued-dispatch recovery paths so stale
  work gets a clear dropped/cancelled outcome instead of leaving agents waiting.
- Makes user input delivery truthful: if the Orchestrator terminal is offline,
  Hive rejects the input instead of recording a message that was never sent.
- Standardizes remote-access HTTP responses on snake_case fields and keeps the
  web UI mapping them back into its internal camelCase model.
- Blocks remote devices from reading or approving desktop-only pairing
  approvals through the tunnel, while preserving normal equal-authority device
  management routes.

## 2.1.6 - 2026-06-21

Team UX polish and release visibility.

- Adds a global package-update prompt so running Hive can surface a newer npm
  version without relying only on the topbar badge.
- Makes worker startup handshakes explicit: newly started members now report a
  ready status back to the Orchestrator after receiving Hive's injected startup
  instructions, making failed starts easier to distinguish from idle workers.
- Removes the Orchestrator pane stop button from the UI so users cannot
  accidentally close the central coordinator from the pane chrome.
- Reworks the Action Center entry into a dedicated drawer with live workspace
  health, attention, recent activity, and worker selection instead of the old
  compact popover.

## 2.1.5 - 2026-06-21

Ambient memory reliability and background consolidation.

- Makes team memory quieter and more automatic by removing the visible
  candidate-review surface from the Memory drawer while keeping active,
  archived, and Dream audit history available when you look for it.
- Adds user-scoped memory for lightweight personal preferences and working
  style, without mixing those preferences into workspace project facts.
- Adds structured procedure references so workflows, skills, and checklists can
  be recalled as short references instead of long copied instructions.
- Improves dispatch memory retrieval so unrelated worker-role matches do not
  inject stale or cross-task memory into a new assignment.
- Moves scheduled Dream consolidation into a background apply path with
  transaction checks, source-window validation, failure isolation, and revert.

## 2.1.4 - 2026-06-21

Quieter onboarding and team activity signals.

- Simplifies the first workspace experience so Hive no longer pushes an
  Orchestrator dispatch prompt before the user has a concrete task.
- Removes the noisy dispatch pulse and queue-count badges from the team UI,
  keeping attention on active work, reports, and terminal state.
- Cleans up the empty-workspace sidebar so collapsed mode no longer shows a
  stray compact add button.
- Updates release verification so normal patch releases use the package-focused
  fast gate, while the full test gate remains available for high-risk releases.

## 2.1.3 - 2026-06-18

Issue backlog polish for onboarding, dispatch, demo, and release readiness.

- Holds Hive startup instruction injection while first-run CLI setup prompts are
  visible, avoiding collisions with trust/login/confirmation onboarding screens.
- Adds a first-dispatch guide on the Orchestrator pane for non-scenario flows,
  and makes user-input delivery truthful when the Orchestrator PTY is offline.
- Adds language-aware built-in role contracts and scenario/spawn defaults so
  English workspaces no longer receive zh-only worker prompts.
- Replaces the external demo video with a local self-running Hive replay that
  shows task progress, worker states, and team dispatch flow.
- Adds a local CLI compatibility report for native modules and Tier-1 agent
  CLIs, wired into release verification.
- Surfaces local-only retention diagnostics in Settings and adds candidate
  memory review controls to the Memory drawer.
- Re-verifies the existing `team recall` route, CLI, and remote relay path.

## 2.1.2 - 2026-06-16

Spawned-worker dispatch reliability.

- Fixes `team spawn` followed by `team send`: newly spawned workers now wake for
  their first task instead of leaving the dispatch parked in the stopped queue.
- Keeps stopped-worker semantics intact after that first run: if a spawned
  worker is later stopped manually, new sends stay queued until the worker is
  started again.
- Makes Windows Claude Code sessions more tolerant of large Hive startup and
  dispatch injections, reducing premature submit/input residue during agent
  startup.

## 2.1.1 - 2026-06-14

Codex terminal input polish and Action Center mobile refinements.

- Makes Codex terminal input smoother and more reliable during pasted or
  programmatically injected prompts.
- Polishes the Action Center layout and interaction details, especially on
  narrower and mobile-sized screens.

## 2.1.0 - 2026-06-13

One-click team assembly, visible memory consolidation, and remote/dispatch reliability.

- Adds **one-click scenario team assembly** — start a ready-made team from a
  preset instead of adding members one at a time, with guiding empty-state cards
  when a workspace has no team yet.
- Reworks team-memory **Dream consolidation** to run through your Orchestrator
  instead of a hidden background CLI pass: maintenance is injected as a visible
  task (`team memory dream show` / `team memory apply`), workers may be asked to
  review proposed changes read-only, and only the Orchestrator commits them.
  Every run keeps a diff report and a one-step revert.
- Adds a one-click, copyable **team recap** and a diagnostics support bundle to
  the Action Center for faster sharing and troubleshooting.
- Adds a **dispatch pulse** animation so `team send` visibly flows from the
  Orchestrator to the receiving worker.
- Guides you to install any missing CLI directly from the add-workspace dialog
  before you start a team.
- Makes dispatching more reliable: queued tasks replay when a worker starts,
  delivery failures notify the issuer instead of being lost, and `team list`
  now exposes open dispatches.
- Adds local per-day retention signals (protocol event counters) for workspace
  activity.
- Fixes remote/mobile reliability: large uploads over the tunnel are chunked
  under the relay message cap, and terminal scrolling is restored for CLIs
  launched through wrapped or legacy commands (for example Codex on Windows).
- Hardens prompts and the workflow runtime against prompt-injection, and
  polishes protocol error messages, onboarding, and `team spawn` role/CLI
  handling.

## 2.0.2 - 2026-06-10

Windows Codex terminal scrolling fix.

- Fixes Codex terminal scrolling for Windows installs whose saved launch
  command still points at `node.exe ...\@openai\codex\bin\codex.js`, so Hive
  now applies the Codex-specific wheel/PageUp/PageDown input profile instead of
  treating the session like a plain shell.

## 2.0.1 - 2026-06-09

Team memory, worker-card polish, and release-channel cleanup.

- Adds ambient team memory so Hive can retain useful workspace context and
  surface it again when you need the team to remember prior decisions,
  constraints, or project notes.
- Refines the Memory and Workflows drawers with better desktop/mobile layouts,
  clearer tabs, and a search field that stays out of the way on wide screens.
- Redesigns worker cards for stronger scanability: clearer status treatment,
  higher contrast, cleaner role text, and an in-place rename flow instead of a
  separate edit dialog.
- Clarifies pending dispatch status so queued or waiting worker activity is
  easier to understand while the Orchestrator is coordinating work.
- Publishes the current remote/mobile build under the original official
  `@tt-a1i/hive` package name.

## 2.0.0 - 2026-06-07

Remote access, mobile control, and the production gateway.

- Adds optional Remote access so you can open your running Hive from a phone
  browser. Remote is off by default; when enabled, the phone connects through
  an end-to-end encrypted tunnel and gets the same authority as the local
  desktop browser.
- Ships the Cloudflare Workers gateway stack for identity and routing: GitHub
  and Google sign-in, Durable Object relay, D1-backed daemon/device records,
  rate limiting, version-pinned mobile bundles, and deployment runbooks for
  self-hosting or pointing Hive at an existing gateway.
- Adds the desktop trust-root pairing flow. The desktop creates a short-lived
  pairing code, the phone enters it after selecting the machine, both sides
  show a 6-digit SAS code, and the device is stored only after desktop
  confirmation.
- Adds remote device management: list paired devices, revoke them from
  Settings or the CLI, drop live sessions immediately from the Settings panel,
  and review an audit trail of remote requests and denials.
- Adds `hive remote login`, `status`, `logout`, `devices`, and `revoke` for
  linking the machine to a gateway account and managing paired devices from
  the host itself.
- Adds the mobile Hive shell: sign-in/connect screens, machine list, bottom
  navigation, workspace switching, full-screen team/task panels, and
  remote-aware reconnect and update prompts.
- Makes phone terminals writable through the terminal itself. Worker terminals
  can be opened full-screen, mobile focus mode hides surrounding chrome while
  you work, and terminal touch scrolling now tracks the finger more closely
  with smoother normal-buffer glide and faster alternate-screen movement.
- Preserves local-first behavior: local `127.0.0.1` Hive keeps working without
  a gateway, remote access is path-whitelisted to Hive's own `/api/*` and
  `/ws/*`, and paired phones cannot approve new devices or turn Remote access
  back on after it has been disabled.

## 1.7.0 - 2026-06-05

Hermes joins the roster.

- Adds Hermes as a fifth built-in CLI agent preset alongside Claude Code,
  Codex, OpenCode, and Gemini: available as an Orchestrator or Worker, in
  `team spawn --cli hermes`, and in the workflow CLI allowlist.
- Hermes runs YOLO via `--yolo` and resumes sessions via
  `--resume <session_id>`; crash recovery (Layer A) captures its session id
  from the CLI's own startup output through a new stdout-based capture
  source.
- Existing installs pick the preset up automatically via a database
  migration — no manual setup beyond having `hermes` on your PATH.

## 1.6.0 - 2026-06-02

Orchestrator controls, worker visibility, and protocol-trust fixes.

- Adds a Stop control to the running Orchestrator pane so a runaway Orchestrator
  can be halted from the UI (the default is auto-approve, so this is the only
  in-UI kill switch).
- Surfaces per-worker queue depth and a latest-activity line on worker cards,
  with a legend on the working badge clarifying that Hive does not auto-detect
  stalls — the terminal is the source of truth.
- Redelivers worker reports the Orchestrator missed: a report is no longer
  silently lost when the Orchestrator is down or restarting; it is queued and
  redelivered on the next report or `team list`.
- Stops injecting the crash-recovery handover after a deliberate Stop and
  Restart, so the Orchestrator is not handed stale open tasks it was meant to
  drop.
- Adds an outbound completion webhook setting: Hive POSTs a small JSON payload
  to a URL you choose when a worker reports or a workflow finishes — wire it to
  Slack, ntfy, Feishu, and the like.
- Adds opt-in structured output to workflow `agent()` via `outputSchema`, so
  fan-out/verify scripts receive a parsed object instead of parsing free text.
- Adds `team next`: tasks in `.hive/tasks.md` can carry an optional
  `[needs: #2]` dependency, and `team next` returns the tasks that are unblocked
  now.

## 1.5.0 - 2026-05-31

Workflow runtime, experimental team automation, and Codex reliability.

- Adds the experimental Hive workflow runtime: Orchestrators can author
  multi-agent workflow scripts that fan out across real Hive PTY workers, show
  runs in the Workflows drawer, stop runs, inspect run details, schedule
  recurring workflows, and route workflow reports back into the Orchestrator.
- Adds workflow agent CLI policy settings so users can choose which CLI
  workflow-created agents use by default and which CLIs are allowed.
- Adds the experimental auto-staff setting, letting the Orchestrator size the
  worker roster to the task and prefer task-scoped ephemeral workers when it
  needs temporary coders, testers, or reviewers.
- Adds an in-app What's New dialog so future upgrades can surface curated
  release highlights without requiring users to read the changelog manually.
- Improves Codex reliability by waiting for pasted-content acknowledgements on
  long dispatches while submitting short report/status injections quickly,
  avoiding the several-second delay before reports reach the Orchestrator.
- Hardens Windows and runtime edge cases, including malformed WebSocket frames,
  stale nvm4w Codex node entrypoints, workflow worker exits, and additional
  workflow/runtime cleanup paths.

## 1.4.4 - 2026-05-29

Windows portability and team protocol hardening.

- Fixes Windows `.cmd` / `.bat` launch handling for built-in and custom startup
  commands, including quoted paths from nvm4w and `Program Files`.
- Improves Windows runtime shutdown by tearing down WebSocket connections before
  closing the HTTP server and killing worker process trees with `taskkill /T /F`
  before falling back to PTY termination.
- Makes `hive update`, open-in-editor commands, folder picking, filesystem
  browsing, and port-in-use recovery friendlier on Windows.
- Preserves CRLF line endings in `.hive/tasks.md` mutations and makes the tasks
  watcher more tolerant of atomic-save editors.
- Resolves OpenCode session data under `%LOCALAPPDATA%` on Windows and aligns
  Claude session path encoding with Claude Code's project directory format.
- Hardens `team send` against stale worker names by returning a 409 with the
  current roster and updates orchestrator guidance to refresh the member list
  before dispatching.
- Expands Windows-focused unit and integration coverage across startup command
  parsing, CLI shims, stdin protocol help, terminal profiles, filesystem
  browsing, process cleanup, and path rendering.

## 1.4.3 - 2026-05-28

Update hardening for multi-Node installs.

- Fixes `hive update` on machines with multiple global npm prefixes. Hive now
  updates the same npm prefix as the currently running `hive` binary, avoiding
  cases where npm installs a new copy elsewhere while PATH still resolves an
  older copy with stale native dependencies.
- Updates the `hive update --help` copy to explain how custom npm prefixes are
  handled.

## 1.4.2 - 2026-05-27

Demo video, worker naming, and small UI polish.

- Adds a Bilibili demo video entry to the sidebar footer and replaces the demo
  workspace mockup with the actual demo video embed.
- Links the Hive logo and version in the topbar to `hivehq.dev`.
- Uses role glyph avatars for workers instead of two-letter placeholders.
- Auto-fills a generated worker name when the Add Member dialog opens and
  prevents the name from regenerating while the dialog stays open.
- Trims random worker-name pools to well-known figures for clearer,
  localized names.
- Improves the empty Tasks panel with a stronger add-task call to action.
- Serves the sidebar Bilibili icon from a packaged static asset instead of an
  inline data URL.

## 1.4.1 - 2026-05-26

Private release-source housekeeping.

- Keeps the packaged product release train on the private release-source
  repository.
- Adds attribution and trademark notices to the packaged npm tarball.
- Documents the private/public repository split so future release work does
  not accidentally expose internal implementation notes or unreleased product
  work.
- Stabilizes the manual startup-command smoke test under full-suite PTY load.

## 1.4.0 - 2026-05-22

Template marketplace and agent picker polish.

- Adds a bilingual template marketplace to the Add Member flow, with English
  and Chinese agent libraries, category filters, search, and one-click import
  into custom role instructions.
- Ships the marketplace templates inside the npm package under
  `dist/vendor/marketplace`, so the library works from packaged installs
  without fetching remote content.
- Polishes the marketplace drawer/card design for denser browsing, clearer
  imported states, stronger search ergonomics, and better Chinese/English
  category labels.
- Keeps the Tasks side panel aligned with the Team Members panel width for a
  more predictable two-panel layout.
- Shows the selected CLI's brand mark in the Agent CLI picker, while keeping a
  terminal glyph for generic custom commands.
- Removes stale Biome suppression comments from marketplace-related UI code.

## 1.3.4 - 2026-05-21

Terminal performance and Tasks panel polish.

- Improves terminal responsiveness by keeping mounted terminal hosts stable,
  lazy-loading heavier xterm addons, and reducing terminal-run polling churn.
- Fixes OpenCode TUI wheel and mouse handling by preserving binary input for
  normal terminals while translating OpenCode legacy mouse reports into the
  SGR format it handles correctly.
- Sends a current `.hive/tasks.md` snapshot when a Tasks websocket connects,
  and guards that initial read so a missing or unreadable file does not break
  the websocket session.
- Renames the visible Todo entry to **Tasks** and widens the Tasks side panel
  to match the default Team Members pane width.
- Enlarges the Team Members header and count badge for better readability.

## 1.3.3 - 2026-05-21

OpenCode terminal scrolling and small UI polish.

- Restores the Task Graph topbar entry so the graph view is available again
  from the main shell.
- Updates generated worker names to use localized, role-scoped historical
  figure name pools, making Chinese and English workspaces feel less generic.
- Fixes OpenCode TUI mouse-wheel scrolling inside Hive terminal panels. Hive now
  tags each terminal run with an input profile and maps OpenCode wheel events to
  the keys OpenCode's message viewport actually handles (`Ctrl+D` / `Ctrl+U`),
  while leaving other alternate-screen TUIs on the existing arrow-key fallback.
- Preserves that OpenCode profile when the user selects the OpenCode preset but
  starts it through a custom startup command such as `opencode --continue`.
- Keeps workspace shell terminals on the default input profile.
- Enlarges the Team Members header count for better readability.
- Documents that npm's `prebuild-install@7.1.3` deprecation warning comes from
  the upstream native-binary installer chain and is safe to ignore.

## 1.3.0 - 2026-05-20

Installable Hive: turns the web shell into a real PWA so Chrome / Edge can
launch it from a dock icon, in its own window, without a visible browser
chrome.

- Adds a web app manifest with icons (192, 512, maskable 512, apple-touch 180),
  a wide screenshot, and shortcuts for "Add Workspace" and "Try Demo" so
  right-clicking the dock icon jumps straight to those flows.
- Installation is driven entirely by the browser's omnibox install icon
  (Chrome / Edge / Brave); Hive deliberately does not add a redundant topbar
  button.
- Ships a service worker (`/sw.js`) that caches the SPA shell + hashed asset
  chunks + static icons / sounds / cli-icons, but never intercepts `/api/*`,
  `/ws/*`, or non-GET requests — auth cookies and WebSockets keep their
  native paths. Each release writes to its own cache bucket and older buckets
  are kept so tabs still controlled by the previous SW can resolve their
  lazy-imported chunks.
- Surfaces shell updates as a bottom-right toast (`Web UI updated — Reload to
  activate`) instead of forcing a refresh. The Reload button stays disabled
  while any terminal run is still working so updates never interrupt an
  in-flight agent.
- Routes service-worker auto-reloads through the same silent reload helper used
  elsewhere in the app, so browser updates do not trip the close-confirmation
  guard.
- Replaces the workspace area with a dedicated `Hive runtime is not running`
  page when the initial bootstrap fails. The page pings `/api/version` every
  three seconds and reloads automatically once the daemon comes back; a manual
  Retry button is offered alongside.
- Hardens the server: `/sw.js` is served with `Cache-Control: no-store` and the
  manifest with `Cache-Control: max-age=0, must-revalidate`, so SW updates
  propagate the next time the browser checks instead of waiting on a stale
  HTTP cache.
- Notes for first-time installers: the SW activates after the first reload
  following install. On separate ports (`hive --port 4011` vs `--port 3000`)
  Chrome treats Hive as two distinct PWAs because the install scope is keyed
  by origin. To fully remove a PWA install, use
  `chrome://apps` → right-click the Hive tile → Remove.
- Always asks the browser to confirm before closing the tab or PWA window so
  Cmd-W on an installed app never closes silently. Modern browsers gate the
  prompt on prior page interaction — opening the window and immediately
  pressing Cmd-W still closes cleanly by browser policy.
- Open Workspace dropdown now uses each app's brand color for its icon
  instead of the previous monochrome white treatment, and visually separates
  VS Code from VS Code Insiders so users can tell their installed targets
  apart at a glance.
- Workspace avatars in the sidebar stay the same size when the user drags
  the sidebar wider. Previously the wide layout used a 22px avatar while the
  collapsed layout used 32px, so expanding the sidebar made the avatars
  smaller; both modes now render at 32px.
- Drops IntelliJ IDEA, Windsurf, and iTerm2 from the Open Workspace dropdown.
  IntelliJ users typically launch from JetBrains Toolbox rather than a folder
  picker; Windsurf overlaps with the existing Cursor / VS Code entries;
  iTerm2 overlaps with the built-in macOS Terminal entry. macOS now exposes
  seven targets (VS Code, VS Code Insiders, Cursor, Finder, Terminal,
  Ghostty, Zed); Windows / Linux expose five (VS Code, VS Code Insiders,
  Cursor, File Explorer / File Manager, Zed). A stored preference for any
  removed target silently falls back to the platform default at load time.
- Swaps the Zed, Ghostty, and Finder dropdown icons for the apps' official
  brand marks (Finder uses the macOS app icon, Ghostty 96×96 / Zed 64×64
  raster) so each entry reads as the real application rather than an
  abstract glyph. Ghostty's mark renders inside a generous safe-zone so its
  display size is bumped 20% via CSS scale to balance the row visually.
- Replaces the Worker detail modal and Workspace shell dialog with a docked,
  resizable, VSCode-style terminal panel inside the right column (under the
  team members pane). Worker tabs and shell tabs share the strip; clicking a
  member card opens that worker as a tab; the panel hides when no tabs are
  open. Closing a worker tab keeps the underlying PTY running — worker
  lifecycle is owned by the card hover cluster. Tab list, active tab, and
  panel height all persist (height globally, tabs + active per-workspace).
  Cmd-W (Ctrl-W on Windows / Linux) closes the active tab; a "+" button in
  the tab strip starts a new shell. Start failures and shell-start failures
  now surface as toasts instead of inline modal/dialog banners.
- Moves "Save as template" into the role-instructions toolbar in the Add Member
  flow, keeping template actions closer to the prompt editor instead of adding
  another standalone control in the dialog body.

## 1.2.0 - 2026-05-18

Opens the active workspace in your editor, terminal, or file manager from
Hive's topbar.

- Adds an "Open" split button to the topbar that launches the active workspace
  in a chosen application. Ten targets on macOS (VS Code, VS Code Insiders,
  Cursor, Windsurf, Finder, Terminal, iTerm2, Ghostty, IntelliJ IDEA, Zed) and
  six on Windows / Linux (VS Code, VS Code Insiders, Cursor, Windsurf, File
  Explorer / File Manager, Zed).
- Persists the preferred target per browser via `localStorage` so the next
  click jumps to the same app. Stale preferences for apps that aren't valid on
  the current platform fall back to the OS file manager instead of erroring.
- Surfaces failures as localized toast notifications. Distinguishes
  "app not installed", "launcher not on PATH", and other failure modes so a
  missing Cursor install reads differently from a misconfigured `code` CLI.
- Backend launches each command via `execFile` with an argv array — no shell
  is involved, so workspace paths containing spaces, Unicode, or quotes pass
  through verbatim. Paths containing newlines or NUL bytes are rejected before
  dispatch.
- Special-cases Windows `explorer.exe`, which returns exit code 1 even on
  success: spawn-errors are still surfaced, but a non-zero exit no longer
  shows a spurious toast.

## 1.1.5 - 2026-05-18

Custom startup command and close-guard fixes.

- Keeps the selected CLI interaction driver when a custom startup command is
  provided. This lets aliases such as `ccs --continue` start Claude Code while
  Hive still submits messages using Claude Code's bracketed-paste flow.
- Adds an explicit "Generic command" option for unknown CLIs such as Qwen or
  custom agent shells that should use only the provided startup command.
- Covers both directions of the shell-wrapper path: `team send` into a custom
  worker command and `team report` back into a custom orchestrator command.
- Prompts with the browser's native confirmation dialog before closing or
  refreshing the Hive tab while the active workspace still has running terminal
  sessions.

## 1.1.4 - 2026-05-17

Update guidance polish.

- Shows `npm install -g @tt-a1i/hive@latest` in update prompts instead of
  `npm update -g @tt-a1i/hive`, making the upgrade command explicit and
  deterministic across npm versions.

## 1.1.3 - 2026-05-17

Brand polish.

- Uses the README logo for the browser favicon and the in-app topbar brand mark.
- Removes the old inline SVG favicon from the web shell.

## 1.1.2 - 2026-05-17

Release workflow fix.

- Runs npm publish on Ubuntu instead of macOS. Publishing does not require
  macOS, and the Ubuntu runner is a better fit for the publish step.

## 1.1.1 - 2026-05-17

Release workflow fix.

- Publishes without production source maps in the npm tarball while keeping the
  user-facing package contents unchanged.

## 1.1.0 - 2026-05-17

Workspace terminal release.

- Added a Workspace terminal that opens from the active workspace and runs in
  the workspace directory. It supports multiple shell tabs, full-height terminal
  space, tab switching, and closing individual tabs without closing the whole
  dialog.
- Kept the external install path unchanged. Users still install with
  `npm install -g @tt-a1i/hive` or run with `npx @tt-a1i/hive`.
- Hid the dormant task-graph / Blueprint entry from the main UI while keeping
  the underlying code in place for possible future use.

## 1.0.0 - 2026-05-17

Stable release.

- Hive is now published as the stable `1.0.0` release. The install path stays
  the same: `npm install -g @tt-a1i/hive` or `npx @tt-a1i/hive`.
- Fixed PTY keyboard handling so Shift+Enter can reach terminal apps such as
  Claude Code and Gemini instead of being swallowed as a plain submit.
- Worker cards now present live terminal state as `running` / `运行中` rather
  than exposing the internal `working` vs `idle` dispatch-status distinction.
  The protocol-level `idle / working / stopped` states remain unchanged.
- Worker detail modals reserve Escape for the embedded terminal, so agent
  shortcuts that use Escape no longer close the modal accidentally.
- Codex session capture no longer decodes every historical
  `~/.codex/sessions/**/rollout-*.jsonl` file during agent startup. It reads a
  bounded first line only, which removes multi-second add-member stalls on
  large Codex session stores.
- CLI agent logos are preloaded and decoded synchronously to reduce the blank
  avatar flash immediately after a member is created.

## 0.6.0-alpha.8 - 2026-05-16

License switch — no code changes from alpha.7.

- Starting from this version, Hive is licensed under the **Business Source
  License 1.1** (BSL), not Apache-2.0. BSL allows personal use, internal
  organizational deployment, embedding in non-competitive products, and
  non-commercial forks. It only prohibits offering Hive as a hosted or
  embedded multi-agent orchestration service to third parties on a paid
  basis. On **2030-05-16** the license automatically converts to Apache-2.0.
- All versions at or before `0.6.0-alpha.7` remain permanently licensed
  under Apache-2.0 — that grant is irrevocable and is not affected by this
  switch.
- See [`LICENSE.BSL`](./LICENSE.BSL) for the full BSL text including the
  Additional Use Grant, and [`LICENSE`](./LICENSE) for the historical
  Apache-2.0 grant.

## 0.6.0-alpha.7 - 2026-05-16

Worker identity, language, and workflow polish.

- Worker cards and the worker detail modal now display the CLI agent's
  brand logo (Claude Code, Codex, Gemini, OpenCode) instead of the
  role-letter placeholder. Unknown presets or workers launched via a
  custom command fall back to the legacy role-letter avatar so existing
  rows never render blank. The `team list` payload gained a
  `command_preset_id` field (snake_case wire, camelCase in-process); the
  enrichment honours `presetAugmentationDisabled` so the launcher and
  the UI stay in lockstep.
- Workers can now boot from a custom `startup_command` (e.g. native
  `claude --resume <session-id>`) entered from the add-member or
  add-Workspace dialogs. Routes-workspaces detects shell-driven
  invocations and stores them without binding to a preset.
- UI language adapts across the entire surface: task drawer (including
  the raw Markdown editor that previously mixed Chinese conflict copy
  with English buttons), notification settings popover, OS-level
  desktop notifications, the workspace add / confirm / server-browse
  dialogs, the FS picker, the demo view, the toast container, and the
  terminal screen-reader status. Adds a `~146`-key expansion of the
  i18n table covering `tasks.*`, `notifications.*`, `workspace.*`,
  `layout.*`, `terminal.*`, `terminalPanels.*`, `toast.*`, and a couple
  of `demo.*` / `common.*` additions; `{plural}` placeholders are gone
  so the wire shape can't leak literal `{plural}` tokens at runtime.
- Worker cards lost the bottom raw-PTY line preview (a noisy CLI
  status row that varied per agent and confused users). The
  `last_pty_line` field stays on the wire so a future "current task
  summary" surface can reuse it.
- Translation copy itself was reviewed: `Queen` is gone from UI chrome
  (the metaphor only appears in onboarding prose), Workspace /
  Orchestrator / Agent are normalised as proper nouns in Chinese
  copy, role names tightened (`Coder → 开发`, `Tester → 测试`),
  ellipsis switched from ASCII `...` to typographic `…`, `task(s)`
  notation retired.

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
