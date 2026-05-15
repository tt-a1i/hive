# Hive 设计文档

**日期**：2026-04-18
**状态**：Draft / Pending review
**作者**：brainstorming session

> **[M2 实现说明] 版本说明（v0.2.0-m2）**：本文中的 `[M2 scope 调整]` / `[M2 实现说明]` 是 `v0.2.0-m2` 的正式规范内容，不是临时 release note。M2 签收以这些正文修订后的边界为准；延后到 `M2.5 / M3` 的事项，均以正文标注为准。

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
1. 用户在任意位置启动 Hive 服务（一次性，可开机自启）：
   hive            # 启动常驻服务，浏览器自动开 http://127.0.0.1:<port>

2. 浏览器打开后，Hive UI 出现：
   - 左侧 sidebar：Workspace 列表（首次为空）
   - 主区：欢迎页 / 添加 workspace 引导

3. 用户点 [+ 添加 Workspace]，弹出选择器：
   - 用 OS 系统目录选择器选 ~/projects/my-app
   - 或手动粘贴绝对路径
   Hive 把这个 workspace 持久化到 SQLite，加进 sidebar 列表

4. 用户点击 sidebar 里的 my-app workspace 进入：
   - 主区显示该 workspace 的 Orchestrator PTY（默认起一个 Claude Code，cwd = workspace 路径）
   - 右侧是该 workspace 的 worker 卡片网格（首次为空）

5. 用户：「帮我给这个项目加上用户登录功能」
6. Orch 跟用户讨论需求、确认范围
7. Orch 把任务图写进 my-app/.hive/tasks.md：
   - [ ] 设计 schema
   - [ ] 实现登录接口
   - [ ] 写单元测试
   - [ ] code review
8. 用户在右侧添加 worker（每个 worker 是该 workspace 私有的）：
   - "Alice" 角色 = Coder，启动命令 = claude
   - "Bob" 角色 = Tester，启动命令 = codex
   - "Eve" 角色 = Reviewer，启动命令 = claude
9. Orch 调 `team send Alice "实现登录接口"` 派单
10. 系统把任务以约定 prompt 注入 Alice 的 stdin
11. Alice 干活，干完调 `team report "已实现 POST /login，文件: src/auth.ts"`
12. 系统把汇报注入 Orch 的 stdin
13. Orch 收到后更新 .hive/tasks.md，再派单给 Bob 写测试
14. 整个过程用户全程旁观，可随时打断、改任务图、给任意 worker 直接发消息

并行多项目：
15. 用户在 sidebar 点 [+] 再加一个 workspace ~/projects/other-app
16. other-app 有自己的 orch + worker + .hive/tasks.md，跟 my-app 完全独立
17. 用户在 sidebar 切换两个 workspace（一次只看一个，但所有 workspace 的 PTY 在后台都跑着）
```

---

## 3. 核心概念

### 3.1 Agent

一个真实的 CLI 进程，跑在 PTY 里。Hive 不区分"orch"或"worker"的进程类型——**所有 agent 都用同一个启动框架**，差异只在三处：

1. **角色描述**（system prompt 注入）
2. **可用工具白名单**（哪些 `team xxx` 命令可调）
3. **UI 位置**（orch 在主区左侧固定栏，worker 在主区右侧网格——指当前 workspace 的视图内）

每个 agent 实例都隶属于**某一个 workspace**，跨 workspace 不共享、不通信。

### 3.2 Role Template（角色模板）

定义一个 agent 怎么启动、扮演什么角色。字段：

```
- name              显示名（如 "Alice"）
- avatar            头像（emoji / 颜色块 / 上传图）
- role_type         角色类型（orchestrator | coder | reviewer | tester | custom）
- description       角色描述（每次派单时注入到 prompt 顶部）
- default_command   默认启动命令（如 "claude"）
- default_args      默认启动参数数组
- default_env       默认环境变量
- is_builtin        是否系统内置（true 不可删，可"复制为自定义"）
```

#### 3.2.1 模板分类与可见性

模板分两类，UI 可见性不同：

**A. Orchestrator 模板（系统级，1 个内置）**
- 唯一的 `role_type=orchestrator` 模板
- 描述：维护项目根 `.hive/tasks.md`、根据 user 需求拆解任务、调度 worker；可调 `team send / team list / team report`
- 添加 workspace 时**自动**用此模板创建该 workspace 的 orch agent
- **不出现在 Add Worker 列表**——用户无法手动加第二个 orch
- 不可删，但可在设置页修改 description（默认只读，复制后修改副本）

**B. Worker 角色模板（MVP 3 个内置）**
- 出现在 Add Worker 选择列表 + 设置页可见
- `is_builtin=true`，不可删，可"复制为自定义"修改
- MVP 三个：

  | 模板 | role_type | 描述要点 |
  |---|---|---|
  | **Coder** | coder | 实现功能，写代码；任务完成必须 `team report` |
  | **Reviewer** | reviewer | 审查/批评代码或方案；产出审查意见后 `team report` |
  | **Tester** | tester | 写或跑单元/集成测试；产出测试结果后 `team report` |

**C. 用户自定义模板**
- Add Worker 时选 `Custom...` → 弹完整模板表单（name/description/command/args/env）
- 创建后默认保存为新模板（在该 workspace 可见 + 设置页可见 + 跨 workspace 共享）
- 设置页可编辑/删除自定义模板

**总数对账**：
- 内置 = **4 个**（1 Orchestrator + 3 Worker）
- Add Worker 选择列表 = 3 内置 worker + N 个用户自定义 + 1 个 `Custom...` 入口
- 设置页 = 4 内置（只读 + 可"复制为自定义"）+ N 个自定义（可编辑/删除）

**为什么 MVP 不内置 Architect**：
- 跟 Orchestrator 职能重叠（拆任务、设计架构本就是 Orch 的活）
- "Architect 作为 worker"语义奇怪——它要被派单做架构？
- 用户真需要时自己 Custom 即可

#### 3.2.2 预置启动命令

跟角色模板正交的另一组预置：**启动命令** —— CC / Codex / Gemini 默认带 YOLO 参数（CC `--dangerously-skip-permissions`、Codex 等同 flag）。OpenCode 例外：v1.x 权限模型通过 `~/.config/opencode/opencode.json` 的 `permission` 配置控制，不接受 Claude 风格的 CLI yolo flag。用户可填自定义命令。详见 §7.1 的 `command_presets` 表。

#### 3.2.3 用户视角不暴露

- 工作目录（= workspace 项目根，硬编码）
- 工具白名单（系统按 role_type 硬编码，详见 §8）

### 3.3 Communication Protocol

#### 3.3.1 调用层：`team` CLI 子命令

Hive 给每个 agent PTY 提供一个 `team` CLI，agent 直接在自己的 shell 里调用，跟调用 `ls` `git` 一样自然。

```bash
# Orchestrator 可用
team send <worker-name> "<task>"      # 派单给指定 worker（异步，立即返回；worker 完成时通过 stdin 回灌）
team list                             # 列当前所有 worker 和状态（JSON 输出）

