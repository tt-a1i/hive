# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hive 是什么

**Hive** 是一个浏览器端的多 CLI agent 协作工作台。用户在 web UI 里组建一个 agent 团队：一个 **Orchestrator**（任意 CLI agent，如 Claude Code/Codex/OpenCode/Gemini）跟用户对话、维护任务图、给 worker 派单；多个 **Worker**（也是 CLI agent，可定义角色）执行任务并通过 `team report` 命令汇报。所有 agent 都运行在 Hive 管理的 PTY 中，由浏览器里的 xterm.js 显示。Codex CLI 可以担任这两种角色。

核心隐喻是蜂巢：Orchestrator 是蜂后，Worker 是工蜂，任务图是蓝图。

## 当前进度

- `tt-a1i/hive` 是唯一开发、issue、PR 和发版仓库，包含尚未发布的实现和 `gateway/` 源码。
- 开发与验证遵守 `AGENTS.md`；发版前读 [`docs/release.md`](./docs/release.md)，部署 gateway 前读 [`docs/deploy-runbook.md`](./docs/deploy-runbook.md)。
- 历史设计见 [`docs/superpowers/specs/2026-04-18-hive-design.md`](./docs/superpowers/specs/2026-04-18-hive-design.md)，协作协议还需读下方的后续修订。
- 源码公开不改变 BSL 许可证。运行数据、部署密钥和个人调试产物保留在仓库外。

## 当前工作重点

聚焦桌面端的组队、派单、汇报和终端稳定性。开发与发版按 [AGENTS.md §0.1](./AGENTS.md) 执行风险分层验证。

## 关键设计决策（速查，避免重读全文）

协作协议、角色提示、消息投递、报告或恢复改动先读 [2026-09-05 协作修订](docs/superpowers/specs/2026-09-05-task-collaboration.md)：用户提供成员，任务内交流不结算，关联责任受限直达，报告显式确认新增输入。

| 主题 | 决策 |
|---|---|
| 形态 | Web app（浏览器 + 本地 Node runtime，绑定 127.0.0.1，**常驻服务，不绑定项目目录**） |
| Workspace 模型 | sidebar 多 workspace（cmux 风格），主区一次只看一个，所有 PTY 后台并行 |
| 添加 workspace | OS 系统目录选择器 + 手动粘贴路径，持久化到 SQLite |
| Orch 与 Worker 关系 | 都是 PTY 里的 CLI 子进程，每个 agent 隶属于一个 workspace；差异只在角色 prompt + 工具白名单 |
| 跨 workspace | 完全隔离：不能跨 workspace 派单/查询/通信 |
| 通信协议 | `team` CLI 子命令（`team send` / `team cancel` / `team report` / `team list`），异步无阻塞 |
| 派单传输 | 系统拦截 `team send` → 按约定 prompt 模板注入目标 worker 的 stdin |
| 汇报回灌 | worker 调 `team report` → 系统作为系统消息注入 orch 的 stdin |
| 路由信息 | 每个 PTY 注入 env: `HIVE_PORT + HIVE_PROJECT_ID + HIVE_AGENT_ID` |
| `team` CLI 部署 | **PATH prepend** 注入到 PTY env（不全局安装），自带 `<hive-pkg>/bin/team`，零污染用户系统 |
| Crash 恢复模型 | 4 种场景明确（§3.5.1：单崩 / 主动停 / 正常 exit / runtime 重启）。两层引擎：**Layer A** 用 CLI 原生 session resume（CC `--resume <id>`），完整恢复对话；**Layer B** fallback 摘要换班（拼装 messages + .hive/tasks.md + worker 状态注入 stdin）。Hive runtime 重启**不自动启动** agent，提供 [Restart] / [Restart All] 按钮 |
| Agent 状态机 | 仅 `working` / `idle` / `stopped` 三态（§3.6）。状态完全由协议事件驱动：send → working、report/cancel → idle（pending_count 归零时）、PTY exit → stopped。**不变量（2026-06-12 收窄）：runtime 永不改变 agent 状态、永不自动操作**——没有改状态的超时/卡死检测；卡死的 agent 持续显示 working，由用户判断 |
| 角色模板 | **4 个内置**（1 Orchestrator + 3 Worker：Coder / Reviewer / Tester）+ 用户自定义；MVP 不内置 Architect（语义跟 Orch 重叠）。Orchestrator 模板系统级唯一、不出现在 Add Worker 列表；其他可"复制为自定义"修改 |
| 兜底 | **runtime 不做静默判定**——worker 必须显式 report，否则视为未完成；没有孤儿/久静自动观察角色，runtime 不据此行动 |
| 任务图 | 每个 workspace 的项目根 `.hive/tasks.md`（GFM task list），文件 watch 同步 UI |
| 工作目录隔离 | **默认共享 workspace 根**，冲突由 orch 拆分负责。唯一例外：workflow 脚本 `agent(prompt, { isolation: 'worktree' })` 按调用 opt-in，把该临时成员放进 tmpdir 下的 git worktree（分支 `hive/wf-*`），报告尾部带 `<hive-worktree .../>` 告知要合并的分支；`team spawn` / 常驻成员不提供 worktree |
| 默认权限 | YOLO 模式（自动跳过 CLI agent 的权限确认） |
| 远程访问形态 | **可选的云端 gateway**（默认关）。"no cloud / 仅 127.0.0.1" non-goal 的正式反转。云端**只做身份 + 路由**，数据与执行永在本机；gateway 不可用时本地一切照常。daemon 主动出站连 wss，不开端口。手机端 ↔ daemon 间 **E2E 加密**（X25519 + HKDF + XChaCha20-Poly1305），gateway 是 opaque relay 只见密文。诚实局限：手机端 crypto bundle 由 gateway 分发（同 Proton/WhatsApp Web 的 TOFU/SRI 边界）。daemon 侧 gateway URL 可配置（**self-host 自己的 gateway 也能用**） |
| 远程权限模型 | 配对成功的手机 = 本地浏览器**等权**，不做手机专属权限子集（功能裁剪是安全剧场）。安全全在**设备/会话级**：OAuth、扫码配对、桌面确认、吊销、审计、总开关。**信任根例外**（配对仪式，禁止后续当"不一致"修掉）：新设备配对审批**只能在桌面**完成；Remote 总开关远程可关不可远程开。tunnel 代理边界仅 `/api/*` `/ws/*`（回环桥接路径白名单） |
| gateway 代码归属 | `gateway/`（独立 package.json，`private: true`）源码随主仓公开；独立部署，不进 npm tarball。CF Workers + DO + D1，OAuth + opaque relay + 限流。部署见 `docs/deploy-runbook.md` |

