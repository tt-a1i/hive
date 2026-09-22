# 协作减负验证记录

分支 `codex/lean-agent-communication`；基线 `11184ef42627dbaeaf3cd1d5a6c00ad7ef75fb31`。所有运行数据均为临时库和被动 PTY，未使用用户运行库；外部控制器使用临时通知程序，没有发出真实 Codex 宿主通知。

## 测试恢复后的最终收据

用户已明确回复“可以恢复”，本次核心测试冻结解除。涉及新契约的 15 项失败已全部同步；同时修正同一启动指引文件中两项相关的旧 readiness 断言。新增 3 个常规集成场景和 3 个真实 SQLite 容量/分页检查；未删除测试用例。取消越权测试删掉错误文案等值断言，保留 HTTP 403、责任状态和 pending 断言。原有 worker reminder 的 400 字上限继续保留，当前固定短 ID 示例为 388 字；这不是模型成本测量。

| 最终检查 | 实际结果 | 记录 |
| --- | --- | --- |
| 11 个受影响测试文件完整运行 | **170 通过、11 失败**；剩余均为此前同失败点的基线项 | `artifacts/lean-collaboration/restored-tests.log` |
| 修复测试入口后的 3 个常规集成场景 | **3/3 通过** | `artifacts/lean-collaboration/restored-integration-final.log` |
| 邮箱容量/字节预算/问题分页的真实 SQLite 单元检查 | **3/3 通过** | `artifacts/lean-collaboration/restored-mailbox-bounds.log` |
| 含基线失败的两个文件中，本次改变的 4 个用例单独复跑 | **4/4 通过**，53 项未选中；不声称这两个完整文件全绿 | `artifacts/lean-collaboration/restored-changed-cases.log` |
| `pnpm check`、`git diff --check` | **通过** | `artifacts/lean-collaboration/restored-check.log` |
| 构建与全量回归 | 沿用下方生产代码版本的 build 通过及完整失败分类；本次恢复后只改测试、验证脚本和记录，没有修改生产逻辑 | 下方历史记录 |

相关 11 个文件的命令包含：`tests/integration/lean-collaboration.test.ts`、`tests/unit/team-cli-parse-args.test.ts`、`tests/unit/team-atomicity.test.ts`、`tests/server/schema-version.test.ts`、`tests/server/team-api-authz.test.ts`、`tests/cli/team-cli-side-effects.test.ts`、`tests/server/team-prompt-contract.test.ts`、`tests/integration/team-protocol-end-to-end.test.ts`、`tests/integration/agent-startup-instructions.test.ts`、`tests/unit/agent-startup-instructions.test.ts`、`tests/unit/hive-team-guidance-reminder.test.ts`；通过 `pnpm test <上述文件>` 运行。其余命令分别为 `pnpm test tests/integration/lean-collaboration.test.ts`、`pnpm test tests/unit/collaboration-mailbox-store.test.ts`，四项过滤运行的完整参数保留在对应日志开头。

保留的 11 项基线失败是 `team-atomicity.test.ts` 中 6 项旧启动/报告 fixture 问题，以及 `hive-team-guidance-reminder.test.ts` 中 5 项旧主控/工作流指引断言。没有为这些旧预期添加生产 fallback，也没有删掉失败测试。未重复约 19 分钟的全仓测试：生产代码没有再变，最新增量已做相关回归及独立复核；上次全量 FAIL 保持原样，不推算或宣称当前全仓通过。

### 最终复核

- A 架构 **B+**：已修 POSIX Codex fixture 无条件进入 Windows suite 的问题；Windows 仍运行成员协作、迁移和存储场景，仅外部 MCP fixture 场景显式跳过。没有伪造 Windows 验收。
- B 边界 **A-**：已修子进程超时绕过 finally 的临时目录遗留；父进程持有 root 并清理。reviewer 用 2 秒超时独立复验清理有效。
- C 验证 **B+**：确认旧契约更新未削弱真实状态断言，新增脚本内断言失败会传播；容量/UTF-8/分页检查能区分错误实现。认可保留基线失败并用本轮相关回归收口。
- D 契约 **A-**：新 outcome、ACK、授权与历史问题恢复契约一致，旧显式 seen 和消息入口兼容检查保留。

