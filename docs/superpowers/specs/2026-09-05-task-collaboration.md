# 面向工作的 Hive 协作

状态：实施设计。用户已授权按会话确定的目标推进；实现、验证、真实 Agent 体验、发布分别记录，不以本文存在作为完成证据。

当前实现通过 Hive PTY 内的 Orchestrator 和 Worker 执行下述协议。

## 目标和边界

减少重复派单、协调者转述、状态响应和角色章程注入，使任务中的澄清、补充、审查、返工连续且可追溯。用户纠偏、遗漏要求、重复执行、结果正确性和总耗时是验收对象，消息数量仅辅助解释。

用户创建的成员均供 Orchestrator 使用。用户保留 CLI、模型和资源选择；协调者选择部分或全部现有成员，缺口提示用户，默认不新增成员。用户停止成员的操作仍有效。资源归属不授权自动重启或更换模型。

复用 PTY、workspace 身份、派单账本、报告 outbox、三态成员模型、任务图和 Action Center。不开新顶层 work 状态机、不建通用聊天平台、不做额度调度、不更换 runtime、不删除可选 workflow。

## 与旧设计的关系

本设计明确替代旧 spec §3.3.4 中禁止成员直连的部分：仅允许下文有派单关联的消息，不授予成员 send/spawn/cancel 权限。替代“缺信息必须 report 结算”与“修改要求必须取消重派”的工作指引。保留每个 send 一份责任、每份责任一次终结 report、名称派单、状态三态和 workspace 隔离。

贡献者里程碑审查要求仍用于开发 Hive，不注入用户工作流程。workflow 已启用也不按成员人数或存在审查自动选用；其现有新建临时成员行为必须符合用户授权，不能用它绕过现有资源优先原则。

## 责任与关联

`team send <member-name> <text> [--related-to <dispatch-id>]`

仅 Orchestrator 可新建责任。可引用同 workspace 的历史或开放派单；服务端保存 `parent_dispatch_id`，推导 `root_dispatch_id`，客户端不能指定 root。独立派单 root 为自身。关联只表示协作范围，不意味着父子等待、自动完成或级联取消。

成员集合从同 root 的责任人导出，不另建成员关系表。历史可读不意味着可以任意向历史参与者分派工作。

默认审查流程：实现 report → 新关联审查 dispatch → 如需修复，Orchestrator 新建关联返工 dispatch。已关闭的执行责任不重开。明确约定持续参与审查的任务可保持执行 dispatch 开放，双方分别最终 report；不强制所有工作采用此模式。

## 任务内交流

```sh
team message --dispatch D --kind note "补充要求"
team message --dispatch D --to orchestrator --kind question "需要决定的问题"
team message --dispatch TARGET --from-dispatch OWN --kind question "成果依据是什么"
team message --dispatch TARGET --from-dispatch OWN --kind answer --reply-to QUESTION "回答"
team message --dispatch OWN --to orchestrator --kind progress "当前进度"
team messages --dispatch D [--after N]
team report --dispatch D --seen N "成果与验证"
```

新增 `POST /api/team/message` 和 `POST /api/team/messages`，token 保留在请求体，不放 URL。沿用 `project_id/from_agent_id/token` 身份，新增字段用 snake_case：`dispatch_id/source_dispatch_id/recipient/kind/reply_to/text/after_seq/seen_seq`。

- `note`：接收者需要考虑的补充，不用于闲聊或重新赋责。
- `question`：需要回答的问题，保留当前责任，不减 pending。
- `answer`：必须引用发给自己的 question，校验来源和目标反向一致；有回答不等于问题已充分解决。
- `progress`：只记录给 Orchestrator 查看，不投递模型，不增加输入水位。

`recipient=owner|orchestrator`，默认 owner。服务端推导实际收件人，拒绝任意 `recipient_agent_id`。交流不创建派单、不改目标/文件归属、不关闭别人责任。

### 直接协作的权限

Orchestrator 可向本 workspace 的开放派单发补充。成员向 Orchestrator 发消息必须关联自己的派单；跨成员消息带自己的 source dispatch，source/target 同 workspace、同 root，通常均开放。

为避免“问原作者一句话也要重派单”，允许严格的历史答疑例外：开放审查/返工责任可以向同 root 的 `reported` 派单发 question；历史责任人只可带 `reply_to` 回答确实发给自己的该问题，目标提问派单仍须开放，源/目标反向对应。`reported` 不收新 note 要求，不重新承担修改责任；`cancelled` 不享有例外。任意历史成员不能借同 root 永久发言。