## 参考项目

实现时大量借鉴这两个外部项目的设计。**它们不在本仓库内**，需要时用绝对路径访问：

### `/Users/admin/code/agent-kanban/kanban/` — Cline 出品的开源 kanban

借鉴：
- **node-pty + xterm.js + WebGL** 的标准集成范式
- **WebSocket 流控**：4ms 批发送、<256B 直发、16KB/100KB 双水位线、客户端 `output_ack` 反压（见 `kanban/src/terminal/ws-server.ts`）
- **一 PTY 多观众**：服务端 `TerminalStateMirror` 用 headless xterm 做 scrollback（10K 行），多浏览器 tab 同时观看
- **Hook 驱动状态机**：agent 主动调命令上报状态（不解析 stdout 正则）—— Hive 的 `team report` 同源思想
- **技术栈**：React + Vite + Tailwind v4 + Radix UI + tRPC 11 + Biome + Vitest
- 工程实践：`kanban/AGENTS.md` 里的 TypeScript 规范、web-ui 设计 token、终端集成踩坑笔记很值得读

不借鉴：1 卡 1 agent 的模型、每任务 worktree、`@clinebot/*` SDK 依赖。

### `/Users/admin/code/golutra/` — Tauri + Vue 的多 agent 桌面应用

借鉴：
- **Per-agent 派单串行队列**：每个 worker 一条命令链，避免消息交错（见 `src-tauri/src/terminal_engine/session/mod.rs:280` 合并逻辑）
- **派单时 prompt 注入约定**：每次派单都把"角色 + 完成约定 + 任务"包成模板（user 直接确认要这套体验）
- **32 项队列上限 + 128 条去重窗口**
- **语义提取兜底**（golutra 用，Hive **不用**，但要知道这个工程可能性，未来如果 worker 不调 `team report` 可能用得上）

不借鉴：Tauri 桌面端形态、前端当 orchestrator（Hive 的 orch 也是 PTY 里的 CLI agent，跟 worker 平级）。

## 预期技术栈

实现期会用：
- Node.js 22+ ESM
- React 19 + Vite 6
- Tailwind CSS v4 + Radix UI
- tRPC 11 + WebSocket（终端流）
- node-pty + xterm.js（含 WebGL addon）
- better-sqlite3 + Drizzle ORM（项目元数据/角色模板/对话历史）
- chokidar（监听 `.hive/tasks.md`）
- Biome + Vitest
- commander（`hive` 主命令 + `team` 子命令）