# Worker 可用（flag 顺序任意；长正文用 --stdin 走 quoted heredoc 避免 shell 解析）
team report "<result>" [--dispatch <id>] [--artifact <path>]
team report --stdin    [--dispatch <id>] [--artifact <path>]  # 从 stdin 读正文，配合 <<'EOF' ... EOF
team status "<current status>" [--artifact <path>]            # 无 open dispatch 时汇报接入/待命/阻塞状态，不消耗 pending_task_count
team status --stdin            [--artifact <path>]

# 所有 agent 可用
team help
```

**`team send` 是异步**——调用立即返回，worker 完成后通过 stdin 注入回灌给 orch。MVP 不提供 `team await` 阻塞 API，原因：CLI agent 阻塞等待会卡住自己的 PTY，体验差；orch 只要"派完单等待回灌"即可，模型擅长这种异步流。

`team` 实质是个薄客户端，把命令打到本地 Hive runtime 的 HTTP server。

**`team list` 输出契约**（最小返回结构，单行 JSON 数组到 stdout）：

```json
[
  { "id": "alice", "name": "Alice", "role": "coder",    "status": "working", "pending_task_count": 1 },
  { "id": "bob",   "name": "Bob",   "role": "tester",   "status": "idle",    "pending_task_count": 0 },
  { "id": "eve",   "name": "Eve",   "role": "reviewer", "status": "idle",    "pending_task_count": 0 }
]
```

字段定义：
- `id` — 全局唯一 agent id（同 `agents.id`）
- `name` — 显示名（用户起的）
- `role` — `role_type`（`coder` / `reviewer` / `tester` / `custom`，**不会返回 `orchestrator`**——orch 调 `team list` 时列表只含本 workspace 的 worker）
- `status` — 三态之一：`idle` / `working` / `stopped`（详见 §3.6）
- `pending_task_count` — 已派但未 report 的数量（详见 §3.6.4）

调用方（agent 自查、orch 派单决策、Layer A 环境同步消息构造）都依赖这个结构，**MVP 不再扩展字段**，扩展字段视为非破坏性追加（调用方应忽略未知字段）。

#### 3.3.1.1 `team` CLI 的部署模型（**正式约束，非 Open Question**）

Hive 把 `team` 二进制装在自己的 npm package 内（`<hive-pkg>/bin/team`，跨平台同时提供 `team.cmd` for Windows）。**它不安装到用户全局 PATH**，避免污染用户系统、避免跟用户已有的 `team` 命令冲突。

每个 PTY 启动时，Hive runtime 在子进程的环境变量里 prepend Hive 自带 bin 目录：

```ts
// Hive 启动 PTY 时构造的 env
const env = {
  ...process.env,                              // 继承 Hive runtime 的环境
  PATH: `${HIVE_BIN_DIR}${PATH_SEP}${process.env.PATH}`,  // ⭐ 关键
  HIVE_PORT,                                    // runtime HTTP server 端口
  HIVE_PROJECT_ID,                              // 当前 workspace
  HIVE_AGENT_ID,                                // 当前 agent 身份
  HIVE_AGENT_TOKEN,                             // 当前 live run 的短期鉴权令牌
};
```

效果：
- agent 子进程一执行 `team`，第一个 PATH 命中的就是 Hive 提供的版本
- **任意自定义启动命令都自动获得 `team`**（用户写 `bash -c 'foo bar'` / `claude --xxx` / `python myagent.py` 都行，子进程继承 PATH）
- **所有 workspace、所有预置命令、所有自定义命令统一**——无需各自配置
- 用户的 macOS/Linux shell **看不到** `team` 命令，零污染

`HIVE_BIN_DIR` 在 Hive runtime 启动时通过 `import.meta.url` / `__dirname` 解析定位（runtime 知道自己 package 装在哪）。

**为什么不走全局安装（npm i -g 时软链 team）**：
- 跨平台软链处理麻烦（Windows）
- 多个 Hive 版本共存会冲突
- 用户全局 `team` 名字易撞（生产 CMS / 项目管理工具常用）
- MVP 阶段用户不需要在自己 shell 里调 `team`，只有 agent 内部才需要

#### 3.3.2 派单时的 prompt 注入

`team send Alice "实现登录"` 时，系统**不是**把 raw text 塞进 Alice 的 stdin，而是先包一层模板：

```
[Hive 系统消息：来自 @Orchestrator 的派单]

你的角色：<Alice 的角色描述>

你必须遵守：
- 完成、失败、阻塞或部分完成后，执行 `team report "<完整汇报>"`
- 不要做无关的事，做完就 report

任务内容：
实现登录
```

worker 不需要预先训练，每次派单都重申一遍约定。

#### 3.3.3 回灌：worker → orch

worker 调 `team report` 时，系统必须先找到该 worker 的 open dispatch；找不到则返回 409，避免把待命/接入状态误记为任务完成。找到 open dispatch 后，系统拦下来，包成系统消息注入 orch 的 stdin：

```
[Hive 系统消息：来自 @Alice 的汇报]
已实现 POST /login，文件: src/auth.ts
artifact: src/auth.ts
```

worker 没有 open dispatch 但需要说明接入、待命或阻塞状态时，必须使用 `team status`。`team status` 记录 `status` 消息并尽力注入 orch stdin，但不递减 `pending_task_count`，也不关闭 dispatch。

#### 3.3.4 不做的事

- ❌ 自动心跳/隐式进度上报（只允许 worker 显式 `team status`）
- ❌ 静默检测兜底（worker 必须显式 report，否则就是没完成）
- ❌ MCP / 共享文件 / 消息总线（这些跟 CLI 命令重叠或体验差）
- ❌ Worker → Worker 直接通信（必须经 orch 中转）

### 3.4 Task Graph（任务图）

任务图就是项目根目录下的 **`.hive/tasks.md`**——一份普通的 GFM task list：

```markdown
- [x] 设计 schema @Alice
- [ ] 实现登录接口 @Alice
  - [ ] POST /login
  - [ ] POST /logout
