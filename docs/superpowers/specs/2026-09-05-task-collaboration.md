# 面向工作的 Hive 协作

状态：实施设计。用户已授权按会话确定的目标推进；实现、验证、真实 Agent 体验、发布分别记录，不以本文存在作为完成证据。

基线：最初从 `9ca67fe` 开始，现已合入 `origin/main` 的 `950f04a`（包含 #58 外部 Codex App 控制器及 #60 原生依赖修复），整合提交为 `ef49556`。开发位于独立工作树，原仓未提交的 #56 等改动不纳入本轮基线。下述协作能力同时覆盖内部 PTY Orchestrator 与既有外部 Codex App 控制器。

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

## 外部 Codex App 控制器

沿用 #58 的单 workspace 单控制器绑定。`hive.controller_action` 的调用身份来自 MCP 宿主 metadata（`threadId` / `codex/turn.thread_id`），由服务端核对当前确认的绑定；模型参数不能自报 thread ID。桌面确认和现有连接流程保留，不隐式接管其他会话。

- `action=send` 支持 `related_to_dispatch_id`，仍按 `worker_name` 分配新责任。
- `action=message` 接受 `dispatch_id/kind/text/operation_id` 及可选 `reply_to`。kind 仅 `note|question|answer`，目的地是派单负责人；外部控制器不能冒充成员 source，也不发送 progress。
- `action=messages` 接受 `dispatch_id` 和可选非负 `after_seq`，返回与内部查询相同的消息、水位、成员资料和关联责任。
- `inspect` 返回当前成员、开放责任、近期消息及需处理消息。progress 保持可查，不唤醒模型。

所有修改动作先持久保留 `operation_id`，绑定 workspace、宿主 thread 和规范化输入。同 ID、同输入的已完成操作重放原收据；不同输入/身份拒绝，pending 或 failed 无确认成功收据时拒绝盲重跑，要求先核对实际状态。内部 `team message` HTTP 写入没有这个操作级幂等承诺，不能把两种入口混为一谈。

成员给外部协调者的任务消息进入持久收据流。`read_reports` 返回至多 100 条未确认收据及完整嵌套 message，记录读取时间，并把关联任务消息标为已交付外部输入通道；仍需 `ack_reports` 确认已读取收据。ack 只结束通知义务，不回答问题、不结算派单、不更新 Worker 的 `seen_seq`。`answer + reply_to` 是回答关联，Worker 的 `report --seen` 是提交时声明已考虑输入，三者均不等于成果验收。未答但已 ack 的问题仍可从消息/需处理事项查询。

断连在同一数据库事务内检查开放责任、未确认收据、进行中操作、正在发送的通知和消息投递，再清除绑定。`delivering`（已开始注入）必须挡住断连，不能因历史派单已 reported 就放行。唯一可退役的 queued 例外，是当前绑定发给 reported 作者的历史 question：断连把这些尚未开始的消息标为 cancelled 后清除绑定，保留正文历史，避免永久等待一个已停止作者。

问题保存创建时的 `controller_thread_id`。旧绑定问题不能改投新控制器；答复校验原 thread 和当前绑定，退役 question 也明确拒绝回答，即使后来重新绑定相同 thread 也不能复活。已开始的输入不可撤回；已交付问题在换绑后同样不授予向新绑定回答的权限。需要继续答疑时由当前控制器重新提出问题。

## 提示词层次

内部 Orchestrator 与外部 Codex App 主控直接复用同一份 transport-neutral 协作原则，包括用户资源选择、项目基线、所有权、禁止宿主内建子代理替代 Hive、责任与证据验收。CLI/MCP 的命令语法、身份凭据、通知消费与恢复机制仍由各自入口提供；共同原则不代表工具集或宿主模型行为完全相同。

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

主控在收到新目标时先核对当前团队、工作区路径与目标仓库，按实际收益选择现有成员，不要求每个请求都派单。绑定成功应主动提示已绑定会话读取 `inspect` 获取实时现场；提示不携带任务授权，不替用户确认，也不自动启动成员。团队配置未知项明确未知，不猜实际模型。

主控给调查/实现任务共享必要的目标路径、执行 cwd、版本/dirty 范围和适用设计，避免各成员独立重建不同基线。跨目录任务必须明确范围；只读访问其他目录不等于跨工作区协议授权。简单问答无需机械搜集全部基线字段。

