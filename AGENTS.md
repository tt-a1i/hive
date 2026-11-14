# AGENTS.md — Hive 开发约定

## 项目与文档权威

Hive 是浏览器中的本地 CLI agent 协作工作台：Orchestrator 与 Worker 都运行在 runtime 管理的 PTY 中，通过 `team` 派单、交流和汇报。当前优先保障桌面组队、派单、汇报与终端稳定性。

`tt-a1i/hive` 是唯一开发、Issue、PR 和发版仓库，包含未发布实现及独立部署的 `gateway/`。源码公开不改变 BSL 许可证；运行数据、密钥和个人调试产物放在仓库外。

文档冲突按以下顺序处理；现行规范仍模糊时先问用户，不自行改变协议：

1. 本文件：工程与验证约束。
2. 专题现行规范：[CONTEXT.md](CONTEXT.md) 定义术语；[设计决策](docs/design-decisions.md) 定义架构边界；[任务内协作修订](docs/superpowers/specs/2026-09-05-task-collaboration.md) 定义派单、交流与水位协议。
3. [基线设计](docs/superpowers/specs/2026-04-18-hive-design.md)：仅未被现行规范覆盖的章节有效，引用章节或标题，不依赖易漂移的行号。
4. 已通过 review 的现有实现：用来查模式，不能覆盖上述约束。

按任务加载资料：

- 修改协作协议、角色提示、投递、报告或恢复前，读任务内协作修订与 `CONTEXT.md`。
- 修改 Remote / `gateway/`、远程终端或加密桥接前，读设计决策与 [远程访问](docs/remote-access.md)；部署前再读 [部署手册](docs/deploy-runbook.md)。
- 发版前读 [发版手册](docs/release.md)。创建、分拣或标记 GitHub Issue 前读 [Issue tracker](docs/agents/issue-tracker.md) 与 [Triage labels](docs/agents/triage-labels.md)。
- 领域术语或设计决策改动读 [领域文档指引](docs/agents/domain.md)。深度审查按下方触发条件读 [审查流程](docs/agents/milestone-review.md)。

## 新功能准入：真实问题三问

任何新 feature、命令、提示词规则、store 或 UI 面板的 Issue / plan / PR，必须逐条回答：

1. 具体的人在具体的时刻遇到了什么？写场景，不写“用户想要多 agent 协作”这类叙事。
2. 做完后那个时刻有什么可观察差异？给出步骤、时长、错误率或具体命令/界面变化。
3. 不做会怎样？若“也没什么”，就不做。

修 bug、删代码、减默认义务、补度量不触发此门槛。背景见 Discussion #76、Issue #75。多 agent 仅在互不冲突的并行分支节省时间，或独立审查/验证提高质量时有净收益；其余跳转默认是成本。

## 核心契约

- Workspace 相互隔离，不跨 workspace 派单、查询或通信。默认共享 workspace 根，由 Orchestrator 分配不冲突的职责；仅 workflow 的 `agent(prompt, { isolation: 'worktree' })` 可按调用选择临时 worktree，常驻成员与 `team spawn` 不提供此能力。
- Agent 仅有 `idle / working / stopped` 三态，由协议事件驱动。send → working；report/cancel 在 pending 归零时 → idle；PTY `onExit` 同步把 AgentSummary 与 live run 置 stopped。禁止根据超时或输出静默猜测完成、自动改状态。
- runtime 重启后不自动启动 agent，由用户选 Restart / Restart All。恢复优先使用 CLI 原生 session，摘要恢复保留真实任务、消息与成员现场。
- `team` 只通过 PTY 的 PATH prepend 提供，不全局安装。PTY 路由环境为 `HIVE_PORT`、`HIVE_PROJECT_ID`、`HIVE_AGENT_ID`、`HIVE_AGENT_TOKEN`；不得记录或输出 token。
- `team send` 按成员 name 寻址，不要求模型拼内部 UUID。命令全集与参数查 `src/cli/team.ts` / `team guide`；send 异步，`ask --wait` 可阻塞，不能把所有子命令概括为异步。
- HTTP/JSON 协议字段使用 snake_case（如 `pending_task_count`）；TS 内部可用驼峰，序列化时转换。请求必须验证 workspace、成员身份、token 与角色权限，遵守 `src/server/team-authz.ts`。
- 保留历史 messages 的 `user_input | send | report` 契约；任务内账本支持 `note | question | answer | progress` 与 `seen_seq` 水位屏障。交流不结算派单，report 必须确认新增输入，不能降级成 send。
- 配对手机与本地浏览器等权，但新设备审批只能在桌面完成，Remote 远程可关不可开。tunnel 桥接只允许 `/api/*`、`/ws/*`；gateway 只做身份与密文转发，本地执行与数据留在本机，gateway 不可用不影响本地工作。

## 实现与数据纪律