- [ ] 写单元测试 @Bob
- [ ] code review @Eve
```

**关键设计**：
- orch 用 CLI agent 自带的 Read/Write/Edit 工具直接编辑这个文件，**不需要任何特殊命令**
- 系统 watch `.hive/tasks.md`，UI 实时同步渲染
- 用户可以在 UI 上直接编辑 markdown（或者用 vim 改），变更被 orch 在下一次被唤醒时自动读到

### 3.5 Crash 与恢复模型（**正式约束，非 Open Question**）

#### 3.5.1 四种 "agent 不在了" 的场景

| 场景 | 触发 | 应对 |
|---|---|---|
| **A. 单 agent 崩溃** | PTY exit code ≠ 0（CLI bug / OOM / 段错误） | UI 标 `exited`，**不自动重启**；按钮 `[Restart]` / `[Delete]`；点 Restart 走 §3.5.2 恢复流程 |
| **B. 用户主动 stop/delete** | 点 `[Stop]` 或 `[Delete]` | 干净退出，不走恢复；agent 卡片消失或停留在 stopped |
| **C. agent 正常 exit** | exit code = 0（如 codex 完成任务自退） | 同 A，按钮显示 `[Restart]`，无 error 标识 |
| **D. Hive runtime 整体重启** | 用户 cmd+Q、机器重启、`hive` 进程被 kill 后重开 | **所有 agent 卡片显示 stopped**，**不自动启动**（避免一次拉起 N 个 CLI 引发资源风暴）；提供单卡 `[Restart]` + workspace 级 `[Restart All]` 按钮，按钮触发的恢复流程同 §3.5.2 |

B 之外，所有"重启"都走同一个恢复引擎（§3.5.2）。

#### 3.5.2 两层恢复策略

**Layer A：CLI 原生 session resume（首选）**

大多数现代 CLI agent 自带会话持久化能力：

| CLI | resume 命令 | session ID 来源 |
|---|---|---|
| Claude Code | `claude --resume <id>` 或 `claude --continue` | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` 文件名 |
| Codex | `codex resume <id>`（待实测） | stdout 启动 banner 待确认 |
| OpenCode | `opencode --session <id>` | `~/.local/share/opencode/opencode.db` |
| Gemini | 待确认 | 待确认 |

Hive 实现机制：
1. **首次启动 agent 时**捕获 session ID（按预置 command 配置的 `session_id_capture` 规则——监听 stdout 正则 / 监听 ~/.claude 目录新文件等）
2. 把 captured ID 存到 `agents.last_session_id`
3. **重启时**用预置 command 的 `resume_args_template` 拼装命令：
   ```
   原命令: claude
   resume 命令: claude --resume <last_session_id>
   ```
4. agent 进程启动后**完整恢复对话历史 + 工具调用上下文**——它真的"知道之前发生过什么"
5. resume 完成后，Hive 再补一段简短的 **"环境同步" 系统消息** 注入 stdin（agent 的 session 不知道 Hive 外部世界变化）：

> **[M2 scope 调整]** "环境同步"系统消息在 M2 未注入。Layer A resume 目前只用 CLI 原生 `--resume`，不补额外提示。延后到 **M2.5**。

   ```
   [Hive 系统消息：你刚被 Hive 重启了。期间环境变化：
    - 当前 workspace: my-app
    - 现有 worker: Alice (Coder, working 12m), Bob (Tester, idle)
    - .hive/tasks.md 当前内容: <file head 1KB>
    - 重启期间未派新单
    请继续。如果不确定，用 team list / Read .hive/tasks.md 自查或问 user。]
   ```

**Layer B：摘要换班（fallback）**

> **[M2 scope 调整]** Layer B 摘要换班在 M2 未实现，延后到 **M2.5 / M3 前置**。M2 仅实现 Layer A（Claude session resume）。Layer A 失败 / 自定义命令场景，agent 起来时不带历史上下文；用户已知此缺口，发现问题手动 restart 或切换到 Claude CLI。

触发条件：
- 自定义启动命令（用户没配 resume 模板）
- 预置命令但 session ID 没捕获到（首次启动失败 / 文件被删）
- Layer A resume 启动失败（exit code ≠ 0）

机制：系统从 messages 表 + .hive/tasks.md + 现有 worker 列表拼装"前情摘要"注入新 PTY stdin（agent 看到的是一段拼装文本，不是真实历史）：

```
[Hive 系统消息：你是 <workspace> 的 <角色>。
 你刚刚因为崩溃重启，且无法通过原生 session resume 恢复。下面是接力上下文。

 ## 最近 1 小时与 user 的对话（最近 N 条 user_input）
 - user: ...

 ## 你已派出的任务（最近 N 条 send，未收到对应 report 的优先）
 - 派给 Alice: "..." → 等待中（已 8 分钟）
 - 派给 Bob:   "..." → 已 report success「...」

 ## 当前 .hive/tasks.md 状态
 <head 1-2 KB>

 ## 当前活跃 worker
 - Alice (Coder, working 8m)
 - Bob   (Tester, idle)

 请基于此继续。如果不确定，问 user。]
```

**Layer B 摘要的数据来源边界（明确约束）**：

- **只消费** `messages` 表中的 `type ∈ {user_input, send, report, status}` 四类记录 + `.hive/tasks.md` 当前文件 + `team list` 等价的 worker 列表（`agents` 表查 + 内存里的 `pending_task_count`）
- **不消费**也不试图恢复：
  - PTY transcript / agent 输出字节流（不抓不存，详见 §3.5.2 论证）
  - 系统注入的内部消息（如重启提示、`team send` 时的 prompt 包装、`team report` 回灌时的系统消息包装本身）
  - 用户在 UI 上手动给 worker 发的消息（暂不实现该功能；若未来加，再决定是否计入摘要）
- 这意味着实现的人**不需要再补一层 PTY 输出抓取**——messages 表的 3 类事件 + 文件 + 内存计数器已经足够构造摘要

**Layer B 的局限性**（已知接受）：
- 不是真"恢复"，是"接力"——agent 之前的内部推理链丢失
- 摘要里的"已 report" / "等待中"是来自系统的事实，agent 应据此避免重复执行已完成任务
- 拼装文本可能让 agent 误以为是 user 输入；通过明确的 `[Hive 系统消息：...]` 包装区分

#### 3.5.3 实现要点

