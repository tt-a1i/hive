# Question recovery integration

Base: public `tt-a1i/hive` main `64f6c9013338251cbf3a93baa32f641b6e1bcd52`.
Donor: `codex/lean-agent-communication` at `831870d81906a7c7aa192b64b4bbc638e571253c`.

## Problem and scope

When answering a related member's question, an agent previously had to preserve the target dispatch, source dispatch and question ID in a reverse-route command. A lost question-write receipt required manually searching message history. This change derives replies from the persisted question and adds sender-scoped history and read-only resume.

The observable improvement is a reply command requiring one question ID, plus recovery of the original question after a lost receipt or runtime restart without writing it again. The baseline CLI rejects `ask --resume`; the new executable check must recover the same persisted ID and reply route. This is command/contract evidence, not a measured model speed or token reduction.

Only `ask`, `reply`, `ask --resume`, and paginated `ask --list` are integrated. Default wait is zero; explicit waiting is bounded to 60 seconds and only polls reads. Existing same-root authorization, controller binding, report `--seen`, paginated review history, and the legacy message API remain in place. No inbox, ACK, delegation, cross-root permissions, outcome column, schema migration, dependency or CI changes.

## Verification

Run from `/Users/tushaokun/code/hive-question-recovery` using the existing dependency installation; no new packages installed.

- Baseline archive at the main SHA: `node --import tsx bin/team ask --resume baseline-id` exits 1 with unsupported command.
- `pnpm test tests/server/team-api-authz.test.ts tests/server/team-review.test.ts tests/server/report-pending-count.test.ts tests/unit/team-cli-parse-args.test.ts tests/cli/team-help.test.ts`: 5 files, 75 tests passed. Existing fixture startup/PTY error diagnostics were printed; this is not real model acceptance.
- `node --import tsx scripts/check-collaboration-event-guidance.ts`: passed real CLI/HTTP/SQLite/PTY generated short replies, historical authors, incremental reads and the explicit report watermark.
- `pnpm check`, `pnpm exec tsc --noEmit`, `pnpm build`, `git diff --check`: passed. Existing Biome informational diagnostics and Vite chunk warning remain.
- `node --import tsx scripts/check-team-question-recovery.ts`: final exit 0 in 5.588 seconds, real CLI/HTTP/SQLite/PTY. Covers asynchronous ask, persisted reply routing, discarded write receipt recovery, restart without duplicate writes, 51-question pagination, sender/workspace/root rejection, explicit wait expiry and later answers, cancellation, recipient removal, controller rebind rejection without added answers, and unchanged seen barrier. Log: `/tmp/hive-question-recovery-smoke.log`. Controller binding is set up through the real store; new query/reply routes are exercised over HTTP, without external host notifications. This does not verify the MCP connection ceremony. An initial probe failed because its temporary `other` directory was missing; fixture fixed, not classified as a product bug.

No files under `tests/` were added, modified or deleted, following the current temporary repository rule. The new script is a runnable real-chain verification attachment. The existing event-guidance script now executes the generated short reply command. Full local tests were not repeated; related tests and real protocol checks cover this bounded additive change, with complete regression delegated to PR CI. No release or model efficiency claim is made.

## Self-Review

Four independent reviews cover the current integration, rather than inheriting the donor's historical approval.

- Architecture: A-. Excluding mailbox/delegation removes the previously identified lifecycle and dual-ACK complexity.
- Bugs/security: B+. No new confirmed defect in static review; same-root, cancellation and binding policy reused.
- Verification: B+ → A-. P2 controller-rebind coverage fixed in the new script (pending → closed; reply 409; no answer inserted). P3 timeout discrimination fixed by measuring after the saved-ID receipt (850 ms to 3 seconds for a one-second wait). Recipient deletion and awaiting CLI exit before cleanup also verified. Independent reviewer rechecked the changes; final script execution passed.
- Contract: A-. Current main pagination and explicit seen semantics preserved; no schema collision or permission expansion.

The earlier donor mailbox defect is outside this change because no mailbox code is imported. Integration deliberately retains current main implementations instead of resolving the donor's 22 conflicts by selecting an entire side. No product code changes are made solely to accommodate tests.

Final verdict: all four dimensions at least B+; no unresolved blocking review findings or reviewer conflicts. Architecture A-, bugs/security B+, verification A-, contract A-. Static review is distinguished from execution receipts above. All scoped commands and compatibility work completed; mailbox/delegation/outcome and real-model efficiency comparisons are deliberately excluded. Runtime store remains 196 lines, web app 11 lines, message router 5 table entries.
