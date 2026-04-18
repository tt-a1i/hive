# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hive 是什么

**Hive** 是一个浏览器端的多 CLI agent 协作工作台。用户在 web UI 里组建一个 agent 团队：一个 **Orchestrator**（任意 CLI agent，如 Claude Code/Codex/OpenCode/Gemini）跟用户对话、维护任务图、给 worker 派单；多个 **Worker**（也是 CLI agent，可定义角色）执行任务并通过 `team report` 命令汇报。所有 agent 都跑在浏览器里的 xterm.js 终端中。

核心隐喻是蜂巢：Orchestrator 是蜂后，Worker 是工蜂，任务图是蓝图。

## 当前进度

- ✅ Brainstorming 完成（superpowers:brainstorming 流程）
- ✅ Design spec 已写好并 commit：[`docs/superpowers/specs/2026-04-18-hive-design.md`](./docs/superpowers/specs/2026-04-18-hive-design.md)
- 🟡 等用户 review 完进入 `superpowers:writing-plans` 出实现计划
- ⬜ 实现尚未开始，仓库里除了设计文档还没有任何代码

**继续工作时**：先读 design spec（700 行，覆盖架构/协议/UI/数据模型/MVP 范围/风险），再决定下一步。如果 user 已经确认，下一步是 `superpowers:writing-plans`。

## 关键设计决策（速查，避免重读全文）

| 主题 | 决策 |
|---|---|
| 形态 | Web app（浏览器 + 本地 Node runtime，绑定 127.0.0.1，**常驻服务，不绑定项目目录**） |
| Workspace 模型 | sidebar 多 workspace（cmux 风格），主区一次只看一个，所有 PTY 后台并行 |
| 添加 workspace | OS 系统目录选择器 + 手动粘贴路径，持久化到 SQLite |
| Orch 与 Worker 关系 | 都是 PTY 里的 CLI 子进程，每个 agent 隶属于一个 workspace；差异只在角色 prompt + 工具白名单 |
| 跨 workspace | 完全隔离：不能跨 workspace 派单/查询/通信 |
| 通信协议 | `team` CLI 子命令（`team send` / `team report` / `team list`），异步无阻塞 |
| 派单传输 | 系统拦截 `team send` → 按约定 prompt 模板注入目标 worker 的 stdin |
| 汇报回灌 | worker 调 `team report` → 系统作为系统消息注入 orch 的 stdin |
| 路由信息 | 每个 PTY 注入 env: `HIVE_PORT + HIVE_PROJECT_ID + HIVE_AGENT_ID` |
| 兜底 | **不做静默检测、不做心跳**——worker 必须显式 report，否则视为未完成 |
| 任务图 | 每个 workspace 的项目根 `tasks.md`（GFM task list），文件 watch 同步 UI |
| 工作目录隔离 | **不做 worktree**，所有 agent 共享对应 workspace 根，冲突由 orch 拆分负责 |
| 默认权限 | YOLO 模式（自动跳过 CLI agent 的权限确认） |

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
- chokidar（监听 `tasks.md`）
- Biome + Vitest
- commander（`hive` 主命令 + `team` 子命令）

完整技术栈和理由见 design spec 第 9 节。

## 工作流约定

- 实现阶段必须先用 `superpowers:writing-plans` 出 plan，再用 `superpowers:executing-plans` / `superpowers:subagent-driven-development` 执行
- 每个里程碑用 `superpowers:requesting-code-review` 自检
- `harnessed:*` 系列做完成前的 QA 闸门
- Brainstorming 已完成，**spec 有变更先在对话里跟 user 达成一致**再改文档