- `command_presets` 表加两个字段（详见 §7.1）：`resume_args_template` 和 `session_id_capture`
- `agents` 表加 `last_session_id`
> **[M2 scope 调整]** Layer B 在 M2 的实现要点中仍只保留目标设计，实际交付延后到 **M2.5 / M3 前置**。
- MVP **CC 必做 Layer A**（最常用）
- Codex / OpenCode / Gemini 的 Layer A 配置作为实现期调研任务，搞不定就走 Layer B 兜底

#### 3.5.4 Worker 也是同样流程

Worker 跟 Orch 走同一恢复引擎，差异只在系统消息内容（worker 的"环境同步"主要包括：当前 .hive/tasks.md 中跟自己相关的项 + 自己上次 report 之后是否收到新派单 + 当前 orchestrator 是谁）。

### 3.6 Agent 状态机（**正式约束**）

UI 想展示的 worker 状态必须跟协议能力对齐——只看 working / idle / stopped 三态，不假装能感知 agent 内部的"卡住"或"出错"。

#### 3.6.1 三态定义

```
              ┌──────────────┐
              │   stopped    │  ← PTY 进程不在了（4 种来源：A crash / B 主动停 / C 正常 exit / D runtime 重启）
              │  exit_code:N │     不再细分 error vs 正常退出；UI 上统一显示"stopped"
              └──────┬───────┘
                     │ 用户点 [Restart] / 启动新 agent
                     ▼
              ┌──────────────┐
              │     idle     │  ← PTY 活着 + 未完成派单数 = 0
              └──────┬───────┘
        team send ↑  │
       (orch 调)  │  │ team report (worker 调，对应任务 -1，归零回 idle)
                  │  ▼
              ┌──────────────┐
              │   working    │  ← PTY 活着 + 未完成派单数 ≥ 1
              └──────┬───────┘
                     │ PTY exit / 用户 stop
                     ▼
                 (回 stopped)
```

#### 3.6.2 状态来源（哪个事件触发哪个转移）

| 状态/转移 | 触发事件 | 数据来源 |
|---|---|---|
| `stopped` ↔ `idle/working` | PTY 启动 / 退出 | runtime 监听 `node-pty` 的 onData / onExit 回调 |
| `idle` → `working` | `team send <worker-name> ...` | Team Command Server 收到 send 后给目标 worker 的 `pending_task_count += 1` |
| `working` → `idle` | `team report` from worker | Team Command Server 收到 report 后给该 worker 的 `pending_task_count -= 1`，归零则转 idle |
| `pending_task_count`（队列长度展示用） | 同上 | 内存里的计数器，不入库（重启从 messages 表重算） |

`stopped` 时记录 `exit_code` 进 `agent_runs` 表（已有），UI 可用它在 stopped 卡片上小字提示（如 "exit code 1"），但**不据此区分 status**。

#### 3.6.3 已知接受的限制（明确写出来，避免未来回头）

- **卡死的 CLI agent**（PTY 没死、就是不 report）会持续显示 `working`——runtime 不主动判定"超时"
  - 用户视觉上看到一个 working 太久的卡片，**手动点进去看 PTY 自己判断**
  - 决定 kill 就点 [Stop]，决定继续等就关掉详情
- **agent 内部逻辑错误**（例如 CC 卡在 permission prompt）runtime 看不到——YOLO 模式默认应该不会出现
- **不需要自动心跳/进度上报**：runtime 不主动轮询或推断状态；worker 只能显式 `team status` 汇报无派单状态，且不影响 `pending_task_count`
- **将来若需"卡住超 N 分钟告警"**：可作为 v0.2+ 增强，加一层超时计时即可，**不影响当前架构**（渐进可加）

#### 3.6.4 队列长度展示

UI 卡片右下角的"队列: N" 直接读 `pending_task_count`（即"已 send 但未 report 的派单数"）。这跟 §3.3 提到的 per-agent 串行队列共用同一个数据源——队列里有几个派单等着执行，N 就是几。

> **[M2 实现说明]** `pending_task_count` 与 `status` 是两个正交维度。worker 因 crash / stop 进入 `stopped` 后，队列长度仍可能 > 0（例如还有未 report 的派单）。UI 允许出现 `stopped + pending_task_count>0`，直到用户 restart 该 worker 或人工处理积压任务。

---

## 4. 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                       Browser (Web UI)                           │
│  ┌─────────┬──────────────────────────────────────────────────┐ │
│  │Workspace│  当前 workspace 视图（一次只显示一个）           │ │
│  │ Sidebar │  ┌──────────────┬─────────────────────────────┐  │ │
│  │         │  │ Orchestrator │  Worker Cards Grid          │  │ │
│  │ my-app  │  │  PTY (xterm) │  ┌────┐┌────┐┌────┐ [+]    │  │ │
│  │ ●other  │  │              │  │Alice││Bob ││Eve │       │  │ │
│  │ ...     │  │              │  └────┘└────┘└────┘       │  │ │
│  │ [+ Add] │  └──────────────┴─────────────────────────────┘  │ │
│  └─────────┴──────────────────────────────────────────────────┘ │
│  Top bar: [📋 Task Graph (当前 workspace 的 .hive/tasks.md)]            │
└────────────┬─────────────────────────────────────────────────────┘
             │ tRPC + WebSocket
┌────────────▼─────────────────────────────────────────────────────┐
│                     Hive Runtime (Node.js)                       │
│  常驻服务，启动时不绑定任何 workspace，通过 UI 动态加载/创建      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ HTTP / WS Server (tRPC + ws)                           │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────┐  ┌──────────────────────────────┐      │
│  │ Workspace Manager  │  │ Team Command Server          │      │
│  │ - 跟踪所有打开的   │  │ (本地 HTTP, 127.0.0.1:RANDOM) │      │
│  │   workspace        │  │ - team send → stdin inject    │      │
│  │ - 持久化项目列表   │  │ - team report → orch stdin    │      │
│  │ - 当前激活 ws id   │  │ - team list                   │      │
│  └─────────┬──────────┘  └──────────────┬───────────────┘      │
│            │ owns                       │                        │
│            ▼                            ▼                        │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ Per-Workspace Agent Manager（一个 workspace 一组）     │    │
│  │ ┌────────────────────────┐ ┌────────────────────────┐  │    │
│  │ │ Workspace: my-app       │ │ Workspace: other-app   │  │    │
│  │ │ - PTY pool: orch+work*  │ │ - PTY pool: orch+work* │  │    │
│  │ │ - per-agent dispatch q  │ │ - per-agent dispatch q │  │    │
│  │ │ - .hive/tasks.md watcher      │ │ - .hive/tasks.md watcher     │  │    │
│  │ └────────────────────────┘ └────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ State (SQLite + Drizzle, ~/.hive/db.sqlite)            │    │
│  │ - projects / role templates / agents / messages        │    │
│  └────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
             │
             ▼
   `team` CLI binary (装在 PATH，所有 agent 子进程能调)
   每个 PTY 启动时注入 env: HIVE_PORT + HIVE_PROJECT_ID + HIVE_AGENT_ID + HIVE_AGENT_TOKEN
