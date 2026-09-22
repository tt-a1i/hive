# 协作通信内部简化回执

## 范围与基线

用户调用 simplify-codebase；在 `codex/lean-agent-communication` 上对已完成、尚未提交的协作改造做 Focused / Change。仅处理消息请求的 CLI → HTTP → 查询返回边界；不扩张为全仓清理，不删除用户能力、不修改持久格式。公共开发仓库对应工作树 `/Users/tushaokun/code/hive-lean-communication`，原 private 工作区未改。

本轮基线是调用 skill 时的工作树，而非 HEAD（此前协作实现尚未提交）。5 个修改文件已逐一备份到忽略目录 `artifacts/lean-simplification/before/`，本轮独立差异见 `artifacts/lean-simplification/change.patch`。

基线命令：

```sh
pnpm exec vitest run tests/integration/lean-collaboration.test.ts tests/unit/collaboration-mailbox-store.test.ts tests/server/team-api-authz.test.ts
```

结果 3 文件、23 项通过（`baseline.log`）。历史全量结果与失败分类见 [协作验证记录](2026-09-22-lean-collaboration-validation.md)；本轮不将定向通过描述为全仓绿色。

## 覆盖图与契约

| 边界 | 入口 / 所有者 / 消费者 | 检查与结论 |
|---|---|---|
| CLI 请求 | team.ts → team-question.ts；delegate/inbox/ask/reply | 三份相同身份、5 秒默认 signal、postJson 封装合一；调用者自带 signal 仍优先，无写重试；旧 message/messages/peers 超时策略不变 |
| HTTP 入口 | routes-team-messages.ts 的 questions/delegate/peers/inbox/question/reply/message/messages，注册为路由表 | 八份 JSON 形状、字段白名单、身份、token、工作区、角色检查合一；检查顺序、角色命令和各端点字段保持原样；外部控制器 inbox 禁止规则保留 |
| 问题历史查询 | /questions → dispatch-question-operations → dispatch-message-store.listSentQuestions → CLI ask --list | 原先先取 ID，再逐条读取同一记录；使用既有 joined select/toRecord，保持 sender/workspace 限制、dispatch/source 过滤、游标、50 条分页和 delivery metadata |
| 问答授权 | dispatch-message-policy/reply/question-operations → store | 可答状态与精确反向回答属于不同阶段；保留跨工作区、跨 root 内容和历史责任限制 |
| 邮箱 / 报告 | mailbox-store、dispatch-ledger-store、team-operations | 固定批次负责可重读集合，receipt 负责已考虑消息；seen 兼容显式水位；ACK/report 同事务及取消/退出生命周期不合并 |
| 委派 / 结果 | dispatch-delegation、runtime-store helpers/mutations/workflows、controller 路径 | delegated_from 与关联父链不同；outcome 与生命周期不同；DB 结算与 PTY/等待者清理不同，均保留 |
| 兼容 / 包装 | September 协作 spec、April 设计、package.json、serializer | 不删导出、不改命令、JSON、schema、migration、依赖、资源回收或发布清单 |

检索包含所有相关入口与调用者、runDataMutation 工厂调用、消息序列化/列表消费者及当前协议修订。边界外：完整 UI/mobile/remote/gateway、非协作路径、外部 deep-import 消费者及真实模型性能未重新调查；本轮不修改这些契约，也不据此宣称性能胜出。

## 候选证明与裁决

