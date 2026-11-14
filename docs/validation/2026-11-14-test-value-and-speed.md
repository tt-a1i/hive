# Test value and feedback speed — 2026-11-14

## Goal and scope

Reduce test overhead while retaining meaningful protocol, lifecycle, recovery,
SQLite migration, and remote security coverage. The user authorized all three
stages of the supplied audit: remove false/retired tests, consolidate duplicate
coverage, and improve execution/CI selection. Test counts and source/test line
ratios are inventory, not evidence that a test is useful or useless.

Baseline: `d1693a1` in a detached worktree. Baseline and after timings use the same
Node 22.23.3 installation, dependency directory and machine. Before and after run
unit then web sequentially, without other test runs. They are single samples,
not a general speed guarantee. Baseline Web tests passed; the reported earlier
Web failure was not reproduced.

## Audit decisions

| Recommendation | Verdict and coverage |
|---|---|
| Scaffold/docs string checks | Removed `tests/setup/root-config.test.js`: file existence and exact prose were not product behavior. Package smoke/tarball checks remain. |
| Literal type object | Removed the self-asserting object from `tests/shared/types-shape.test.ts`; retained the exported three-state runtime marker check. TypeScript still checks actual usage. |
| Retired Memory/Goal standalone tests | Removed v26/v27/v36/v37 standalone cases from `schema-version.test.ts`. Latest-schema historical upgrade/drop and reopen behavior remain in `schema-v46.test.ts`; SQLite driver interoperability remains in `tests/unit/sqlite.test.ts`. |
| Remove v36 and old migration modules | Not adopted. The historical modules still build real upgrade fixtures, and changing the active migration chain is unnecessary to improve tests. Production migration logic is unchanged. |
| CSS/pixels/DOM ordering | Removed only those assertions from empty-state, role-avatar and confirm-dialog tests. Actions, accessible labels/content and Escape-close behavior remain. |
| Six i18n probes → pure dictionary export test | Adapted: six files consolidated into `tests/web/i18n-coverage.test.tsx`, preserving their actual key groups and bilingual checks through the public provider. Dictionaries are private; no test-only production export or source parsing was added. `i18n.test.tsx` still verifies language switching/persistence. This is not full dictionary coverage. |
| Duplicate desktop workflow | Removed `desktop-layout-unchanged.test.tsx`; transferred its wide-shell/empty and active workspace assertions to `app-shell.test.tsx`, which retains responsive layout interaction. |
| Initial workspace test | Retained `workspace-create-initial-state.test.tsx`: it uniquely verifies custom generic command startup with real runtime/PTY. Common initial path/empty-task assertions also remain in `workspace-flow`. |
| Mobile demo backend | Replaced unnecessary server/database bootstrap in `mobile-demo.test.tsx` with explicit frontend responses. It remains a component/demo interaction test; real mobile runtime workflows remain separate. |
| Move pure store tests | Moved `workflow-schedule-store`, `workspace-store-ephemeral`, `team-send-authz`, `tasks-file-missing-dir`, and `runtime-rehydration-stopped` from server to unit. The first two and rehydration retain assertions; team-send now isolates and closes its store and checks ConflictError, while missing-dir verifies actual created-file content. Did not move every file merely because it lacked HTTP; file count alone is not a benefit. |
| Combine active schema fragments | Not adopted: v19/v20/v21/v35 exercise distinct active columns/tables, repair paths and role refresh. Small file count alone is insufficient reason to merge. |
| Remove worker status mock tests | Not adopted: natural-exit `listWorkers` status and immediate restart transitions are not asserted by the proposed real-PTY replacements. Existing real PTY defense remains untouched. |
| Workflow file-count consolidation | Not adopted as a bulk operation. Independent runner/store/route behavior remains useful even for a default-off feature; consolidation requires a demonstrated duplicate contract or setup cost. |
| Tool subprocess loops | Exported existing planner/checker/result logic. Per-case decisions run in memory; real Git/process tests still verify file discovery, supplied base, bad-base failure, CLI status, related selection, isolation and sharding. No product test-only fallback. |
| Fast/slow pools | Bounded four-thread fast project; serial, per-file isolated fork runtime project after fast. Fullstack Web workflows remain in runtime. A real subprocess fixture uses a barrier to require fast overlap, an exclusive lock to reject runtime overlap, and different PID assertions to require fresh runtime processes. |
| Default tarball smoke duplication | Default runner excludes `package-tarball.test.ts`; explicit file invocation remains available. `release:dry` and CI platform installation jobs retain packaging defense. The runner fixture verifies exclusion and explicit failure propagation. |
| Narrow CI full triggers | Removed dead controller prefix. Ordinary team routes/helpers use related tests plus real team send/authz contracts. Team authorization/dispatch operations, schema/storage, shared protocol, lifecycle, workflow and remote boundaries remain full gates. Unknown inputs and deletion fallback remain conservative. |
| CLI tsx cold starts | Kept real executable/stdin/exit contracts. Independent help/error invocations in `team-args-hardening` now run concurrently; valid dispatch, oversized stdin and final report remain ordered. No stale-build shortcut. |
| Unreferenced LanguageToggle | Removed the zero-reference component; active language selection is unchanged. |

## Verification