```

### 4.1 关键模块

- **Workspace Manager**：常驻服务，加载持久化的项目列表，按需创建/销毁 per-workspace 的 Agent Manager。
- **Per-Workspace Agent Manager**：每个 workspace 一份，独立管理本 workspace 的 PTY pool、派单队列、.hive/tasks.md watcher。Workspace 之间完全隔离。
- **Team Command Server**：本地 HTTP server（默认监听 `127.0.0.1:0` 随机端口），`team` CLI 通过环境变量 `HIVE_PORT` 知道端口。所有 `team xxx` 调用打到这里，**调用必须带 `HIVE_PROJECT_ID + HIVE_AGENT_ID + HIVE_AGENT_TOKEN`**，server 路由到对应 workspace 的 Agent Manager。
- **PTY Pool**：`node-pty` 跑的所有终端会话，按 workspace 分组。Agent 的 cwd = 该 workspace 的项目根。每个 PTY 启动时注入的 env：
  - **`PATH = <hive-bin-dir>:<原 PATH>`**——让 agent 子进程能找到 `team` 二进制（详见 §3.3.1.1）
  - `HIVE_PORT` —— Team Command Server 端口
  - `HIVE_PROJECT_ID` —— 该 agent 所属 workspace
  - `HIVE_AGENT_ID` —— 该 agent 自身身份（"我是谁"）
  - `HIVE_AGENT_TOKEN` —— 该 agent 当前 live run 的短期鉴权令牌（防伪造）
  - YOLO 标志位 + 启动命令对应的额外 env
- **State**：SQLite 存项目、角色模板、agent 实例、对话历史等关系型数据。任务图本身**不入库**，只存各 workspace 项目根的 `.hive/tasks.md`。
- **File Watcher**：每个 workspace 的 Agent Manager 跑一个 chokidar 监听本 workspace 的 `.hive/tasks.md`，前端只接收**当前激活 workspace** 的变更广播。

> **[M2 scope 调整]** `.hive/tasks.md` watcher 在 M2 未实现，延后到 **M3**。M2 只提供 tasks API + UI 读写，不做文件实时监听/广播。

---

## 5. 通信流转示例

**场景**：user 让 orch 实现登录，orch 派单给 Alice，Alice 完成回报。

```
1. user 在 UI 上对 Orch PTY 输入: "帮我实现登录"
   Browser → WS → AgentMgr.write(orch_pty, "帮我实现登录\n")

2. Orch (claude) 思考后调用文件 Edit 工具，更新 .hive/tasks.md
   ↓ chokidar 监听到 .hive/tasks.md 变化
   ↓ 广播到前端，UI 任务图重新渲染

3. Orch 在 PTY 里执行: team send alice "实现登录接口"
   ↓ team CLI 读 env: HIVE_PORT, HIVE_PROJECT_ID, HIVE_AGENT_ID, HIVE_AGENT_TOKEN
   ↓ HTTP POST 127.0.0.1:HIVE_PORT/send
              { project_id, from_agent_id: orch_id, token, to: "alice", text: "..." }

4. TeamCmdServer 收到 → 路由到 my-app workspace 的 AgentMgr
   ↓ AgentMgr 把消息包装成 prompt 模板，写入 alice PTY 的 stdin

5. Alice (claude) 干活，调 Read/Edit/Write 修改 src/auth.ts（cwd 是 my-app）

6. Alice 在 PTY 里执行: team report "已实现 POST /login" --artifact src/auth.ts
   ↓ team CLI 读 env: HIVE_PORT, HIVE_PROJECT_ID, HIVE_AGENT_ID, HIVE_AGENT_TOKEN
   ↓ HTTP POST 127.0.0.1:HIVE_PORT/report
              { project_id, from_agent_id: alice_id, token, result, artifacts }

7. TeamCmdServer 收到 → 路由到 my-app workspace 的 AgentMgr
   ↓ 找到该 workspace 的 orch，把汇报包装成系统消息写入 orch PTY 的 stdin

8. Orch 收到后，决定下一步：
   - 也许更新 .hive/tasks.md 标记 [x]
   - 也许 team send bob "为新加的 /login 写测试"
   - 也许直接告诉 user "完成了"
