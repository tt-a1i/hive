# 降低任务内问答成本：第一批

用户已授权开分支吸收 Orca 的协作优势、降低 Hive 通信成本。基线 `11184ef`，分支 `codex/lean-agent-communication`，独立工作树，未包含 #44/#46。

## 场景与可观察结果

成员遇到必须回答才能继续的问题，目前需要构造 question、保存多份路由 ID、重复查询、找到 answer；回答者需要反向填写 target/source/recipient。提问超时容易重发同一个问题。

本批让 `team ask` 一次创建问题并有界等待；`--resume` 只读原问题；`team reply <question-id>` 由服务端从持久问题推导回复路由。`team messages --after N --wait S` 在一个 CLI 调用里等待增量消息，减少模型轮询回合。不做这些，现有澄清循环继续由每个模型重复编排。

## 范围与契约

- 复用 dispatch_messages、reply_to、outbox、已有消息权限和报告水位；不增 schema、依赖、成员状态或新完成模型。
- 新增 `POST /api/team/question` 只供问题发送者或接收者读取；`POST /api/team/reply` 根据已保存问题生成反向路由，并通过原消息授权重新检查。
- `team ask --dispatch D [--to orchestrator] [--from-dispatch S] <question>` 默认等 30 秒，`--wait 0..60` 可调整；超时保留 question_id，可 `team ask --resume Q`。写成功立即向 stderr 输出 ID，后续读失败也不自动重发。
- `team reply Q <answer>` / `--stdin` 只简化路由，不放宽历史、同 root、workspace、控制器绑定和取消权限。
- CLI 等待使用有界只读轮询（最多每秒一次），每次请求重新鉴权；模型只收到最终结果。当前不是服务端长轮询，也不是 Orca 的批次 ACK 邮箱。超时只表示本次等待结束。
- `messages --wait` 必须携带实际读过的 `--after`；返回完整增量正文和原水位，未更新 seen 或自动 report。
- 未决定消费 ACK、嵌套委派、跨 root 咨询、自动 seen；这些需要独立实现与验证，不能在减少语法的同时悄悄改变权限。

## 证明与验证

减少的义务：模型拼接回复方向、编写等待循环、超时后重发问题。保留问题关联、消息正文、任务状态及授权检查。旧 CLI 和 HTTP 消息入口保持兼容。

使用独立临时 HTTP/SQLite/真实 PTY + CLI 的断言式 self-check，覆盖提问/回答、原问题恢复、peer/historical 路由、非参与者、取消、鉴权、增量消息和原 report 屏障。当前临时测试纪律下不新增或改 tests/；self-check 是本次非平凡逻辑的最小可运行检查。运行相关既有检查、check、build；若扩为广泛协议改动则补全量。四角度独立 review 后记录每项 verdict。

不以命令数减少宣称速度/token/成功率提高；真实 CLI 模型与跨机器验证单列未验收。源代码修改可从本分支 diff 撤销，无数据迁移。

> 以下为第一批的历史收据；完整范围与最新验收状态见 [完整目标](2026-09-22-lean-collaboration-full.md)。

## 本批交付记录

- 完成：隔离分支、ask/reply/resume、增量等待、实际投递与恢复提示改用短回复命令。
- 完成：复用既有授权和报告水位；取消、移除成员、重启恢复、历史责任回复均有可运行断言。
- 未实施：批次消费 ACK、受限委派、跨 root 咨询、结构化 outcome；这四项不属于本批问答入口简化。
- 未验证：真实模型的耗时/token/完成质量，跨机器与移动端体验，外部 Codex 控制器换绑后的实际链路。换绑授权仍复用既有 policy，不能把源码复用称作实测通过。

实际通过的检查：

```sh
pnpm exec tsx scripts/check-lean-communication.ts
pnpm exec tsx scripts/check-collaboration-event-guidance.ts
pnpm exec vitest run tests/unit/dispatch-message-payload.test.ts tests/server/team-api-authz.test.ts tests/server/collaboration-metrics.test.ts
pnpm check
pnpm build
git diff --check
```

现有回归为 3 文件、23 项通过。self-check 使用真 HTTP、SQLite、PTY 和 team CLI，PTY 成员为被动进程，不代表真实模型验收。鉴权回归日志中存在本地 Claude native binary 未安装提示；套件断言通过，不据此宣称 Claude 启动验证通过。未跑完整 `pnpm test`：本批为有界 CLI 等待和问答入口，未修改 schema、调度生命周期或权限策略，按风险分层执行定向回归。未发版，未执行 pack 发版闸门。

没有修改或删除 `tests/`。新增断言式 self-check；既有 `check-collaboration-event-guidance.ts` 仅将命令提取更新为实际生成的 `team reply`，并禁止检查过程自动打开浏览器。产品修改集中于 CLI、消息路由、共享回复推导和提示，未删除已有消息接口。

## Self-Review

| 维度 | 首轮 → 复核 | 问题及 verdict |
| --- | --- | --- |
| A 架构 | B → A- | 已修：实际注入与恢复仍生成旧长命令；两者现共用短回复入口。 |
| B 边界 | B → A- | 已修：截止后仍可能启动额外请求；检查剩余预算并中止超时读取。独立真 HTTP 复跑确认约 1 秒结束、慢请求在约 2 秒预算中止，403/断连仍抛错。 |
| C 验证 | B- → B+ | 已修：等待检查先发消息，不能证明等待；现先真实读空再发布。补超时计时、关闭早返和删除接收者。控制器换绑实际链路未测，明确保留，复核认为不阻断本批。 |
| D 契约 | B → A- | 已修：回复提示与新命令方向不一致；实际提示统一，旧消息入口仍兼容。 |

四份独立复核无剩余严重或中等阻断项，最低 B+。A/C/D 复核以源码和日志为据，B 另外执行了真 HTTP 截止时间检查；不把只读复核写成独立全量重测。