报告区分观察、推断和未验证事项。审查发现给触发条件、证据、可观察影响与反证，不凑问题或无据评分。运行检查时记录命令、cwd、退出码与日志/产物路径，复用现有 artifacts。主控按风险复核，ack 仍不代表验收。

报告通知附本批已选 `report_ids`，便于接收任务识别已处理的迟到提醒。当前会话已确认消费这些 ID 时不重复查询；查询为空则停止本次提醒，不持续轮询、不重新派单。此改动不宣称已查明实跑三次空读的内部时序，也不承诺撤回已进入宿主队列的通知。

## 实施与验收

见 [实施与验收计划](../plans/2026-09-05-task-collaboration.md)。分批仅划分依赖，最终目标包括提示、双向交流、受限直达、恢复和可见性，不以某个子批通过代替整体完成。

## 2026-09-08 提示与指南补充

用户已授权改进提示传递和按需指引。保留上述权限、责任、报告水位与资源选择规则。

- 内部 `team guide <topic>` 在存在 Hive 身份时调用 `POST /api/team/guide`，请求沿用 `project_id/from_agent_id/token` 并携带 `topic`。认证及工作区校验后，从当前 settings 生成指南，返回 `project_id/project_path/topic/guide`。目录切换不改变指南归属；身份缺失、不匹配或运行时错误不得静默退回本地文档。没有任何 Hive 身份时可读本地文档或通用帮助，明确为离线参考、当前能力未知。
- 外部 `hive.controller_action` 增加 `action=guide`，仅接受既有 `workspace_id` 和 `action` 字段。它要求相同的宿主身份和已确认绑定，返回 `workspace_id/guide`；只读，不占用 operation_id、不消费收据、不改变责任。工具说明保留核心选择、幂等、收据和通知规则，详细动作参考可按需读取。
- workflow 创建自定义角色时保留用户模板 description；启动说明与成员资料使用同一值。为已支持 CLI 编写包装命令时应关联对应命令预设；任意可执行程序的 PTY 支持不等于其交互规则已适配。
- 普通 question 和恢复提示共用回复路由，直接给出对应的问题 ID 和 answer 命令。历史问题仍仅允许答疑，不重开实现责任。增量读取只能使用此前实际读过的游标，报告 seen 仍来自已检查的查询结果。
- 事实缺口先读取当前上下文和证据，必要时询问相关责任人；范围、权限和归属冲突由主控决定。普通任务进度使用静默 progress。收据消费和回答问题分别进行；未答问题继续可查。
- 工作流示例以交付物、证据和有界投入展示停止条件，不以空轮次数或票数代替验收。仓库贡献者审查要求仍仅用于开发 Hive。

实施和验证记录见 [本轮计划](../plans/2026-09-08-collaboration-guidance.md)。

## 2026-09-22 有界问答与增量等待

用户授权在独立分支吸收 Orca 优点，减少协作成本。本补充替代旧 MVP “不提供阻塞 API”的限制：等待是成员显式选择的有界 CLI 操作，不改变三态，不替用户重启/扩容，不默认要求主控等所有报告。

- `team ask --dispatch D [--from-dispatch S] [--to orchestrator] (<question> | --stdin) [--wait 0..60]` 写一条既有 question 并等待，默认 30 秒。写成功立即向 stderr 输出问题 ID；最终 stdout 是单个 JSON，包含 question、answers、status、question_id、timed_out、resume。status 为 pending/answered/closed，是问题可答状态的查询结果，不是新持久状态机。
- `team ask --resume Q [--wait 0..60]` 只读取原问题。问题及回答来自 SQLite，CLI 结束或进程重启不创建第二份问题；必须仍具有有效的当前成员凭据。写请求结果不确定时依然先查历史，不能把没有收到问题 ID 当作未写入。
- `team reply Q (<answer> | --stdin)` 通过 POST /api/team/reply，只传 question_id/text 与原身份字段；服务端根据持久问题推导 dispatch/source/recipient 并沿原消息校验写入。旧 `message --kind answer --reply-to` 保持兼容。两者都不承诺写入幂等。
- `POST /api/team/question` 接受 question_id 与身份字段，只允许问题发送者/接收者读取；返回持久问题、全部已保存回答和当前可答状态。无回答且原反向回复不再合法（取消、退役、成员删除、控制器换绑等）时 closed；已有回答返回 answered，仍不等于验收。
- `team messages --dispatch D --after N --wait S` 复用消息查询，默认不等；显式等待须提供实际读过的 after。发现增量或本 dispatch 已终结即返回，否则超时。CLI 内每秒只读轮询，每次重新鉴权，每个 HTTP 请求另有 5 秒网络上限；不增服务端等待对象。该设计减少模型工具回合，不宣称减少 HTTP 请求或提升实测速度。
- 问题读取不自动拉取或确认所有任务补充，不携带可直接套用的 seen；保持 report 事务及原水位规则。消息查询仍返回正文与水位。PTy 注入和外部控制器收据机制保持既有语义；本批不引入通用 ACK 邮箱、跨 root 咨询或 Worker 派单。