Orchestrator 也可以针对已 reported 成果提出 question；原作者仅能准确引用该问题回答原 Orchestrator，继续使用原派单关联而不重开。已接纳的 note/answer 是事实，发送方后续终结、取消或删除不能吞掉给仍有效收件人的消息；question 的回复责任失效时停止未开始的投递，历史仍可查。

`team messages` 返回当前认证成员的 `member_profile`（含用户角色描述）、本派单消息、`required_seen_seq` 和同 root 的相关责任摘要，供参与者发现合法交流对象。访问范围由已认证成员的参与关系限定。

## 提交屏障与并发

消息存储 UUID、目标派单内递增 sequence、来源/收件人、kind、reply_to、正文及时间。消息追加与投递项写入同一事务；唯一键确保重试不制造多个相同投递项。

`required_seen_seq` 仅取发给该执行者的需处理入站消息水位，排除 progress、自发消息和组内其他人的交流。最终 `report --seen N` 在报告事务内重新计算并精确比较水位；不一致则 409 且原派单保持开放。

这只证明提交者声明已考虑这些输入，不能证明理解或成果正确。不要求逐消息 ACK，不要求所有问题获得回答才可报告失败或部分成果。

- 补充先提交：旧水位报告失败，读取消息后显式提交新水位。
- 报告先提交：新要求拒绝写入该已关闭责任，不自动改投其他派单。
- 读取后又有新补充：再次拒绝过期报告。
- 没有新入站消息：旧 report 省略 seen 保持兼容。
- 有新入站消息：旧 report 明确失败，CLI 不得自动查询最新值冒充模型确认。
- 409 不再引导换任意 open ID 或关闭 oldest。

## 投递、停止、取消与恢复

消息级 outbox 独立于现有按 dispatch 唯一的报告 outbox。按目标成员串行写入，失败保持可重试并显示失败信息。稳定消息 ID 允许识别重复，不能承诺模型 exactly-once 处理。

稳定 ID 识别 outbox 重投，不等于 HTTP 请求幂等；客户端不自动重试写操作，响应不确定时先查消息/派单再决定重发。该版本不宣称消除旧无 dispatch report 盲重试误关下一单的全部风险，生成提示始终绑定具体派单。

停止成员保留合法待投递消息，不自动启动。真正写 PTY 前重新检查权限和责任状态；取消阻止尚未开始的投递。历史答疑按自己的例外判断，不能用“目标已 report”一律压制。

已经开始的 PTY 注入不能撤回。取消派单和终止进程是不同事实；成员收到取消指示仍需停止相关执行。投递成功仅表示输入通道写入，绝不表示模型已理解。

重启恢复从账本读取真实开放责任、关联派单、消息水位和未答问题，不再按 send/report FIFO 猜测。重新建立上下文时保留用户角色描述。原生 resume 不代表 Hive 能检测 CLI 的所有压缩事件，短身份锚和查询入口持续可用。

旧自由文本 status 保持现有投递兼容，不能因可能含阻塞而无条件静音。新 progress 才只记录。

## 提示词层次

启动：身份、workspace、用户配置角色、必要能力及按需 guide 入口。

日常消息：来源、类型、责任标识、当前事实、必要命令及短信任锚。移除每条消息的完整角色重复和强制动作菜单。不能用 XML 或文字“system”替代服务端身份/权限校验。

完整语法、shell 输入方式、workflow DSL、未使用能力留在相应 `team guide`。恢复重建实际现场，避免靠重复章程修补缺失事实。

资源发现展示用户角色说明、已配置 CLI 和可可靠读取的显式模型；未知模型为 null，不猜测默认模型，不输出原始启动参数或凭据。

## 现有 UI

在 Action Center 显示任务内问题、进度和投递状态，可读消息及关联责任。不新建 dashboard；任务图继续表达计划，账本表达责任。

通知使用真实 report/cancel 事实，不从 pending 减少猜“已汇报”。文案区分提交报告与验收完成。界面必须保留中文/英文、键盘访问和窄屏可用性。

## 迁移和回退

数据库修改全部通过 schema_version migration。版本 41 保留 origin/main 官方外部控制器结构及收据机制；版本 42 增加关联派单、消息、水位、消息 outbox 和控制器 thread 关联；版本 43 仅刷新精确匹配旧中英文默认文本的内置 Orchestrator 模板。自定义/未知描述不覆盖，既有 Worker 描述不重写。Orchestrator 运行身份从当前默认规则构建。旧派单各自成为 root，现有结果、报告队列、状态和 CLI 行为在无新交流时保留。

新客户端遇旧服务端明确报能力不足，不把消息降级成 send。不可让旧二进制写入已启用新消息语义的数据库，否则旧 report 无法执行水位屏障；回退需先停止服务、保存新库快照，再恢复升级前一致备份与匹配二进制。不能通过 drop 新表悄悄丢历史。