- 改函数前查全部 caller，沿真实流程定位共享根因；优先复用现有实现、标准库和依赖，做最小完整修复。不要用固定等待或局部兜底掩盖问题，不新增未要求的抽象或依赖。
- 开工检查即将修改的模块有无违反这些约束的代码；修复本任务相关问题，无关存量问题另行记录，不混入当前改动。
- 生产代码只走真实路径，不为测试增加 fallback 或命令分支。异常按类型/code 处理，不通过错误 message 字符串匹配吞错；信任边界校验与防丢数错误处理不可省。
- DB 写入成功后再改内存，或用 transaction 保持一致。ID 用 `crypto.randomUUID()`；安全随机 token 用 `crypto.randomBytes()`，不用 `Math.random().toString(...)` 造 ID。
- SQLite 使用 `src/server/sqlite.ts` 的 `node:sqlite` 封装；`better-sqlite3` 仅用于历史驱动兼容测试。
- Schema 变更统一在 `src/server/sqlite-schema.ts` 注册版本迁移并维护 `schema_version`，不在各 store 的业务路径自行 ALTER。禁止无迁移 drop+recreate 丢历史；有意退役表也必须说明数据影响、备份/回退步骤，并验证旧库升级（含 `tests/unit/sqlite.test.ts` 与 legacy 驱动校验）。
- HTTP 路由按领域使用 `RouteDefinition[]` 注册，不继续堆 `if + 正则` 分发。
- 新源码文件目标 ≤400 行，硬门禁为 >500 行。对 >600 行的存量文件添加功能时，新增职责拆入独立模块，不能通过泛化 helpers 继续堆砌；小修允许不增长。增量门禁阻止超过 600 行的文件净增长，按职责审查仍不可省。
- 静态门禁运行 `node scripts/check-engineering.mjs`，默认相对 HEAD；CI 用 `--base <PR-base-SHA>`。检查 PTY mock、随机 ID 语法及源码行数增长。它不能证明迁移安全、覆盖所有动态 stub 或替代行为测试。

## 风险分层验证

所有 Vitest 测试经 `pnpm test <file...>`（`scripts/run-tests.mjs`）运行，隔离 `HIVE_DATA_DIR`、HOME 与 CLI 配置目录并清理进程组。禁止裸跑 vitest 或 `pnpm exec vitest`；监听模式用 `pnpm test <file> --watch`。

- 本地默认跑相关测试；静态检查为 `pnpm check`（Biome）与 `pnpm exec tsc --noEmit`，按改动需要跑 `pnpm build`。仅改文档可不跑构建或产品测试，但需检查链接与过时指令并说明。
- 核心协议、dispatch ledger、SQLite migration、PTY 生命周期、workflow、remote/gateway 安全与 release packaging 改动，必须有相应真实集成/回归测试，不能只靠 build。
- 纯样式/布局改动不补脆弱 DOM 测试，以静态检查、build 与实际交互走查为主。保留已有有效 `tests/web/` 覆盖；前端状态、协议解析、恢复或 Hook 行为改动跑相关测试，CI 按依赖选择已有测试。
- 发版快检为 `pnpm release:dry`，另外跑类型检查、工程门禁及受影响核心集成测试；完整内容以发版手册与 package scripts 为准。
- 全量 `pnpm test` 只用于大范围共享代码或协议改动、schema/migration 改动、runtime/PTY/workflow/remote 安全边界大改、稳定大版本、nightly/CI 或用户明确要求。不要把定向 `pnpm test <file>` 误解成全量。
- 交付列实际命令、结果、未跑项与原因、剩余平台/设备风险。测试通过不能代替真实用户流程或证明未测平台可用。

### 测试质量

- 非平凡核心逻辑先写失败的行为回归再修实现，覆盖本次涉及的错误路径，例如成员不存在、DB 失败、PTY 启动失败、并发 stop、send 时 agent 已 exit。单行文案、纯格式或无行为变化的简单改动不强制补测试。
- 新增核心功能至少有一条真 HTTP server + 真 store（含 SQLite）+ 真 PTY（涉及时）的穿透测试。开发工具门禁则用真实子进程/临时 Git 仓库验证输入、输出和失败退出码，不人为启动无关 runtime。
- `tests/server/`、`tests/cli/`、`tests/integration/` 禁止 mock/stub PTY（实际包为 `@lydell/node-pty`），包括 helper、spawn、IPty 的等价替身。纯逻辑 PTY 单测放 `tests/unit/`，可用 `tests/helpers/mock-node-pty.ts`；不得称为集成/hardening/e2e。
- 前端组件单测可隔离网络，但 mock fetch 不能当作前后端/CLI↔server 契约证据。断言用户可见结果或真实状态变化，不只断言自己提供的 mock 调用。
- 每条断言都检查“实现完全写反还能过吗”。空断言、仅不抛错、源码字符串断言、恒真数组或无关字段的负向断言不能当测试；错误断言用 class/code。静态门禁可检查语法，门禁自身用违规/合法 fixture 的执行结果验证。
- 不为通过测试改变产品语义。删除假测试须列文件与理由，不能以重命名伪装解决；不批量删除已有有效 UI 测试。

## 审查与交付

四人独立并行审查仅用于稳定大版本验收、核心协议或 Schema 架构重构，或用户显式要求深度互审；日常 bug、小功能、文档与样式调整不强制四人。触发时必须按 [审查流程](docs/agents/milestone-review.md) 完成全部维度及复审门槛。

子代理只在独立并行或独立验证有收益时使用。模型按任务复杂度选择：常规实现/验证默认 `gpt-6.1-terra` medium；复杂跨模块诊断或实质正确性审查用 `gpt-6.1-sol` medium，显式偏好优先。`.codex/agents/*.toml` 保留角色职责，模型由调用方选择或继承，不锁定旧版本。

在 Hive PTY 内只能经 Hive 协议编排：Orchestrator 优先用 `team review` 派独立审查，需自定义成员时用 `team spawn --ephemeral` + `team send`；Worker 用 `team report` 向 Orchestrator 提出协作需要。不得用 CLI 内建子代理替代，否则 Hive UI / stop / cancel 无法管理。

交付前确认：

1. 对原始任务逐项标注完成 / 部分 / 跳过，附证据或原因。
2. 风险匹配的检查已通过；列出改/删的现有代码和测试，以及知道但未做的事项。
3. 每条 review 反馈给出处理 verdict；严重项修复或说明不修的依据与风险，不只挑容易项。
4. 只有触发四人审查的任务才需报告 `## Self-Review` 及各维度 ≥B-；未触发时说明实际检查即可。未满足必要条件不声称完成。