Raw local artifacts: `/tmp/hive-test-evidence.hfjy71/` (not committed; retained for
inspection). Portable command/result aggregates are in
[the metrics JSON](2026-11-14-test-value-metrics.json). Failed exploratory runs
remain in the local artifacts and are excluded from speed comparisons.

| Selection | Before | After | Result |
|---|---:|---:|---|
| `pnpm test tests/unit` | 39.115s | 8.774s | Passed; legacy interop separately enabled and passed |
| `pnpm test tests/web` | 200.158s | 68.790s | Passed, including the new ordering/error regressions |

Actual timing commands use `node scripts/run-tests.mjs` with the selection plus
`--reporter=json --outputFile=<artifact>` (the same wrapper as `pnpm test`).
Final validation (exit 0 for every command):

- `pnpm check`, `pnpm exec tsc --noEmit`, `pnpm build`,
  `node scripts/check-engineering.mjs`, and `git diff --check`.
- Default full `pnpm test`: 398 files; 2634 passed, 5 conditional skips,
  0 failed; 442.592s. This full run was required for shared test configuration
  and the core replay fix; it is not a before/after full-suite benchmark.
- Explicit `pnpm test tests/integration/package-tarball.test.ts`: 3/3 passed,
  11.475s. Real package manifest, scriptless installation and normal installation
  smoke paths all ran.
- `HIVE_TEST_LEGACY_SQLITE=1 pnpm test tests/unit/sqlite.test.ts`: 4/4 passed.
- Five conditional skips are listed in the metrics JSON; the legacy-driver case
  was exercised separately. Windows-only lifecycle cases still require Windows CI.
- Updated documentation links were checked. Remote CI/platform outcomes are
  recorded in the PR, not inferred from local results.

## Self-Review

Four independent reviewers examined architecture, boundaries, test quality and
current-spec alignment. Initial static grades were A− in all dimensions; runtime validation then
exposed defects requiring another review. Final review verdicts:

- A architecture: A−; fixes remain within the existing hook and replay responsibilities.
- B boundaries: A− after fixing stale save acknowledgements and preserving genuinely new snapshot/external content; same-ms queued replay retains submitted protection.
- C test quality: A− after replacing response-header waits with actual hook-save and revalidation-body/React-completion barriers; stale-content negative controls fail as expected.
- D spec alignment: A−; workspace scope, three-state protocol, workflow exclusions and atomic claims retained.

All actionable P2 feedback was fixed. No severe items were skipped, and there
were no unresolved reviewer conflicts. The second round corrected initial
assumptions about isolation and asynchronous completion; the scope grade is A−,
not a claim that the entire product has been exhaustively verified.

## Validation-driven correction

The first Web run with `singleFork` batching failed 32/729 tests despite focused
runs passing. Shared jsdom/bootstrap state crossed file boundaries. That failed
91.5-second run is retained in the raw artifacts and is not a speed result.
The runtime project now uses a one-worker fork pool with fresh isolation per
file, rather than batching files into one worker; the fast project uses isolated
threads. The regression additionally requires distinct runtime PIDs. The failing
app-shell/tasks/notifications workflows and execution policy fixture then passed
(20 tests). Boundary review rechecked the fix; final whole-suite results follow.

## Additional measured bottleneck

An active-workspace shell case spent about 13ms starting its server, 2ms closing
the store, and 3.47s waiting for HTTP close. A pending `/api/version` request was
involved. Injecting the existing version-service dependency reduced that case
from about 3.59s to 0.12s. The helper now has an explicit `offlineVersionCheck`
option enabled at the 16 fullstack Web test sites. It fixes only the external
registry dependency; HTTP routing, SQLite and PTY remain real. The default for
server/integration tests and version-service coverage is unchanged. Some other
connections still incur cleanup waits; no blanket speed claim is made.

## Task editing race exposed by faster execution

The subsequent full Web run passed 728/729 tests. In the remaining case, the file
contained a checked task but the UI reverted to unchecked. Controlled real-server
ordering reproduced delayed initial HTTP and WebSocket snapshot overwrites. This
is a product defect, so the shared task hook is corrected rather than weakening
the checkbox assertion or inserting a sleep. The final fix preserves the original optimistic-clean behavior. Ambiguous
snapshots wait for pending saves and read current HTTP content, with workspace,
socket and revision guards. External updates invalidate stale acknowledgements;
failure rollback preserves the true saved baseline. Tests wait for actual hook
save completion, parsed revalidation content and React updates. They include
external updates (also a revert to the original baseline), newly received
snapshot content, and failed-save rollback.

## Queued replay boundary exposed by core validation

The first core selection failed one interactive replay case, and the same case
failed in the frozen baseline. A deterministic real HTTP/SQLite/PTY regression
then set dispatch creation and worker start to the same millisecond: the strict
`createdAt < startedAt` filter excluded legitimate parked work. The predicate now
includes equal-time **queued** rows, which still compete through atomic claims.
Submitted-undelivered rows retain the strict boundary so a live write is never
reclaimed merely because its timestamp matches. Workflow exclusions and sequence
bounds are unchanged. No migration or HTTP protocol fields changed. The real
regression plus unit cases passed 12/12; a later full run covers the combined
changes. This is a two-line condition fix with no net production-file growth.