## 实跑后修订：上下文与证据

主控在收到新目标时先核对当前团队、工作区路径与目标仓库，按实际收益选择现有成员，不要求每个请求都派单。团队配置未知项明确未知，不猜实际模型。

主控给调查/实现任务共享必要的目标路径、执行 cwd、版本/dirty 范围和适用设计，避免各成员独立重建不同基线。跨目录任务必须明确范围；只读访问其他目录不等于跨工作区协议授权。简单问答无需机械搜集全部基线字段。

报告区分观察、推断和未验证事项。审查发现给触发条件、证据、可观察影响与反证，不凑问题或无据评分。运行检查时记录命令、cwd、退出码与日志/产物路径，复用现有 artifacts。主控按风险复核。

## 实施与验收

见 [实施与验收计划](../plans/2026-09-05-task-collaboration.md)。分批仅划分依赖，最终目标包括提示、双向交流、受限直达、恢复和可见性，不以某个子批通过代替整体完成。

## 2026-09-08 提示与指南补充

用户已授权改进提示传递和按需指引。保留上述权限、责任、报告水位与资源选择规则。

- 内部 `team guide <topic>` 在存在 Hive 身份时调用 `POST /api/team/guide`，请求沿用 `project_id/from_agent_id/token` 并携带 `topic`。认证及工作区校验后，从当前 settings 生成指南，返回 `project_id/project_path/topic/guide`。目录切换不改变指南归属；身份缺失、不匹配或运行时错误不得静默退回本地文档。没有任何 Hive 身份时可读本地文档或通用帮助，明确为离线参考、当前能力未知。
- workflow 创建自定义角色时保留用户模板 description；启动说明与成员资料使用同一值。为已支持 CLI 编写包装命令时应关联对应命令预设；任意可执行程序的 PTY 支持不等于其交互规则已适配。
- 普通 question 和恢复提示共用回复路由，直接给出对应的问题 ID 和 answer 命令。历史问题仍仅允许答疑，不重开实现责任。增量读取只能使用此前实际读过的游标，报告 seen 仍来自已检查的查询结果。
- 事实缺口先读取当前上下文和证据，必要时询问相关责任人；范围、权限和归属冲突由主控决定。普通任务进度使用静默 progress。未答问题可查。
- 工作流示例以交付物、证据和有界投入展示停止条件，不以空轮次数或票数代替验收。仓库贡献者审查要求仍仅用于开发 Hive。

实施和验证记录见 [本轮计划](../plans/2026-09-08-collaboration-guidance.md)。

## 2026-10-23 问题恢复与短回复

从独立协作实验分支提取便捷入口。用户授权基于最新 main 选择有价值的能力集成；本次不改变同 root 权限、责任生命周期、报告水位或存储版本。

- `team reply Q (<text> | --stdin)`：服务端从已保存的问题推导反向路由，再执行既有消息写入鉴权；原 `message --kind answer --reply-to` 入口继续可用。普通投递与恢复中的回复提示使用短命令。
- `team ask --dispatch D [--from-dispatch S] [--to orchestrator] (<text> | --stdin) [--wait 0..60]`：只写一次 question，保存后立即向 stderr 输出 ID。默认 wait=0，仅查询一次并返回；显式正数等待仅适用于当前工作依赖答案的情形，以单调时钟约束只读轮询，不重试写入。
- `team ask --resume Q [--wait 0..60]`：只读原问题。输出包含 question、answers、status、question_id、timed_out、resume；status 为 pending/answered/closed，是派生查询状态，不是新增持久状态机。wait=0 不宣称等待超时；读取失败仍报错，不编造成功快照。answered 只表示已有回答，不代表解决或验收。
- `team ask --list [--dispatch D] [--before Q]`：仅查询当前认证成员发送的问题，每页最多 50 条，返回 next_before。用于写入回执丢失时找回 ID，找到后 resume，不能把丢回执当作未写入而盲目重发。
- HTTP 入口为 POST `/api/team/reply`、`/api/team/question`、`/api/team/questions`，沿用身份字段、token 与既有角色鉴权；query/reply 使用 question_id，历史列表使用 dispatch_id/before_id。问题读取仅向原发送者或接收者开放，回复继续检查取消、成员删除、历史责任边界。历史游标绑定当前工作区和发送者。
- 问题读取不返回可用于 report 的水位，不自动确认其他输入；报告仍须读取并考虑完整消息后使用原 `--seen`。不增加邮箱 ACK、成员委派、跨 root 问答、报告 outcome 或 schema migration。

这些入口减少手工路由字段并支持找回持久问题，不据此声称真实模型速度、token 或成果质量已有改善。
