# Terminal runtime compatibility boundaries

## Browser protocol after upgrading

Refresh open Hive pages after updating the server and Web assets. The current
client marks user input separately from automatic terminal responses and sends
input with its requested grid size. The actively typing client determines the
shared grid; other clients follow it and may need horizontal scrolling.

An older client sends raw bytes without that distinction. When a run has a new
protocol client, the server rejects an old client's input and resize with
`terminal_refresh_required`. The old client receives an error asking it to
refresh. Its sockets stay open so its automatic reconnect logic does not loop.
Its rejected input has not reached the CLI. Preserve any draft before refreshing.
All-legacy connections remain supported for compatibility, but do not establish
the new input-owner behavior. Do not infer user intent by matching raw bytes.

Resize requests and input-frame dimensions must be positive integers, no greater
than 32767 per axis (ConPTY coordinate range) and no more than 1,000,000 visible
cells in total (the server's grid allocation budget). Oversized messages are
rejected before changing the grid or writing input, rather than silently clamped.

## Codex shell environment compatibility: explicit opt-in

Hive injects its team environment into the agent process. A Codex shell policy
that inherits only core environment variables can still remove these variables
from commands executed by that agent. A running Codex session or visible Hive
members alone does not prove that `team list` can authenticate.

The current candidate is enabled only when the process starting Hive has
`HIVE_CODEX_TEAM_ENV=1`. This is not a global Codex configuration edit and must
not be installed using a persistent machine-wide environment change.

For Codex launches only, Hive adds runtime arguments that enable inheritance,
disable the default exclusions, and constrain inheritance to a fixed allowlist
in `src/server/codex-team-environment.ts`. That list includes core operating
system environment names and `HIVE_PORT`, `HIVE_PROJECT_ID`, `HIVE_AGENT_ID`,
`HIVE_AGENT_TOKEN`. Credential values are not placed in arguments, saved launch
configuration, browser responses or logs.

Explicit opt-in is the selected delivery policy, not a claim of automatic
compatibility for every Codex installation. This overrides the shell inheritance
policy for that launch. Custom environment
variables outside the allowlist may no longer be inherited. It is therefore not
currently enabled automatically for every Codex user. Launch-policy changes do
not retroactively update an existing process; preserve drafts before restarting
an agent through Hive's normal session recovery flow.

This compatibility option is not a merger for arbitrary custom shell policies.
It uses Codex's legacy `include_only` option. Do not combine that option with
`shell_environment_policy.filters` in the same configuration layer: Codex
rejects the combination. Existing exclusions, explicit `set` values, managed
requirements, and configuration-layer precedence also need separate validation;
adding a name to an allowlist does not restore a value already excluded. Hive
does not erase those settings or insert credential values to work around them.
See the [official shell environment policy documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy).

Local Codex 0.155.1 accepted the candidate's runtime arguments in its config
parser and rejected a same-layer `filters`/`include_only` combination. This
parser check is not proof of child-shell inheritance, nor a compatibility claim
for all Codex versions. Verify the actual `team list` path after opting in; if
custom policies conflict, leave the option disabled until that policy has been
reviewed rather than silently broadening inheritance.

Verify variable presence only, then run `team list` inside the Hive-launched
agent and compare its members with the current workspace. Do not manufacture
tokens or switch to an external controller to bypass missing internal context.
An external controller must independently bind to the correct Hive instance;
workspace IDs from a different server are not interchangeable.

## Native and browser dependency delivery are separate

The xterm source patch is integrated into the normal Web build; see
[`patches/README.md`](../patches/README.md). The node-pty JavaScript lifecycle
patches are not the separately compiled OpenConsole/ConPTY runtime used in
local acceptance. Current normal server startup still uses the system backend.

Windows launches now use `src/server/pty.ts` and the reviewed JavaScript under
`vendor/node-pty-windows`, copied to `dist/vendor` during build. This closes the
pnpm-only patch delivery gap for the Hive launch path; directly importing the
external stock dependency is not the same path. The vendor resolver uses the
installed upstream platform package for native modules and rejects a version
mismatch. It does not copy DLLs or executables or enable the native candidate.

The Windows x64 npm archive passed the scriptless-install smoke, including a
natural-exit probe without a post-exit `kill()`, followed by HTTP, SQLite and
internal team-list checks. This is not ARM64 or Unix runtime validation, actual
Codex shell acceptance, or final review approval. The separate ConPTY source-only
handoff still applies.

Repeated Windows test execution terminated a test worker with `0xC0000374`,
followed by an IPC channel error. This was reduced to workspace deletion followed
by runtime shutdown while the PTY was still starting: both callers could request
termination before `onExit`. The shared stop entry now ignores repeated requests
while its first termination and escalation are pending. The real-PTY regression
failed before this guard and passed afterward; the original 57-case suite also
completed with a normal process exit. Retain the red evidence and require final
regression/review gates before approving delivery.

An isolated comparison that loaded the stock Windows JavaScript wrapper with
the same installed native module also produced `0xC0000374` before the IPC error.
The candidate cleanup change was therefore not required to trigger the failure.
The runtime stop fix does not itself establish other-platform compatibility or
clear the dependency candidate for delivery.

Workflow stop now also cancels the wait for a member's startup-input readiness,
including when a parent workflow stops. Previously cleanup could wait for that
barrier even after the run's budget had closed. This does not make a synchronous
native ConPTY connect interruptible: a blocked Node event loop can still delay
the budget timer itself. Passing a workflow cleanup deadline is not evidence
that the default native backend includes the separate handshake source patch.

A device pass with an external native loader does not prove an npm installation
or clean checkout has the same behavior. Do not package a private loader or
unsigned preview executable as an implicit default. Native source provenance,
toolchain reproduction, paired executable/DLL verification, licensing,
distribution and platform support must be resolved before claiming delivery.

## Evidence limits

Browser event fixtures can exercise production xterm, real WebSocket, HTTP and
PTY boundaries, but dispatched composition events are not native iPhone IME.
Device feedback, automated input tests, package smoke, and full-suite results
must be reported separately. Keep failed baseline comparisons; neither a narrow
green test nor an inherited failure establishes overall readiness.