本批实施、验证和待评估项见[计划](../plans/2026-09-22-lean-communication.md)。

## 2026-09-22 完整协作减负修订

用户明确要求按完整目标推进。本节替代上述仅主控派单、所有问答同 root、仅手动 seen 的限制；工作区隔离、用户资源选择、文件归属和三态保持不变。完整契约和边界覆盖见[完整计划](../plans/2026-09-22-lean-collaboration-full.md)。

- `team inbox [--wait 0..60]` / `team inbox --ack B`：SQLite 保存收件人专属固定批次，最多50条/64KiB正文（单条超限完整返回）；未确认批次可重读并跨重启恢复。首次只选仍有意义的开放任务输入和未答历史问题，不导入全部历史。ACK 声明已考虑准确消息集合，不吞后来消息，不回答问题，不验收成果。`report --ack B` 将声明与报告放在同一事务；新输入出现则整笔拒绝、批次保持未确认。旧 `--seen` 声明继续可用，无未确认输入时无额外步骤。
- `team delegate <member-name> --from-dispatch D (<task>|--stdin)`：成员从自己已投递且开放的责任向现有成员委派。服务端事务校验最大2层、每父3份开放子任务、每树累计8份子任务，禁止回到祖先成员。委派父链 `delegated_from_id` 与仅协作关联的 parent/root 分开，不由客户端自报层级。不启动停止成员，不创建资源；成员仍不能普通 send/spawn。
- 子责任结果作为持久 note 回到父责任和原委派者，复用消息 outbox、输入屏障和恢复；主控可在账本查看，不强制转述。父报告前子责任须终结；成员可取消自己直接委派的子树，主控可取消任意树。父取消、投递失败取消、成员删除均退役委派后代并同步 pending，不影响 merely related 的其他任务，也不杀共享成员进程。
- 同工作区不同 root 可 question，answer 必须精确反向匹配原问题。source 须归自己且仍开放，历史作者只可回答收到的问题；取消、删除、控制器换绑继续封闭旧问答。跨 root note、工作区越界和读取对方整个任务树仍拒绝。`team peers` 仅提供成员资料和最近非取消责任 ID/状态，不泄露任务正文。
- `report --success|--failed` 真正声明 outcome，沿用 HTTP status 输入；省略为 null，旧历史不猜结果。outcome 独立于 reported/cancelled；账本、关联摘要、UI数据接口、外部 read_reports 均可读。部分未达验收以 failed 和报告文字描述，不另增状态机。
- 外部控制器沿用宿主绑定的 read_reports/ack_reports 消费通知，不使用成员邮箱 ACK 冒充输入确认。新增 `action=question`（question_id）查询和 `action=reply`（question_id/text/operation_id）短回复；读操作校验当前宿主绑定，写操作复用幂等记录和原问答权限。两种 ACK 的含义不可混用。
- 存储版本46仅增加所需字段和邮箱表，保留旧数据；完整协议/migration 回归和恢复检查后才可交付。升级正式运行库前保留一致备份，回退需要对应旧库快照，禁止直接删除新历史。

问题写入回执丢失恢复：`team ask --list [--dispatch D] [--before Q]` 返回当前认证成员自己发送的问题，每页最多 50 条及 `next_before` 游标；HTTP `POST /api/team/questions` 使用 `dispatch_id` / `before_id`，只筛选当前工作区和发送者。跨 root 提问者不因此获得目标整棵任务树的读取权。找到 ID 后使用 `team ask --resume Q`，不得自动重发问题。