```

---

## 6. 前端 UI 设计

### 6.1 主布局

整个 UI 是**三段**结构：左 = Workspace 列表（细），中 = 当前 workspace 的 Orchestrator PTY，右 = 当前 workspace 的 Worker 卡片网格。

```
┌─────────────────────────────────────────────────────────────────┐
│ Hive   [📋 Task Graph]   [⚙️ Settings]                          │
├─────────┬───────────────────────────────────────────────────────┤
│ ws list │ 当前 workspace: my-app  (~/projects/my-app · main)     │
│         ├──────────────────┬────────────────────────────────────┤
│ my-app  │                  │  Worker Cards (网格)               │
│ ●other  │  Orchestrator    │  ┌──────┐ ┌──────┐ ┌──────┐ [+]   │
│ kanban  │   PTY (xterm.js) │  │Alice │ │Bob   │ │Eve   │       │
│ archify │                  │  │Coder │ │Tester│ │Review│       │
│         │                  │  │🟢work│ │💤idle│ │🔵done│       │
│ [+ Add  │                  │  │t#3   │ │      │ │t#1   │       │
│ Workspc]│  user > ...      │  └──────┘ └──────┘ └──────┘       │
│         └──────────────────┴────────────────────────────────────┘
└─────────┴───────────────────────────────────────────────────────┘
```

- **左侧 Workspace Sidebar**（窄列，约 200px）：
  - 列出所有已添加的 workspace，每行显示项目名 / 路径缩写 / 当前 git 分支
  - 当前激活的 workspace 高亮
  - 角标：当且仅当该 workspace 内**至少一个 worker 处于 `working` 状态**时显示绿色脉动点（详见 §6.3 状态视觉规则）；其他状态不显示角标，避免视觉噪音
  - 底部 [+ Add Workspace] 按钮，点击弹添加对话框
- **中间 Orchestrator PTY 栏**：当前 workspace 的 orch 终端，固定宽度（约 35-40% 主区）。永久可见。
- **右侧 Worker 卡片网格**：当前 workspace 的 worker，2-3 列响应式。点卡片弹出该 worker 的 PTY 详情（drawer / 全屏模态）。
- **顶部工具栏**：
  - **任务图按钮**：点击展开右侧抽屉，显示渲染后的当前 workspace `.hive/tasks.md`，支持点击编辑
  - 设置（全局：角色模板管理、启动命令模板等）

**切换 workspace 时**：左 sidebar 选另一个 workspace，中/右两栏立刻切换到该 workspace 的 orch 和 worker 视图。**所有 workspace 的 PTY 在后台持续运行**（包括未激活的），切回去能看到累积的输出。

### 6.2 添加 Workspace 流程

点 [+ Add Workspace]：
1. 弹对话框，两种添加方式：
   - **A. OS 系统目录选择器**（点 "Browse..." 调出原生 picker）
   - **B. 手动粘贴绝对路径**（输入框 + 验证）
2. Hive 校验路径存在 + 是目录（不强制要求是 git 仓库，但若不在 git 内会有 warning：YOLO 模式下没有 git 兜底）
3. 显示项目名（取目录名，可改）
4. 确认 → 持久化到 SQLite projects 表 → 加进 sidebar
5. 自动创建一个默认 Orchestrator agent（角色模板 = Orchestrator，启动命令 = CC），不立即启动 PTY，等用户首次进入该 workspace 才启动

### 6.3 Worker 卡片字段

```
┌────────────────────┐
│ [🐝] Alice          │ ← 头像 + 名字
│ Coder · claude      │ ← 角色 + 启动命令
│ ● working           │ ← 状态指示（仅三态：idle / working / stopped，详见 §3.6）
│ 「实现登录接口」    │ ← 当前任务摘要（最近一次 team send 的 text 截断；idle 时显示 "—" 或最近一次 report 摘要）
│ 队列: 0             │ ← 待执行任务数（pending_task_count，详见 §3.6.4）
└────────────────────┘
```

**状态视觉**：
- `idle` — 灰色 ○
- `working` — 绿色 ● 脉动
- `stopped` — 红色 ⚠（exit_code ≠ 0）/ 灰色 ○ stopped（exit_code = 0），右下角小字 `exit code N`，按钮 `[Restart]` / `[Delete]`

**Sidebar 状态点**（每行 workspace 旁的小圆点）：
- 仅当该 workspace 内有**至少一个 worker 处于 working** 状态时显示绿色脉动点
- 其他情况无指示（不显示 idle / stopped 状态点，避免视觉噪音）

### 6.4 添加 Worker 流程

点 [+ Add Worker] 弹对话框：
1. **选角色模板**：列表 = 3 个内置 worker（Coder / Reviewer / Tester） + N 个用户自定义 + `Custom...` 入口
   - 选 Custom 时展开完整字段表单（name / description / command / args / env），保存后会自动加入"我的自定义"模板列表，下次复用
   - **Orchestrator 不在选择列表里**（它是 workspace 自带的，每个 workspace 只有一个）
2. **起名字 + 选头像**（继承所选模板的默认 description，可覆盖）
3. **选启动命令**：列表 = 4 个预置（CC / Codex / OpenCode / Gemini） + 自定义入口
   - 默认值 = 所选角色模板的 `default_command`
4. 确认 → 系统创建 agent 实例并立即启动 PTY

### 6.5 角色模板管理（设置页）

[⚙️ Settings] → "角色模板" 标签页：

```
┌─ 系统内置 (4) ─────────────────────────┐
│  👑 Orchestrator   [view] [duplicate]   │
│  ⚙ Coder           [view] [duplicate]   │
│  🔍 Reviewer        [view] [duplicate]   │
│  🧪 Tester          [view] [duplicate]   │
└─────────────────────────────────────────┘

┌─ 我的自定义 (2) ───────────────────────┐
│  📝 Doc Writer     [edit] [delete]      │
│  🎨 UI Polisher    [edit] [delete]      │
└─────────────────────────────────────────┘

[+ New Template]
```

- 内置模板：只读，按 `[duplicate]` 复制成可编辑的自定义副本
- 自定义模板：可改可删；删除时会校验"是否有 agent 还在用"，有则警告

### 6.6 任务图抽屉

抽屉打开后默认是**渲染视图**（task list、checkbox 可勾、点行内编辑）。右上角切换按钮可切到**原始 markdown 编辑器**（保存即写入 `.hive/tasks.md`）。文件外部变更（orch 修改）实时同步到当前视图，编辑冲突时以最新写入为准（MVP 不做 OT/CRDT）。

---

## 7. 数据模型

### 7.1 SQLite Schema（目标草案，Drizzle 表）

> **[M2 实现说明]** MVP schema 实际命名：
> - spec `projects` → 实现 `workspaces`
> - spec `agents` → 实现 `workers`
> - spec `role_templates` / `command_presets` / `app_state` 三表**未建**，延后到 **M3**。当前 role templates 在 `src/server/role-templates.ts` 硬编码，不支持 CRUD；launch config 存在 `agent_launch_configs` 表（per-agent 而非 per-preset）。
> M3 会按 spec §7.1 建 `command_presets` 并把 launch config 语义迁移过去。
> 下表表示**目标 schema**，不是 M2 已完整落地的 schema 清单。

```typescript
// projects: 用户添加的 workspace（每个 = 一个项目目录）
projects {
  id: string (uuid)
  path: string (项目根绝对路径，唯一)
  name: string (显示名，默认取目录名，可改)
  sort_order: int (sidebar 显示顺序，可拖拽调整)
  created_at, last_opened_at
}

// app_state: 全局应用状态（单行表）
app_state {
  id: int (固定 1)
  active_project_id: string (fk, nullable，当前在 UI 上激活的 workspace)
  updated_at
}

