# Hive 设计文档

**日期**：2026-04-18
**状态**：Draft / Pending review
**作者**：brainstorming session

---

## 1. 是什么

**Hive** 是一个面向多 CLI agent 协作的浏览器端工作台。用户在一个 Web UI 里组建"agent 团队"——一个 Orchestrator 负责跟用户对话、拆解需求、维护任务图、给 worker 派单；多个 Worker 各司其职执行任务并把结果汇报给 Orchestrator。所有 agent 都是真实的 CLI 进程（Claude Code / Codex / OpenCode / Gemini / 自定义命令），通过 PTY 在浏览器里以终端形态展示。

**对比定位**：

- 跟开源 [`kanban`](https://github.com/cline/kanban)：kanban 是「1 卡 = 1 agent」、卡之间不通信；Hive 是「多 agent 一团队、orch 编排、worker 执行、互相能喊话」
- 跟 [`golutra`](https://github.com/.../golutra)：golutra 的 orchestrator 是 Vue 前端 UI 自己；Hive 的 orchestrator 也是一个 PTY 里的 CLI agent，跟 worker 平级

**核心隐喻**：蜂巢。Orchestrator 是蜂后，Worker 是工蜂，任务图是蜂巢蓝图。

---

## 2. 用户场景

```
1. 用户在某个项目目录下启动 Hive：
   cd ~/projects/my-app && npx hive

2. 浏览器自动打开，左侧是 Orchestrator 的 PTY（默认起一个 Claude Code）
3. 用户：「帮我给这个项目加上用户登录功能」
4. Orch 跟用户讨论需求、确认范围
5. Orch 把任务图写进 ./tasks.md：
   - [ ] 设计 schema
   - [ ] 实现登录接口
   - [ ] 写单元测试
   - [ ] code review
6. 用户在右侧添加 worker：
   - "Alice" 角色 = Coder，启动命令 = claude
   - "Bob" 角色 = Tester，启动命令 = codex
   - "Eve" 角色 = Reviewer，启动命令 = claude
7. Orch 调 `team send Alice "实现登录接口"` 派单
8. 系统把任务以约定 prompt 注入 Alice 的 stdin
9. Alice 干活，干完调 `team report "已实现 POST /login，文件: src/auth.ts"`
10. 系统把汇报注入 Orch 的 stdin
11. Orch 收到后更新 tasks.md，再派单给 Bob 写测试
12. 整个过程用户全程旁观，可随时打断、改任务图、给任意 worker 直接发消息
```

---

## 3. 核心概念

### 3.1 Agent

一个真实的 CLI 进程，跑在 PTY 里。Hive 不区分"orch"或"worker"的进程类型——**所有 agent 都用同一个启动框架**，差异只在三处：

1. **角色描述**（system prompt 注入）
2. **可用工具白名单**（哪些 `team xxx` 命令可调）
3. **UI 位置**（orch 在左侧固定栏，worker 在右侧网格）

### 3.2 Role Template（角色模板）

定义一个 agent 怎么启动、扮演什么角色。字段：

```
- name           显示名（如 "Alice"）
- avatar         头像（emoji / 颜色块 / 上传图）
- role           角色类型（Orchestrator / Coder / Reviewer / Tester / Architect / Custom）
- description    角色描述（每次派单时注入到 prompt 顶部）
- command        启动命令（如 "claude"）
- args           启动参数数组
- env            环境变量
```

**预置角色模板**（MVP 内置 4 个）：
- Orchestrator：默认启动 Claude Code，能调全部 `team` 命令；角色描述中明确指示"维护项目根目录的 `tasks.md`，根据用户需求拆解和更新任务"
- Coder：能调 `team report`，专精实现
- Reviewer：能调 `team report`，专精审查/批评
- Tester：能调 `team report`，专精测试

**预置启动命令**（MVP 内置 4 个）：CC、Codex、OpenCode、Gemini，都默认 YOLO 模式（自动跳过权限确认）。用户可填自定义命令。

**用户视角不暴露**：工作目录（=项目根，硬编码）、工具白名单（系统内部控制）。

### 3.3 Communication Protocol

#### 3.3.1 调用层：`team` CLI 子命令

Hive 在 PATH 里安装 `team` 命令，所有 agent 都能调。

```bash
# Orchestrator 可用
team send <worker-id> "<task>"        # 派单给指定 worker（异步，立即返回；worker 完成时通过 stdin 回灌）
team list                             # 列当前所有 worker 和状态（JSON 输出）

# Worker 可用
team report "<result>" [--success|--failed] [--artifact <path>]

# 所有 agent 可用
team help
```

**`team send` 是异步**——调用立即返回，worker 完成后通过 stdin 注入回灌给 orch。MVP 不提供 `team await` 阻塞 API，原因：CLI agent 阻塞等待会卡住自己的 PTY，体验差；orch 只要"派完单等待回灌"即可，模型擅长这种异步流。

`team` 实质是个薄客户端，把命令打到本地 Hive runtime 的 HTTP/Unix socket。

#### 3.3.2 派单时的 prompt 注入

`team send Alice "实现登录"` 时，系统**不是**把 raw text 塞进 Alice 的 stdin，而是先包一层模板：

```
[Hive 系统消息：来自 @Orchestrator 的派单]

你的角色：<Alice 的角色描述>

你必须遵守：
- 完成任务后，执行 `team report "<结论>" --success`
- 失败请 `team report "<原因>" --failed`
- 不要做无关的事，做完就 report

任务内容：
实现登录
```

worker 不需要预先训练，每次派单都重申一遍约定。

#### 3.3.3 回灌：worker → orch

worker 调 `team report` 时，系统拦下来，包成系统消息注入 orch 的 stdin：

```
[Hive 系统消息：来自 @Alice 的汇报，状态: success]
已实现 POST /login，文件: src/auth.ts
artifact: src/auth.ts
```

#### 3.3.4 不做的事

- ❌ 心跳/进度上报（`team status` 不存在）
- ❌ 静默检测兜底（worker 必须显式 report，否则就是没完成）
- ❌ MCP / 共享文件 / 消息总线（这些跟 CLI 命令重叠或体验差）
- ❌ Worker → Worker 直接通信（必须经 orch 中转）

### 3.4 Task Graph（任务图）

任务图就是项目根目录下的 **`tasks.md`**——一份普通的 GFM task list：

```markdown
- [x] 设计 schema @Architect
- [ ] 实现登录接口 @Alice
  - [ ] POST /login
  - [ ] POST /logout
- [ ] 写单元测试 @Bob
- [ ] code review @Eve
```

**关键设计**：
- orch 用 CLI agent 自带的 Read/Write/Edit 工具直接编辑这个文件，**不需要任何特殊命令**
- 系统 watch `tasks.md`，UI 实时同步渲染
- 用户可以在 UI 上直接编辑 markdown（或者用 vim 改），变更被 orch 在下一次被唤醒时自动读到
- 文件本身可以提交到 git，跟代码一起管理

---

## 4. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser (Web UI)                         │
│  ┌──────────────┬──────────────────────────────────────────┐ │
│  │ Orchestrator │  Worker Cards Grid                       │ │
│  │  PTY (xterm) │  ┌──────┐ ┌──────┐ ┌──────┐ [+ Worker]   │ │
│  │              │  │ Alice│ │ Bob  │ │ Eve  │              │ │
│  │              │  └──────┘ └──────┘ └──────┘              │ │
│  │              │  Click → 弹出该 worker 的 PTY            │ │
│  └──────────────┴──────────────────────────────────────────┘ │
│  Top bar: [📋 Task Graph (tasks.md)]                         │
└────────────┬─────────────────────────────────────────────────┘
             │ tRPC + WebSocket
┌────────────▼─────────────────────────────────────────────────┐
│                   Hive Runtime (Node.js)                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ HTTP / WS Server (tRPC + ws)                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────────────────┐      │
│  │ Agent Manager   │  │ Team Command Server          │      │
│  │ - PTY lifecycle │  │ (本地 HTTP/socket)            │      │
│  │ - per-agent 队列│  │ - team send → stdin inject    │      │
│  │ - prompt inject │  │ - team report → orch stdin    │      │
│  │ - status track  │  │ - team list / await           │      │
│  └────────┬────────┘  └──────────────┬───────────────┘      │
│           │                          │                       │
│           ▼                          ▼                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ PTY Pool (node-pty)                                 │    │
│  │  Orch PTY  Alice PTY  Bob PTY  Eve PTY              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ State (SQLite + Drizzle)                            │    │
│  │ - projects / role templates / agents / convos       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ File Watcher (chokidar)                             │    │
│  │ - 监听 tasks.md，变更广播给前端                     │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
             │
             ▼
   `team` CLI binary (装在 PATH，所有 agent 子进程能调)
```

### 4.1 关键模块

- **Agent Manager**：管理所有 PTY 的生命周期、为每个 agent 维护一条派单队列（per-agent 串行 + 去重，借鉴 golutra）。
- **Team Command Server**：本地 HTTP server（默认监听 `127.0.0.1:0` 随机端口），`team` CLI 通过环境变量 `HIVE_PORT` 知道端口。所有 `team xxx` 调用打到这里。
- **PTY Pool**：`node-pty` 跑的所有终端会话。每个 agent 有专属环境变量（`HIVE_AGENT_ID`、`HIVE_PORT` 等），让 `team` 命令能定位"我是谁、汇报给谁"。
- **State**：SQLite 存项目、角色模板、agent 实例、对话历史等关系型数据。任务图本身**不入库**，只存项目根的 `tasks.md`。
- **File Watcher**：watch `tasks.md`，前端实时渲染。

---

## 5. 通信流转示例

**场景**：user 让 orch 实现登录，orch 派单给 Alice，Alice 完成回报。

```
1. user 在 UI 上对 Orch PTY 输入: "帮我实现登录"
   Browser → WS → AgentMgr.write(orch_pty, "帮我实现登录\n")

2. Orch (claude) 思考后调用文件 Edit 工具，更新 tasks.md
   ↓ chokidar 监听到 tasks.md 变化
   ↓ 广播到前端，UI 任务图重新渲染

3. Orch 在 PTY 里执行: team send alice "实现登录接口"
   ↓ team CLI → HTTP POST 127.0.0.1:HIVE_PORT/send
              { from: orch_id, to: alice_id, text: "实现登录接口" }

4. TeamCmdServer 收到 → 调 AgentMgr.injectMessage(alice_id, ...)
   ↓ AgentMgr 把消息包装成 prompt 模板，写入 alice PTY 的 stdin

5. Alice (claude) 干活，调 Read/Edit/Write 修改 src/auth.ts

6. Alice 在 PTY 里执行: team report "已实现 POST /login" --success --artifact src/auth.ts
   ↓ team CLI → HTTP POST 127.0.0.1:HIVE_PORT/report
              { from: alice_id, result: "...", status: "success", artifacts: [...] }

7. TeamCmdServer 收到 → 调 AgentMgr.injectMessage(orch_id, ...)
   ↓ 把汇报包装成系统消息，写入 orch PTY 的 stdin

8. Orch 收到后，决定下一步：
   - 也许更新 tasks.md 标记 [x]
   - 也许 team send bob "为新加的 /login 写测试"
   - 也许直接告诉 user "完成了"
```

---

## 6. 前端 UI 设计

### 6.1 主布局

```
┌──────────────────────────────────────────────────────────────┐
│ Hive  [📁 Project: my-app]  [📋 Task Graph]  [⚙️ Settings]   │
├──────────────────┬───────────────────────────────────────────┤
│                  │                                            │
│  Orchestrator    │  Worker Cards (网格布局)                  │
│  ┌────────────┐  │  ┌──────┐  ┌──────┐  ┌──────┐  [+ Add]   │
│  │ xterm.js   │  │  │Alice │  │Bob   │  │Eve   │            │
│  │ 真实终端   │  │  │Coder │  │Tester│  │Review│            │
│  │            │  │  │🟢work│  │💤idle│  │🔵done│            │
│  │            │  │  │t#3   │  │      │  │t#1   │            │
│  └────────────┘  │  └──────┘  └──────┘  └──────┘            │
│  user > ...      │                                            │
└──────────────────┴───────────────────────────────────────────┘
```

- **左侧栏**：Orchestrator PTY，固定宽度（约 35-40%）。**永久可见**。
- **右侧栏**：Worker 卡片网格，3-4 列响应式。**点击卡片**：弹出该 worker 的 PTY 详情（drawer / 全屏模态）。
- **顶部工具栏**：
  - 项目名（点击切换项目目录）
  - **任务图按钮**：点击展开**右侧抽屉**，显示渲染后的 `tasks.md`，支持点击编辑（保存即写文件）
  - 设置（角色模板管理、启动命令模板等）

### 6.2 Worker 卡片字段

```
┌────────────────────┐
│ [🐝] Alice          │ ← 头像 + 名字
│ Coder · claude      │ ← 角色 + 启动命令
│ ●○○ working         │ ← 状态指示（idle/working/done/error）
│ 「实现登录接口」    │ ← 当前任务摘要（取自最近一次 team send 的 text，截断）
│ 队列: 0             │ ← 待执行任务数
└────────────────────┘
```

### 6.3 添加 Worker 流程

点 [+ Add Worker] 弹对话框：
1. 选预置角色模板（Coder/Reviewer/Tester/Architect/Custom）
2. 起名字 + 选头像
3. 选启动命令（CC/Codex/OpenCode/Gemini/自定义）
4. 确认 → 系统创建实例，立即启动 PTY

### 6.4 任务图抽屉

抽屉打开后默认是**渲染视图**（task list、checkbox 可勾、点行内编辑）。右上角切换按钮可切到**原始 markdown 编辑器**（保存即写入 `tasks.md`）。文件外部变更（orch 修改）实时同步到当前视图，编辑冲突时以最新写入为准（MVP 不做 OT/CRDT）。

---

## 7. 数据模型

### 7.1 SQLite Schema（草案，Drizzle 表）

```typescript
// projects: 用户开过的项目
projects {
  id: string (uuid)
  path: string (项目根绝对路径，唯一)
  name: string
  created_at, last_opened_at
}

// role_templates: 角色模板（预置 + 用户自定义）
role_templates {
  id: string
  name: string
  role_type: enum (orchestrator | coder | reviewer | tester | architect | custom)
  description: string (注入 prompt)
  default_command: string
  default_args: json (string[])
  default_env: json (Record<string,string>)
  is_builtin: boolean
}

// command_presets: 启动命令预设（CC/Codex/OpenCode/Gemini）
command_presets {
  id: string
  display_name: string (如 "Claude Code (CC)")
  command: string (如 "claude")
  args: json (string[])
  env: json
  is_builtin: boolean
}

// agents: 用户在某个项目里创建的 agent 实例（含 orch）
agents {
  id: string
  project_id: string (fk)
  name: string
  avatar: string (emoji or url)
  role_template_id: string (fk, 可选)
  is_orchestrator: boolean
  command: string
  args: json
  env: json
  created_at
}

// agent_runs: 每次启动的 PTY 会话（断开重启等）
agent_runs {
  id: string
  agent_id: string (fk)
  pid: int (nullable)
  status: enum (starting | running | exited | error)
  exit_code: int (nullable)
  started_at, ended_at
}

// messages: 派单 + 汇报历史（用于 UI 时间线、调试）
messages {
  id: string
  project_id: string (fk)
  from_agent_id: string
  to_agent_id: string
  type: enum (send | report | user_input)
  text: string
  status: enum (success | failed) (only for report)
  artifacts: json (string[])
  created_at
}
```

### 7.2 文件持久化

- `<project_root>/tasks.md` — 任务图（用户视角的核心文档）
- `~/.hive/db.sqlite` — 全局元数据
- `~/.hive/logs/` — 调试日志

---

## 8. 安全和工具白名单

虽然 UI 不暴露白名单设置，**系统内部必须有控制**，避免：

- worker 调 `team send` 越权派单（可能形成循环）
- worker 调 `team list` 窥探团队（信息泄露不大但语义不对）

**实现**：`team` CLI 调用时带 `HIVE_AGENT_ID` 环境变量，TeamCmdServer 在执行前查询该 agent 的 role_type，按角色硬编码白名单：

```
orchestrator: { send, await, list, report, help }
worker:       { report, help }
```

YOLO 模式（默认）：所有 CLI agent 启动时自动加跳过权限的参数（CC `--dangerously-skip-permissions`、Codex 对应 flag 等）。Hive 启动器知道每个预置 command 对应的 YOLO flag。

---

## 9. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js 22+ ESM | 跟 kanban 一致，node-pty/xterm 生态成熟 |
| 前端 | React 19 + Vite 6 | 团队已熟，HMR 流畅 |
| 样式 | Tailwind CSS v4 + Radix UI | 跟 kanban 同栈 |
| 后端 | tsx watch (dev) + esbuild (prod) | 简单稳定 |
| API | tRPC 11 + WebSocket | 端到端类型安全 + 终端流 |
| 终端 | node-pty + xterm.js（含 WebGL） | 业界标准 |
| 数据库 | better-sqlite3 + Drizzle ORM | 嵌入式、零配置、SQL 透明 |
| 文件监听 | chokidar | 跨平台稳定 |
| 代码质量 | Biome + Vitest | 一站式 |
| CLI 框架 | commander | `hive` 主命令 + `team` 子命令 |
| 启动 | `npx hive` 或 `npm i -g hive` | 类似 kanban |

---

## 10. MVP 范围

### 10.1 In Scope（首版必须）

1. ✅ 单项目支持（启动时 cwd 即项目根）
2. ✅ Orchestrator + N 个 Worker（同时 ≤6）
3. ✅ PTY 在浏览器渲染（xterm.js + WebSocket）
4. ✅ `team send` / `team report` / `team list` 三个命令
5. ✅ 派单 prompt 注入 + 汇报回灌
6. ✅ Per-agent 派单队列 + 去重（借鉴 golutra）
7. ✅ 任务图 = `tasks.md`，文件 watch + UI 渲染 + 编辑器
8. ✅ 角色模板（4 个预置 + 用户自定义）
9. ✅ 启动命令预置（4 个）+ 自定义
10. ✅ 工具白名单（角色级硬编码）
11. ✅ YOLO 模式默认开

### 10.2 Out of Scope（明确不做）

- ❌ Worktree 隔离（共享根目录，并发冲突由 orch 拆分负责）
- ❌ MCP 工具适配
- ❌ Worker → Worker 直连
- ❌ DAG 编辑器（任务图就是 markdown）
- ❌ 多项目并发
- ❌ 用户认证（本地单用户）
- ❌ 远程访问（绑定 127.0.0.1）
- ❌ 任务图模板市场
- ❌ Agent 性能/成本统计

### 10.3 Open Questions（实现时再决定，不阻塞设计）

1. **npm 包名**：`hive` 大概率被占。候选 `@hive-team/cli` / `hive-cli` / `hivectl`。
2. **`team` CLI 的安装方式**：
   - 方案 A：`hive` 主包 npm 安装时同时把 `team` 软链到全局 bin
   - 方案 B：每个 PTY 启动时 prepend `PATH` 指向项目内的 `node_modules/.bin/team`
   - 倾向 B（隔离干净）
3. **错误恢复**：worker PTY crash 怎么处理？UI 提示 + 卡片标 error，用户决定重启或删除
4. **Orch crash**：可重启，对话历史从 SQLite messages 表回放
5. **同名 agent**：UI 层校验，不允许同项目内重名
6. **`team send` 后 worker 还在忙**：进入 per-agent 队列（golutra 的 32 项上限）
7. **如何让 CLI agent "知道"自己能用 `team` 命令**：第一次启动时往 PTY stdin 注入一段 system 消息，说明可用命令列表

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 多 worker 同时改一个文件（用户拒绝 worktree） | 完全依赖 orch 的拆分智能。MVP 接受这个风险，观察实际表现 |
| CLI agent 不按约定调 `team report`（忘了 / 不理解） | 派单 prompt 模板要明确强调；不行就在角色描述里再强化 |
| `team` CLI 跟用户已有 `team` 命令冲突 | 安装时检测，冲突就改名 `htm` (Hive team) |
| YOLO 模式下 agent 误删文件 | 项目目录内的破坏由 git 兜底；Hive 启动时检测项目是否在 git 仓库内，否则警告 |
| node-pty 在某些平台编译失败 | 跟 kanban 同样的问题，按它的 README 走 |

---

## 12. 后续路线（参考）

按时间从近到远：

1. **MVP**（2-3 周）：上述 In Scope 全做完
2. **v0.2**：MCP 工具支持（给 CC/Cursor 用更顺）；orch 主动给 user 推送（PTY 之外的通知 banner）
3. **v0.3**：Worker 间直接消息（仍经 orch 路由，但 UI 上像点对点聊天）
4. **v0.4**：可选 worktree 隔离（高级开关）
5. **v1.0**：远程协作模式、多项目并发、模板市场

---

## 13. 命名

**Hive** — 蜂巢。LOGO 用六边形，配色金黄/琥珀。
- Orchestrator = Queen Bee 🐝
- Worker = Worker Bee 🐝
- 任务图 = Hive Blueprint
- 项目目录 = Hive

---

## 附录 A：Brainstorming 决策记录

按对话顺序：

| Q | 议题 | 决策 |
|---|---|---|
| Q1 | 起步策略 | 独立仓库 + MVP 风格 |
| Q2 | Orch 跟 user 交互形态 | 像 kanban 一样的 PTY 终端（A） |
| Q3 | 派单机制 | CLI 子命令 (`team send`)（A 方案） |
| Q4 | Worker 汇报机制 | 显式调用 `team report`（风格 2），无静默兜底，无心跳 |
| Q5 | 任务图模型 | markdown todo list（`tasks.md`） |
| Q6 | UI 布局 | Orch 左侧 PTY / Worker 右侧卡片 / 任务图抽屉 |
| Q7-1 | 角色模板字段 | name + avatar + 角色描述 + 启动命令 + 参数/env |
| Q7-2 | 是否预置模板 | 内置 4 个（Coder/Reviewer/Tester/Architect） |
| Q7-3 | Orch 是否走模板系统 | 是（统一框架） |
| Q8 | 工作目录隔离 | 共享根目录，不做 worktree |
| Q9-1 | 任务图操作命令 | 不需要，orch 直接编辑 `tasks.md` |
| Q9-2 | 任务图 UI | markdown 渲染 + 编辑器 |
| Q10 | 形态 | Web app（浏览器） |
| Q11 | 项目名 | Hive |
| - | 启动命令预置 | CC / Codex / OpenCode / Gemini（去掉 Cline） |
| - | 工作目录字段 | 不暴露，硬编码 = 项目根 |
| - | 工具白名单 | 不暴露，系统内部硬编码 |
| - | 权限模式 | 默认 YOLO |
