# Test and CI improvements

Base: dc20b09. Isolated branch: codex/test-ci-improvements. This task may change
tests and CI, as explicitly requested by the user; it does not resume the parent
chat's PR, merge, or release work.

## Evidence and goals

- Nightly 39863299815: verify passed 2689 tests in 591.24 seconds; all platform
  work waited for it. Windows Node 26 failed installing better-sqlite3 because
  its native build could not locate Visual Studio.
- better-sqlite3 has one real consumer: old/new-driver migration and reverse-read
  compatibility. Keep this protection as a required Node 22 CI job, instead of
  compiling a test-only old driver for every OS/runtime.
- Preserve the existing six platform/package combinations and extended matrix.
  Build/package once, allow tests and platforms to consume that build in
  parallel, and use three built-in Vitest shards for full Linux tests.
- Update obsolete prompt expectations and the Codex recorder's actual JSONL
  startup records, so tests protect current input/ownership contracts.
- Isolate test HOME and data directories, propagate signals/failures, and make
  the aggregate result reject missing or unexpectedly skipped selected jobs.

## Validation

Use real temporary Git repos and Vitest subprocesses for planner/runner checks;
verify shard inventory union and non-overlap. Run targeted HTTP/SQLite/PTY
recovery tests, all-source type checking, check/build, and a complete local suite
with JSON results. Verify old-driver interop separately after building its test
dependency. Do not change product semantics, increase retries/timeouts, or claim
hosted timing improvement from local measurements. Keep failed baselines.

This side chat explicitly forbids subagents. Four independent agent reviews
cannot be performed here; report four-angle self-checks as self-checks, with
independent review still outstanding. Do not commit, push, or merge implicitly.