严重项全部关闭；本轮新增 P2（平台入口）与 P3（超时清理）也已修复、复核。实现和本次定向验收完成；全量基线债务及未实跑平台属于明确保留的验证限制。

## 测试恢复前的全量回归记录

以下是恢复测试前的历史结果，保留原始失败及当时 verdict；它们不覆盖上方更新后的最终状态。


| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `pnpm exec tsx scripts/check-lean-communication.ts` | PASS | 真 CLI/HTTP/SQLite/PTY；问答/丢回执恢复、ACK 新输入竞态与重启、跨 root 权限、委派限额/取消/删除/临时成员、父取消与子报告竞争、结果写失败事务回滚 |
| `pnpm exec tsx scripts/check-lean-persistence.ts` | PASS | v45→v46、旧报告 outcome=null、批次及结果重开、真实 MCP 操作幂等与控制器换绑拒绝 |
| `pnpm exec tsx scripts/check-collaboration-event-guidance.ts` | PASS | 实际注入的短回复路由、历史责任、增量消息及显式 seen 兼容 |
| `pnpm check` | PASS | 974 文件；不等同运行验收 |
| `pnpm build` | PASS | TypeScript 和 Web 构建；原有大 chunk 提示 |
| `git diff --check` | PASS | 无空白错误 |
| `pnpm test` | **FAIL** | 393 文件：365 通过、27 失败、1 跳过；2638 项：2582 通过、52 失败、4 跳过 |

全量耗时 1137.54 秒。52 项失败中，36 项在原基线同失败点复现；3 项原基线已有失败、这次又叠加更早的新提示契约断言失败；12 项断言这次已改变的旧契约；1 项 UI 超时在当前分支重跑以及基线重跑均通过。不能将这些分类写成全量通过。当时尚未修改 tests/；旧契约随后已按上方授权与收据同步。

完整原始日志保留在工作树忽略目录 `artifacts/lean-collaboration/`，不会随源码自动提交。基线从上述 commit 解包到独立临时目录，共重跑本轮 27 个失败文件；没有改当前工作树或用户已有源码。基线 4 组命令的明确文件列表保留在对应日志开头。

## 每项失败的处理