1. **HTTP 重复鉴权前导：实施，高信心，低收益风险。** 原因是新增端点逐个复制现有验证。生产消费者是上述八个路由，无持久或外部 helper 契约。删除八处独立装配，增加一个文件内 `readMessageRequest`；端点仍显式传字段与角色命令，不新增通用路由框架。没有牺牲能力；最小反证是任一端点接受非法身份/未知字段或改变错误优先级。真 HTTP/SQLite/PTY 身份测试覆盖全部八端点与 delegate 角色拒绝，原集成覆盖成功路径。
2. **CLI 三份请求回调：实施，高信心，小范围。** 调用者都在同一命令分支，身份、body、signal 和默认 5 秒完全一致。仅提取局部 post 函数；不改 public CLI、读 stdin、响应或轮询，不把旧命令的不同超时统一掉。反证是 ask 等待/恢复、reply、inbox ACK、delegate 真 CLI 链路失败。
3. **问题列表 ID 再水合：实施，高信心，小范围。** 同步 SQLite 查询产生最多 50 个存在的 ID 后，又逐条读取完整消息，维护另一种列表组装路径和无意义 undefined 过滤。复用文件已有 join 与 mapper，一次列表查询读取消息；游标验证查询仍保留。无 schema/API 变化；反证是分页、跨工作区/发送者、dispatch 过滤或投递元数据变化。强化真实 SQLite 断言为完整记录比较，加入 delivered/error 及过滤检查。这里仅声明移除了额外逐条查询，不声称测得延迟或 token 改善。
4. **邮箱批次与 receipt、seen/outcome/父链：拒绝合并。** 已有生产和持久消费者，各自负责不同生命周期或兼容语义。合并需要产品决策及迁移，不是证据充分的重复；净收益不成立。
5. **report 的可选事务 fallback：留待独立边界审计。** 生产 runtime 始终提供 SQLite transaction，但多处 unit/server 工厂 fixture 省略 runDataMutation；fallback 和手工补偿早于本轮。它值得清理，但不是当前消息请求边界：删除需先统一所有工厂的持久写事务契约、确认直接消费边界，并替换对应失败注入/回滚验证。没有在本轮偷偷移除报错时的数据清理。
6. **取消后的 DB 结算和 runtime 清理：拒绝合并。** durable ledger、pending count、PTY、等待者和 ephemeral 生命周期有不同所有者，不能用代码外观相似证明重复。

## 净效果、验证与恢复

生产代码三文件：routes-team-messages.ts 245 → 202，team.ts 1707 → 1683，dispatch-message-store.ts 317 → 317，共减少 67 行。维护义务从八份入口鉴权和三份新 CLI 请求装配收敛为各一份；列表不再逐条回读。没有新依赖、文件级框架、状态或 migration。

修改现有测试：team-api-authz 增加一个真实请求矩阵；collaboration-mailbox-store 保留原三项测试并增强完整结果断言。无测试删除，无既有行为断言放宽。

验证结果和四项独立复核见下方。本轮为局部、行为保持的重构，不重复此前耗时约 19 分钟的全量测试；以定向真实链路、权限/存储检查、静态检查和 build 为闸门。真实模型、Windows、移动端未验证。

撤销仅需用本轮 before 备份恢复五个文件并删除本回执；其他既有未提交改动须保留。无数据迁移、配置、发布或部署需要恢复；未提交、推送、建 PR 或发版。

### 最终验证

- 同基线定向命令：3 文件 **24/24 通过**（verification.log，新增 1 个 HTTP 矩阵测试；64 组非法请求及 1 个角色拒绝）。真实 CLI/HTTP/SQLite/PTY 场景包含 source-dispatch 历史恢复；存储测试核对分页及完整投递元数据。
- `pnpm check`：981 文件通过（check.log）；`pnpm build`：通过（build.log），Vite 保留大 chunk 提示。
- `git diff --check`：通过。对本轮独立 patch 逐文件核对，未改 lockfile、schema、协议、清理代码或发布工件清单。runtime-store 195 行、web/app 11 行；路由8个且使用路由表。
- 三项简化均完成；状态/兼容结构按证明记录保留；事务 fallback 明确排除在本轮请求边界之外。生产代码净减67行，测试增加66行，本回执另计；不把测试增长隐去后描述为总仓库净删67行。

## Self-Review

并行复用四位独立 reviewer，均只读审本轮 patch、源码和验证日志，没有独立重跑测试。

| 维度 | 问题结论 / 前轮回归复核 | 评分 |
|---|---|---|
| A 架构 | 无严重/中等问题；父结果通知、共享插入、统一回复提示、Windows fixture 隔离未回退 | A- |
| B bug | 无已确认问题；SQL 分页、错误顺序、signal 无回退，前轮取消/投递/ephemeral/清理修复保留 | A- |
| C 测试 | 无新增问题；真实请求矩阵及完整存储结果检查，未放宽旧断言或引入循环 mock | A- |
| D 协议 | 无偏离；八路由字段/角色、CLI timeout、sender/workspace/source 与游标保持；本轮完成度100% | A |

严重项 verdict：本轮无严重项，无未处理 review 反馈，无结论冲突；综合 A-。本轮无需第二次 review。评分仅覆盖本次简化，不替代前轮全仓失败分类、Windows/真机验收或模型效果评测。
