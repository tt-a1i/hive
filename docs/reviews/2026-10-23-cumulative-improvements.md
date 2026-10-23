# Cumulative collaboration and session recovery review

Baseline: `f8f1343da6595a232f0baba7f0ea5b5a58fe0e9c`.
Branch: `codex/evidence-led-improvements`.

## Scope

Reviewed the complete 28-file product change, including the four new files,
against the design and September collaboration revision. The change covers
message navigation, full report/history access, bounded text-artifact reading,
input-watermark guidance, launch/resume classification, Codex home/config
preservation, configured model discovery, and session ownership.

Only two product files changed during this cumulative review; the other 26
match the pre-review hashes. No dependencies, schema, role/state model, or
product tests were added, removed, or modified. Research logs, private-context
analysis and raw experimental archives remain local and outside this commit.

## Findings and verdicts

1. **P2 — fixed: inline resume templates misclassified fresh launches.**
   In `src/server/preset-launch-support.ts`, a template such as
   `--model sonnet --resume={session_id}` treated its ordinary configuration
   prefix as a resume marker. This could skip startup instructions and prevent
   insertion of a saved session ID. Inline options now own their own marker;
   existing multi-token subcommand prefixes remain supported. Eighteen direct
   checks reproduced eight failures before the fix and passed afterward.
   Six real HTTP/SQLite/PTY cases covered fresh, saved and explicit manual
   launches with both model and boolean-option prefixes. Saved IDs in this
   check were seeded fixtures, not evidence of native session capture.
2. **P2 — fixed: control characters in trust-table keys corrupted TOML.**
   `src/server/codex-trust-store.ts` previously escaped only quotes and
   backslashes. Legal POSIX paths containing newlines could make the entire
   configuration invalid. JSON string escaping plus explicit DEL escaping
   now handles TOML basic-string controls. Independent checks parsed seven
   path variants with Python `tomllib`, preserving the exact project keys,
   existing settings, mode 0600, second-call bytes/mtime and temporary-file
   cleanup. This was a retained pre-existing edge case, not a claim that the
   cumulative patch introduced it.
3. **P3 — retained: synchronous Codex history enumeration.**
   `src/server/session-capture-codex.ts` still enumerates historical directories;
   metadata fallback supports old nonstandard filenames. There is no new
   cache or background index. Large histories may increase startup latency;
   this review did not establish a performance regression or justify another
   stateful mechanism. Ownership reads remain bounded per file.

## Validation

All commands ran with Node 24.22.0 in the repository. Local receipts are under
`/tmp/hive-overall-review-20261023`; independent TOML checks are under
`/tmp/hive-cumulative-review-b-20261023`. These paths are local evidence, not
portable dependencies or an automated CI gate.

- `pnpm check`, `pnpm build`, and `git diff --check`.
- `pnpm exec tsc -p /tmp/hive-action-center-ui-tsconfig.json`: the inspected
  temporary configuration includes this checkout's `src` and `web`, excluding
  tests. It is not a claim that whole-repository type checking passes.
- Existing Vitest suites: `claude-session-support`, `agent-run-bootstrap`,
  `session-capture-codex-platform`, `session-capture-multi-cli`,
  `session-capture-home-path`, `codex-trust-store`, `team-list-enrichment`,
  `agent-startup-instructions`, `claude-session-resume-failure`,
  `claude-session-concurrent-capture`, `dispatch-workflow-fields`,
  `collaboration-metrics`, `team-protocol-end-to-end`,
  `team-report-outbox-route`, `report-pending-count`, `message-artifacts`,
  and `team-report-open-target`: **17 distinct files, 99 distinct passing tests**.
  The six trust tests ran twice and are counted once.
- Existing history probe: **102 assertions**, real HTTP/SQLite, including
  an independent connection inserting while paginating.
- Current artifact build: **41 checks** plus **20 actual atomic-replacement
  reads**, all returning the expected conflict. One real recorder PTY,
  no native model. This is not a proof against every possible filesystem race.
- New inline-template protocol probe: **six real recorder PTYs**, no native
  model; all observed PTY/observer PIDs exited and the server port closed.
- The unchanged UI files retain prior desktop/narrow-viewport browser evidence;
  this review did not repeat browser or phone acceptance.

No full test suite or release packaging gate was run: the fixes are local
classification/serialization changes, with targeted protocol and rollback
regression coverage; no schema or broad runtime lifecycle change was made.
Previously recorded prompt-literal assertion conflicts, Layer-A fixtures lacking
startup identity, two whole-repository test-cast type errors, and the standalone
collaboration script's SQLite object-prototype assertion remain disclosed.
They were not silently fixed, counted as passing, or used to weaken production
semantics. Build retains its existing bundle-size warnings.

## Self-Review

- A — **A-**: inline-template P2 fixed and independently rechecked; retain
  the documented history-enumeration P3 without introducing caching.
- B — **A-**: TOML-control P2 fixed and independently parsed; inline-template
  fix and real startup receipt checked. No additional confirmed bug or leak.
- C — **A-**: both P2 fixes have source-bound checks, including the real
  six-PTY launch path; test totals and artifact/history receipts independently
  verified. The final `pnpm check` subsequently exited 0.
- D — **A-**: no new protocol deviation, authorization regression, state
  transition, or cross-workspace capability found.

The first pass found the inline-template and TOML-control P2 issues. Both were
fixed before the follow-up reviews; C moved from B+ with an open real-startup
verification item to A- after checking the six-PTY receipt and final sources.

Prior fixes were rechecked across their callers, including unknown ownership,
metadata quoting, history focus and cancellation, artifact indices, and input
watermark semantics. The two P2 findings are resolved; no architecture rewrite
was justified. All four final reviews are A- and the scoped checks passed;
the changes are approved for a local branch commit. This review does not establish dual-native-model collaboration,
general efficiency gains, phone/weak-network acceptance, or release readiness.