| 失败项 | verdict / 证据 |
| --- | --- |
| `tests/cli/team-cli-side-effects.test.ts > team send CLI side effects (R1.3) > team send injects prompt into worker stdin, records message, bumps pending count, and binds reporting to its dispatch` | 新契约：旧提示逐字断言（强制 seen/旧禁止文案/不含 outcome），与已审核的新指引不同。实际 PTY 指引和新报告流程检查通过；测试待同步。 |
| `tests/cli/team-help.test.ts > team cli help > team guide prints focused runtime guidance without requiring Hive env` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/integration/agent-startup-instructions.test.ts > agent startup instructions > new orchestrator and worker runs receive team command guidance over real PTY stdin` | 混合：基线原已有旧提示失败；当前又在更早的本次 report/seen 提示断言失败。两部分都保留，不计为纯基线；本次契约断言待同步。 |
| `tests/integration/layer-b-fallback.test.ts > Layer B fallback integration > orchestrator recovery summary preserves Hive worker dispatch rules` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/integration/team-protocol-end-to-end.test.ts > team protocol end to end > real hive runtime records send/report messages and updates worker status` | 新契约：旧提示逐字断言（强制 seen/旧禁止文案/不含 outcome），与已审核的新指引不同。实际 PTY 指引和新报告流程检查通过；测试待同步。 |
| `tests/server/message-artifacts.test.ts > message artifacts > report messages persist artifacts for recovery/debugging` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/report-pending-count.test.ts > report pending count > report decrements pending count instead of forcing zero` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/runtime-rehydration.test.ts > runtime rehydration > restores workers and pending task counts from sqlite state` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/runtime-rehydration.test.ts > runtime rehydration > restores pending task counts from dispatches instead of legacy message replay` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/runtime-store.test.ts > runtime store > reportTask resets worker pending count and returns it to idle` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/runtime-store.test.ts > runtime store > reportTask keeps a stopped worker stopped while draining pending count` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/schema-version.test.ts > schema version > latest schema includes last_session_id, pid, ended_at and drops messages.kind` | 新契约：migration 46 增加 outcome/delegated_from_id；旧断言仍要求版本 45/原字段集合。真实迁移 self-check 通过；测试待同步。 |
| `tests/server/schema-version.test.ts > schema version > migration from v36 creates external goal tables and stamps v37` | 新契约：migration 46 增加 outcome/delegated_from_id；旧断言仍要求版本 45/原字段集合。真实迁移 self-check 通过；测试待同步。 |
| `tests/server/schema-version.test.ts > schema version > migration from v43 adds dispatch payload byte columns and stamps through v45` | 新契约：migration 46 增加 outcome/delegated_from_id；旧断言仍要求版本 45/原字段集合。真实迁移 self-check 通过；测试待同步。 |
| `tests/server/schema-version.test.ts > schema version > migration from v44 adds agent_launch_configs.cwd and stamps v45` | 新契约：migration 46 增加 outcome/delegated_from_id；旧断言仍要求版本 45/原字段集合。真实迁移 self-check 通过；测试待同步。 |
| `tests/server/team-api-authz.test.ts > team API authz (R1.4) > worker cancel is rejected and leaves the open dispatch pending` | 新契约：成员只可取消亲自委派的子任务；原测试确认 403 后在旧错误文本等值比较处停止，后续 pending 断言未运行；另以真实 self-check 核对越权取消后子树仍 submitted、成员 pending 不变。测试待同步。 |
| `tests/server/team-memory-dream-runner.test.ts > memory dream manual runner > contradictory report supersedes old memory by adding the new fact and archiving the old one` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-memory-dream-runner.test.ts > memory dream manual runner > scheduled tick runs after idle debounce when a worker report creates new evidence` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-prompt-contract.test.ts > team prompt contract > task dispatch keeps identity while its full role remains queryable` | 新契约：旧提示逐字断言（强制 seen/旧禁止文案/不含 outcome），与已审核的新指引不同。实际 PTY 指引和新报告流程检查通过；测试待同步。 |
| `tests/server/team-recall-api.test.ts > /api/team/recall > returns message and dispatch evidence through the real HTTP route` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-replay-submitted.test.ts > replay of submitted dispatches after restart (#80) > startup replay re-delivers a submitted row whose PTY write never completed` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-replay-submitted.test.ts > replay of submitted dispatches after restart (#80) > startup replay does not re-paste a submitted row whose write already completed` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-report-outbox-route.test.ts > POST /api/team/report redelivery outbox failure > keeps the dispatch open and records no report when offline redelivery cannot be queued` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-report-outbox-route.test.ts > POST /api/team/report redelivery outbox failure > rolls back the prequeued report when dispatch ledger update fails` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-report-outbox-route.test.ts > POST /api/team/report redelivery outbox failure > deleting a worker preserves and redelivers its accepted report evidence` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-review.test.ts > POST /api/team/review > omitted cli picks a different command than the orchestrator` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/server/team-spawn-dismiss.test.ts > team spawn / dismiss > ephemeral worker with multiple open dispatches survives until the LAST one is reported` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/agent-startup-instructions.test.ts > buildAgentStartupInstructions — experimental workflow gate > worker startup treats team status as optional and does not require a handshake turn` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/agent-startup-instructions.test.ts > buildAgentStartupInstructions — experimental workflow gate > reviewer startup uses the same optional status note and does not impose a handshake` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/agent-startup-instructions.test.ts > buildAgentStartupInstructions — experimental workflow gate > workflow member startup is a slim one-shot contract, not the full member startup` | 混合：基线原已有旧提示失败；当前又在更早的本次 report/seen 提示断言失败。两部分都保留，不计为纯基线；本次契约断言待同步。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > short Orchestrator anchor > keeps identity, trust boundary and recovery entry without an action menu` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > work-centered core rules > selects existing named resources while retaining user configuration and ownership` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > work-centered core rules > external controller tool guidance starts with inspection and retains authorization boundaries` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > work-centered core rules > both entrypoints carry every shared principle exactly once and keep transport syntax separate` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > work-centered core rules > keeps native-agent and shared-file boundaries for both roles` | 新契约：旧提示逐字断言（强制 seen/旧禁止文案/不含 outcome），与已审核的新指引不同。实际 PTY 指引和新报告流程检查通过；测试待同步。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > buildProtocolDoc workflow DSL reference (relocated from the always-on rules — TIER 1/2 prompt fixes) > teaches dag() for explicit dependency graphs` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > buildWorkerReminderTail > interpolates the dispatch_id into the team-report syntax line` | 混合：基线原已有旧提示失败；当前又在更早的本次 report/seen 提示断言失败。两部分都保留，不计为纯基线；本次契约断言待同步。 |
| `tests/unit/hive-team-guidance-reminder.test.ts > buildWorkerReminderTail > names the role and forbids nested subagents` | 新契约：旧提示逐字断言（强制 seen/旧禁止文案/不含 outcome），与已审核的新指引不同。实际 PTY 指引和新报告流程检查通过；测试待同步。 |
| `tests/unit/sqlite.test.ts > built-in SQLite storage contract > preserves legacy files across migrations, FTS queries and reverse driver reads` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > dispatchTask deletes dispatch ledger record when worker start fails` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > dispatchTask revalidates worker after startup before writing stdin` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > dispatchTask returns before auto-start post-start input is ready` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > dispatchTask waits behind an already-starting worker without letting later sends jump ahead` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > dispatchTask waits behind a running worker until post-start input is ready` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > reportTask records and queues the report (no longer throws) when the orchestrator run is absent` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-atomicity.test.ts > team atomicity > reportTask queues the report for redelivery when orchestrator stdin forwarding fails` | 新契约：报告现在传入 outcome=success；旧 spy 参数集合未包含该字段。真实回滚与结果持久化检查通过；测试待同步。 |
| `tests/unit/team-cli-parse-args.test.ts > parseReportArgs > treats --success and --failed as backward-compatible no-ops` | 新契约：success/failed 有实际语义，不能重复/互相冲突；旧测试要求两个参数同时当 no-op。测试待同步。 |
| `tests/unit/team-replay-recovery.test.ts > replay failure recovery (review findings) > startup replay skips dispatches created after the active run started` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/unit/team-runtime-flow.test.ts > team runtime flow (unit) > team report injects a system message into active orchestrator run and records message` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/web/add-worker-marketplace-import.test.tsx > AddWorkerDialog marketplace integration > clicking Browse marketplace opens the drawer` | 首次 UI 超时；当前分支及基线分别重跑，均 4/4 通过。 |
| `tests/web/workspace-notifications.test.tsx > workspace notifications > seeds member and historical-report snapshots without startup or replay toasts` | 基线复现；未归因为本次变更，保留失败。 |
| `tests/web/workspace-notifications.test.tsx > workspace notifications > cancel-to-idle stays quiet; a real report notifies once without requiring a worker transition` | 基线复现；未归因为本次变更，保留失败。 |

## 未覆盖与剩余验收

- 本次 15 项契约测试已同步，测试冻结不再是剩余事项；见上方最终收据。
- 完整基线失败记录保留；本轮相关文件复跑仍有 11 项原有失败，不能声称全仓通过。没有扩为全仓测试债务清理。
- 没有真实模型同任务、同预算的效率/质量对照，没有 Windows 或移动真机验证，不声称更快或更省 token。
- 未提交、推送、合并、发布。没有执行发版 pack gate；当前工作不能作为已发布验收。