完整技术栈和理由见 design spec 第 9 节。

## 工作流约定

- 实现阶段必须先用 `superpowers:writing-plans` 出 plan，再用 `superpowers:executing-plans` / `superpowers:subagent-driven-development` 执行
- 每个里程碑用 `superpowers:requesting-code-review` 自检
- `harnessed:*` 系列做完成前的 QA 闸门
- **测试节奏 — 风险分层，不默认全量**：迭代 / 改单点时只跑相关测试（`pnpm exec vitest run <file>`）+ 必要的 `pnpm check` / `pnpm build`，秒级反馈。发版默认 fast gate 是 `pnpm check && pnpm build && pnpm pack:check && pnpm pack:smoke`，再按改动风险补少量核心集成测试。完整 `pnpm test` 只在 AGENTS.md §0.1 的高风险场景、nightly/CI、稳定大版本或用户明确要求时跑。
- Brainstorming 已完成，**spec 有变更先在对话里跟 user 达成一致**再改文档

## TDD 纪律（重点摘，全文见 `AGENTS.md` §3）

**测试范围**：UI（`web/`）不写测试，以 `tsc` + `biome` + `build` + 真机走查为准；测试只覆盖核心逻辑（server store / 协议路由 / CLI / 状态机 / 注入与恢复）。

TDD 不是拖慢效率，假 TDD 才是。两条硬规则：

1. **集成测试（`tests/server/*` + `tests/cli/*`）禁止 mock PTY / node-pty**——违者按假测试删，不改名。要测单纯逻辑去 `tests/unit/`。
2. **每条 assert 必须自问一遍："产品代码完全写反，这断言还能过吗？"** 过得了就是假测试：`not.toThrow()` × N、恒真数组、trivially 过的 not.toContain、断言自己喂进去的 mock 调用——看见即删。

## Agent skills

### Issue tracker

GitHub Issues @ `tt-a1i/hive`（gh CLI）。开发问题和未发布功能统一在此跟进；安全报告按 `SECURITY.md` 私下提交。See `docs/agents/issue-tracker.md`.

### Triage labels

五个 triage 角色 = 默认标签名，已全部建在仓库里。See `docs/agents/triage-labels.md`.

### Domain docs

单 context：根目录 `CONTEXT.md` + `docs/adr/`（均待 `/grill-with-docs` 惰性创建）。See `docs/agents/domain.md`.

## 第一性原理与懒惰高级工程师纪律

懒惰是高效，不是马虎。最好的代码是不用写的代码。找问题时先从第一性原理追真实链路和根因，不许用表面现象、固定等待、局部兜底或只修 ticket 命中的单一路径糊弄过去。

写代码前，先理解任务和相关代码，端到端 trace 真实流程，然后按下面梯子停在第一个能站住的层级：

1. 这个东西真的需要做吗？先判断 YAGNI。
2. 代码库里是否已经有 helper、util、模式或同类实现？优先复用，不重写。
3. 标准库是否已经解决？用标准库。
4. 原生平台能力是否已经覆盖？用平台能力。
5. 已安装依赖是否已经解决？用现有依赖。
6. 能不能一行解决？能就一行。
7. 最后才写最少、能工作的代码。

Bug fix 必须修根因，不修症状。用户报告的是 symptom；动某个函数前，grep 它的所有 caller，找共享入口，尽量在共享函数修一次。一个正确的 guard 通常比每个 caller 各补一刀更小、更稳；只修 ticket 点名路径会留下 sibling caller 继续坏。

规则：

- 不新增用户没明确要求的抽象。
- 能避免就不加新依赖。
- 不写没人要求的 boilerplate。
- 删除优于新增，朴素优于 clever，文件越少越好。
- 最短可工作 diff 胜出，但前提是理解了问题；不理解时的小 diff 是第二个 bug。
- 复杂请求要反问：你真的需要 X，还是 Y 已覆盖？
- 两个标准库方案一样短时，选 edge-case-correct 的；懒惰是少代码，不是弱算法。

不能懒的地方：

- 理解问题：读完整任务，追真实流程，再选梯子层级。
- trust boundary 的输入校验。
- 防止数据丢失的错误处理。
- 安全、可访问性。
- 真实硬件/平台校准：平台从来不是理想 spec，时钟会漂、传感器会偏、移动网络会抖。
- 用户明确要求的事项。

非平凡逻辑必须留下一个最小可运行检查：一个断言式 demo/self-check 或一个小测试文件即可，少框架、少 fixture。简单一行改动不需要测试。