// role_templates: 角色模板（预置 + 用户自定义）
role_templates {
  id: string
  name: string
  role_type: enum (orchestrator | coder | reviewer | tester | custom)
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

  // §3.5 Layer A: CLI 原生 session resume 配置（null 表示不支持，走 Layer B 兜底）
  resume_args_template: string | null
    // 如 CC: "--resume {session_id}"
    //    Codex: "resume {session_id}"
    //    OpenCode: "--session {session_id}"
  session_id_capture: json | null
    // {
    //   source: "stdout_regex" | "file_glob" | "opencode_session_db"
    //   pattern: string
    // }
    // 如 CC: { source: "file_glob",
    //          pattern: "~/.claude/projects/{encoded_cwd}/*.jsonl",
    //          extract: "newest_mtime_basename_no_ext" }
    //    Codex: { source: "stdout_regex",
    //             pattern: "Session ID: ([a-f0-9-]+)" }
    //    OpenCode: { source: "opencode_session_db",
    //                pattern: "~/.local/share/opencode/opencode.db" }
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
  command_preset_id: string | null (fk, 用了哪个 preset；null = 自定义命令)
  last_session_id: string | null  // §3.5 Layer A: 启动后捕获的 CLI 原生 session ID
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

// messages: 派单 + 汇报/状态历史（用于 UI 时间线、调试）
messages {
  id: string
  project_id: string (fk)
  from_agent_id: string
  to_agent_id: string
  type: enum (send | report | status | user_input)
  text: string
  status: enum (success | failed) (only for report)
  artifacts: json (string[])
  created_at
}
```

### 7.2 文件持久化

- `<project_root>/.hive/tasks.md` — 任务图（用户视角的核心文档）
- `~/.hive/db.sqlite` — 全局元数据
- `~/.hive/logs/` — 调试日志

---

## 8. 安全和工具白名单

虽然 UI 不暴露白名单设置，**系统内部必须有控制**，避免：

- worker 调 `team send` 越权派单（可能形成循环）
- worker 调 `team list` 窥探团队（信息泄露不大但语义不对）

**实现**：`team` CLI 调用时带 `HIVE_PORT + HIVE_PROJECT_ID + HIVE_AGENT_ID + HIVE_AGENT_TOKEN` 环境变量。`HIVE_AGENT_TOKEN` 是 Hive runtime 为当前 agent run 签发的短期令牌，用于防止同 workspace 内其他 agent 或外部进程伪造 `from_agent_id`。TeamCmdServer 在执行前：
1. 用 `HIVE_PROJECT_ID` 路由到对应 workspace 的 Agent Manager
2. 用 `HIVE_AGENT_ID` 查询该 agent 的 role_type
3. 校验 `HIVE_AGENT_TOKEN` 是否与该 agent 当前 live run 匹配
4. 按角色硬编码白名单允许/拒绝命令
5. **跨 workspace 调用一律拒绝**（agent 只能操作自己 workspace 内的同事）

**UI 端点鉴权**：浏览器侧的只读 UI 端点（如 `GET /api/ui/workspaces/:id/team`）不走 `HIVE_AGENT_TOKEN`，而是先通过 `GET /api/ui/session` bootstrap 一个 `hive_ui_token` cookie。该 cookie 由 server 设置为 `HttpOnly; SameSite=Strict`，后续 UI 请求靠浏览器自动回带 cookie 完成校验。这个 token 的目标是把 UI 流量和 CLI/agent 流量分开，避免继续走“匿名放行”或“只看 Origin/Referer”的脆弱路径。

**信任边界说明**：`hive_ui_token` 只是在 **loopback + 同机进程互信** 假设下的轻量隔离手段，不是跨进程的强鉴权边界。也就是说，它能降低普通浏览器外请求误入 UI 端点的概率，但不能把同机恶意进程视为彻底隔离对象。MVP 接受这个边界；更强的 UI 会话鉴权不在 M2 范围内。

```
orchestrator: { send, list, report, help }
worker:       { report, help }
```

YOLO 模式（默认）：支持 CLI yolo flag 的 agent 启动时自动加跳过权限的参数（CC `--dangerously-skip-permissions`、Codex 对应 flag、Gemini `--yolo` 等）。OpenCode 不注入 yolo args；它的权限策略由 `opencode.json` 配置驱动。

> **[M2 scope 调整]** YOLO mode 参数注入在 M2 未实现，延后到 **M3**。M2 启动命令只按用户/测试配置原样执行，不自动追加各 CLI 的跳过权限参数。

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
| 启动 | `npx hive` 或 `npm i -g hive`，启动后**常驻**（不绑定项目目录） | 类似 kanban |

---

## 10. MVP 范围

### 10.1 In Scope（首版必须）

1. ✅ **多 workspace 支持**：sidebar 列表、添加/删除/排序、持久化、切换激活
2. ✅ Workspace 添加方式：OS 系统目录选择器 + 手动粘贴路径
3. ✅ 每个 workspace 独立的 Orchestrator + N 个 Worker（同时 ≤6 per workspace）
4. ✅ 所有 workspace 的 PTY 后台并行运行（一次只看一个，但都活着）
5. ✅ PTY 在浏览器渲染（xterm.js + WebSocket）
6. ✅ `team send` / `team report` / `team list` 三个命令
7. ✅ 派单 prompt 注入 + 汇报回灌
8. ✅ Per-agent 派单队列 + 去重（借鉴 golutra）
9. △ 任务图 = `.hive/tasks.md`（每个 workspace 独立），UI 渲染 + 编辑器
   > **[M2 scope 调整]** 文件 watch 延后到 **M3**。M2 仅提供 tasks API + UI 读写。
10. ✅ 角色模板：**4 个内置**（1 Orchestrator + 3 Worker：Coder / Reviewer / Tester） + 用户自定义（全局共享，所有 workspace 复用，详见 §3.2）；**MVP 不内置 Architect**
11. △ 启动命令预置（4 个）+ 自定义
   > **[M2 scope 调整]** M2 实际只落了 per-agent `agent_launch_configs`，未实现 `command_presets` 表 / preset CRUD / preset 迁移语义；延后到 **M3**。
12. ✅ 工具白名单（角色级硬编码 + 跨 workspace 隔离）
13. △ YOLO 模式默认开
   > **[M2 scope 调整]** 自动追加 YOLO 参数延后到 **M3**。M2 不自动修改 CLI 启动参数。
14. ✅ **`team` CLI 通过 PATH prepend 注入**（非全局安装），所有自定义/预置启动命令统一可用，零污染用户系统
15. △ **Crash & 重启恢复**：4 种场景明确（§3.5.1）
   > **[M2 scope 调整]** M2 仅实现 Claude 的 Layer A 原生 resume。Layer B 摘要兜底延后到 **M2.5 / M3 前置**。
16. ✅ **Hive runtime 重启后**：所有 agent 显示 stopped 状态；提供单卡 `[Restart]` + workspace 级 `[Restart All]` 按钮，**不自动启动**
17. ✅ **Agent 状态机**：仅 `working` / `idle` / `stopped` 三态（详见 §3.6）；不做超时/卡死检测，不增加心跳协议

### 10.2 Out of Scope（明确不做）

- ❌ Worktree 隔离（共享根目录，并发冲突由 orch 拆分负责）
- ❌ MCP 工具适配
- ❌ Worker → Worker 直连（必须经 orch 中转）
- ❌ Cross-workspace agent 通信（一个 workspace 的 orch 不能给另一个 workspace 的 worker 派单）
- ❌ DAG 编辑器（任务图就是 markdown）
- ❌ **同屏多 workspace**（拆分窗口/网格——一次只看一个）
- ❌ 用户认证（本地单用户）
- ❌ 远程访问（绑定 127.0.0.1）
- ❌ 任务图模板市场
- ❌ Agent 性能/成本统计

### 10.3 Open Questions（实现时再决定，不阻塞设计）

1. **npm 包名**：`hive` 大概率被占。候选 `@hive-team/cli` / `hive-cli` / `hivectl`。
2. **同名 agent**：UI 层校验，不允许同 workspace 内重名（不同 workspace 间可重名）
3. **`team send` 后 worker 还在忙**：进入 per-agent 队列（golutra 的 32 项上限）
4. **如何让 CLI agent "知道"自己能用 `team` 命令**：第一次启动时往 PTY stdin 注入一段 system 消息，说明可用命令列表
5. **摘要长度 / token 预算**（Layer B）：摘要拼装的具体长度上限、消息条数上限，需要根据实际 agent 行为调优
6. **Codex / OpenCode / Gemini 各自的 resume 命令与 session ID 捕获方式**：实现期实测，搞不定的 CLI 走 Layer B 兜底
7. **CC 已 resume 但 session 文件被清理过**：fallback 到 Layer B；要不要额外提示 user？

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 多 worker 同时改一个文件（用户拒绝 worktree） | 完全依赖 orch 的拆分智能。MVP 接受这个风险，观察实际表现 |
| CLI agent 不按约定调 `team report`（忘了 / 不理解） | 派单 prompt 模板要明确强调；不行就在角色描述里再强化 |
| `team` CLI 跟用户已有 `team` 命令冲突 | 不再是问题：`team` 通过 PATH prepend 仅暴露在 PTY 子进程内，用户 shell 看不到（详见 §3.3.1.1） |
| YOLO 模式下 agent 误删文件 | 项目目录内的破坏由 git 兜底；Hive 启动时检测项目是否在 git 仓库内，否则警告 |
| node-pty 在某些平台编译失败 | 跟 kanban 同样的问题，按它的 README 走 |
| Crash 重启后 agent 上下文丢失 | Layer A 走 CLI 原生 session resume（CC `--resume`）能完整恢复对话历史；自定义命令降级到 Layer B 摘要换班 |
| Layer A：session ID 捕获机制随 CLI 升级失效 | 每个预置 command 的 `session_id_capture` 是配置而非硬编码；CLI 升级时改配置即可，不改代码 |
| Layer B：agent 重复执行已完成的工具调用 | 摘要明确区分"已 report 完成" vs "等待中"；要求 agent 凭 git status / read .hive/tasks.md 自查 |
| Hive runtime 重启后用户面对 N 个 stopped 卡片不知所措 | UI 突出 [Restart All] 一键操作，并显示上次活跃时间帮助用户判断要不要重启 |
| 卡死的 agent 持续显示 working 误导用户 | 已知接受（§3.6.3）；卡片显示 working 持续时间帮助用户判断是否要手动 stop；将来加超时计时是渐进可加的 |

---

## 12. 后续路线（参考）

按时间从近到远：

1. **MVP**（2-3 周）：上述 In Scope 全做完
2. **v0.2**：MCP 工具支持（给 CC/Cursor 用更顺）；orch 主动给 user 推送（PTY 之外的通知 banner）
3. **v0.3**：Worker 间直接消息（仍经 orch 路由，但 UI 上像点对点聊天）
4. **v0.4**：可选 worktree 隔离（高级开关）
5. **v1.0**：远程协作模式、模板市场、同屏多 workspace 视图

---

## 13. 命名

**Hive** — 蜂巢。LOGO 用六边形，配色金黄/琥珀。
- Hive 应用本身 = 整个蜂群 / 蜂场
- 一个 Workspace = 一个 Hive（蜂巢，独立的项目家园）
- Orchestrator = Queen Bee 🐝
- Worker = Worker Bee 🐝
- 任务图 = Hive Blueprint

---

## 附录 A：Brainstorming 决策记录

按对话顺序：

| Q | 议题 | 决策 |
|---|---|---|
| Q1 | 起步策略 | 独立仓库 + MVP 风格 |
| Q2 | Orch 跟 user 交互形态 | 像 kanban 一样的 PTY 终端（A） |
| Q3 | 派单机制 | CLI 子命令 (`team send`)（A 方案） |
| Q4 | Worker 汇报机制 | 显式调用 `team report`（风格 2），无静默兜底，无心跳 |
| Q5 | 任务图模型 | markdown todo list（`.hive/tasks.md`） |
| Q6 | UI 布局 | Orch 左侧 PTY / Worker 右侧卡片 / 任务图抽屉 |
| Q7-1 | 角色模板字段 | name + avatar + 角色描述 + 启动命令 + 参数/env |
| Q7-2 | 是否预置模板 | 内置 4 个：1 Orchestrator（系统级，Add Worker 列表不显示）+ 3 Worker（Coder / Reviewer / Tester）；删除 Architect |
| Q7-3 | Orch 是否走模板系统 | 是（统一框架） |
| Q8 | 工作目录隔离 | 共享根目录，不做 worktree |
| Q9-1 | 任务图操作命令 | 不需要，orch 直接编辑 `.hive/tasks.md` |
| Q9-2 | 任务图 UI | markdown 渲染 + 编辑器 |
| Q10 | 形态 | Web app（浏览器） |
| Q11 | 项目名 | Hive |
| - | 启动命令预置 | CC / Codex / OpenCode / Gemini（去掉 Cline） |
| - | 工作目录字段 | 不暴露，硬编码 = workspace 路径 |
| - | 工具白名单 | 不暴露，系统内部硬编码 |
| - | 权限模式 | 默认 YOLO |
| Q12 | 多 workspace UI 形态 | A：sidebar 列表 + 主区单 active 视图（cmux 风格） |
| Q13 | 添加 workspace 方式 | C：OS 系统目录选择器 + 手动粘贴路径 |
| - | 启动模型 | Hive 是常驻服务，不绑定项目目录；通过 UI 添加/切换 workspace |
| - | 跨 workspace 通信 | 禁止；orch 只能操作自己 workspace 内的同事 |
