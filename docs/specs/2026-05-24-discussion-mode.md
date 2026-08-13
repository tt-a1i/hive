# Hive Discussion Mode — Worker 间直接通信设计 (v2)

> 状态：Approved  
> 日期：2026-05-24  
> 灵感来源：HeavySkill: Heavy Thinking as the Inner Skill in Agentic Harness (ICML 2026, arXiv:2605.02396)  
> 评审：米芾（后端）、莫邪（前端）、韩愈（架构）

## 1. 动机

当前 Hive 的通信模型是星形：Worker 只能通过 `team report` 向 Orchestrator 汇报，Worker 之间完全隔离。这适合**分治**场景，但不适合**讨论**场景——多个 Worker 对同一问题独立思考后，通过互相碰撞产生比任何单一轨迹都好的综合解。

HeavySkill 论文的核心发现：讨论阶段的综合推理能突破 Pass@K 天花板——产出 K 条独立轨迹中都不存在的正确解法。这不是投票选最好的，而是碰撞中的创造性推理。

## 2. 核心流程

```
Orch 发起讨论 → 同题注入 K 个 Worker（独立思考，互不可见）→
初始观点全部收齐后一次性 bundle 广播 → 进入讨论轮次（Worker 互相回应）→
轮次耗尽 / Orch 终止 → 各 Worker 输出最终立场 →
系统综合报告注入 Orch
```

关键不变量：**初始阶段完全隔离**——Worker 的初始观点被缓冲（buffer），直到所有成员全部提交后才一次性广播。

### 2.1 与现有派单模式的对比

| 维度 | `team send`（派单） | `team discuss`（讨论） |
|---|---|---|
| 方向 | Orch → Worker（单向） | Worker ↔ Worker（多向广播） |
| 目的 | 分治执行不同子任务 | 同题碰撞产生综合解 |
| Worker 间可见性 | 完全隔离 | 讨论组内互相可见（讨论阶段） |
| Orch 角色 | 派单者 + 收报者 | 发起者 + 旁听者（仅 DB/UI）+ 最终综合者 |
| 终止条件 | Worker report | 轮次耗尽 / Orch --end / 绝对消息上限 |

## 3. 协议设计

### 3.1 API 端点

```
POST /api/team/discuss/start     — Orch/UI 创建讨论组
POST /api/team/discuss/message   — Worker 发送讨论消息
POST /api/team/discuss/conclude  — Worker 提交最终立场
POST /api/team/discuss/end       — Orch/UI 强制终止
POST /api/team/discuss/skip      — Orch/UI 跳过某个 Worker
```

### 3.2 CLI 命令

```bash
# Orch 创建讨论组（仅 Orch/UI 可调用）
team discuss --start --members "<worker1>,<worker2>" --topic "<question>" [--rounds 3]

# Worker 发送讨论消息（仅讨论组 active member 可调用）
team discuss "<message>"

# Worker 提交最终立场（concluding 阶段）
team discuss --conclude "<final-position>"

# Orch 强制终止
team discuss --end [--reason "<reason>"]

# Orch 跳过卡住的 Worker（不用自动超时）
team discuss --skip <worker-name>
```

### 3.3 Authz 规则

- `discuss/start`、`discuss/end`、`discuss/skip`：仅 Orch 或 UI token
- `discuss/message`、`discuss/conclude`：仅该 group 的 active member Worker
- Worker authz 白名单新增：`discuss`（现有：report, status, help）

### 3.4 约束：一个 Worker 同一时间只能在一个活跃讨论组

MVP 不支持 Worker 同时参与多组讨论。`discuss/start` 时校验所有 members 均不在其他活跃组中。

### 3.5 前置校验

`discuss/start` 时必须验证：
- 所有 member Worker 的 `pending_task_count == 0`（不能同时执行派单）
- 所有 member Worker 有 active PTY run（否则无法注入 stdin）

## 4. 消息注入格式

### 4.1 独立思考邀请（系统 → Worker）

```
[Hive 讨论：你被邀请参与讨论]
话题：<topic>
成员：<worker1>, <worker2>, <worker3>
规则：
1. 请独立思考这个问题，形成你的初始观点
2. 完成后用 `team discuss "<your-initial-position>"` 发表
3. 你的观点会被缓冲，直到所有成员都提交后才会互相可见
4. 之后进入讨论阶段（共 N 轮），你可以回应其他成员的观点
5. 讨论目标：通过碰撞产生新的洞察，而非简单同意某人
```

### 4.2 初始观点 Bundle 广播（系统 → 所有 Worker）

所有初始观点收齐后，一次性广播：

```
[Hive 讨论：所有成员初始观点（共 K 人）]

@<Worker1> 的观点：
<initial_position_1>

@<Worker2> 的观点：
<initial_position_2>

@<Worker3> 的观点：
<initial_position_3>

---
讨论阶段开始（第 1 轮/共 N 轮）。请回应其他成员的观点：指出你同意/不同意的部分，提出新的角度，或尝试综合不同观点。
用 `team discuss "<your-reply>"` 发言。
```

### 4.3 讨论阶段（Worker → Worker 广播）

```
[Hive 讨论：来自 @<name> (第 N 轮/共 M 轮)]
<message-text>
```

### 4.4 Conclude 邀请（系统 → 所有 Worker）

```
[Hive 讨论：讨论轮次结束，请提交最终结论]
请综合本次讨论的所有观点和碰撞，用 `team discuss --conclude "<your-final-answer>"` 提交你的最终结论。
你的结论应该是经过讨论后的综合判断，可以不同于你的初始观点。
```

### 4.5 Orch 综合报告（系统 → Orch）

讨论 concluded 后，系统注入 Orch：

```
[Hive 讨论结果：讨论组 <id> 已结束]
话题：<topic>
参与者：<members>
轮次：<actual_rounds>/<max_rounds>
消息总数：<count>

## 各成员初始观点
@Worker1: <initial_position_1>
@Worker2: <initial_position_2>

## 各成员最终结论
@Worker1: <final_position_1>
@Worker2: <final_position_2>

## 关键分歧与变化
- @Worker1 初始主张 X，讨论后转向 Y
- @Worker2 始终坚持 Z，理由是 ...

请综合以上观点做出最终决策。注意：不要简单选择多数派，而是从各方观点中提取互补洞察，形成综合判断。
```

## 5. 讨论组生命周期

### 5.1 Group 状态

```
thinking → discussing → concluding → concluded
    ↓           ↓            ↓
    └───────────┴────────────┴──→ cancelled
```

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `thinking` | 等待所有 member 提交初始观点 | discuss/start |
| `discussing` | 讨论进行中，Worker 互相广播 | 所有 member 提交初始观点 |
| `concluding` | 等待所有 member 提交最终结论 | rounds 耗尽 or 绝对消息上限 |
| `concluded` | 完成，报告已注入 Orch | 所有 member 提交 final position |
| `cancelled` | Orch 强制终止 | discuss/end |

### 5.2 Member 状态

| 状态 | 含义 |
|---|---|
| `invited` | 已注入讨论邀请，等待初始观点 |
| `initial_submitted` | 已提交初始观点（缓冲中） |
| `active` | 讨论阶段活跃 |
| `round_submitted` | 本轮已发言 |
| `skipped` | 被 Orch skip |
| `final_submitted` | 已提交最终结论 |
| `failed` | PTY 退出 |

### 5.3 边界情况处理

- **Worker PTY 退出**：标记 member `failed`，通知 Orch（旁听消息），组可继续（跳过该 member）
- **thinking 阶段 skip**：Orch 可 skip 未提交初始观点的 Worker，剩余 member 够 2 人即可进入 discussing
- **重复发送**：同一 round 同一 Worker 的第二条消息被服务端拒绝（409）
- **Orch PTY 退出**：讨论继续进行，结果持久化到 DB，Orch 重启后可回放

## 6. 防死循环机制

| 机制 | 说明 |
|---|---|
| 每 Worker 每 round 限 1 条 | 服务端 `UNIQUE(group_id, round, from_agent_id)` 约束 |
| 硬上限 rounds | `--rounds N`（默认 3），rounds 耗尽强制进入 concluding |
| 绝对消息上限 | `max_messages = 20`（含 initial），超限强制进入 concluding |
| Orch 手动 skip | 卡住的 Worker 由 Orch 手动跳过，不做自动超时 |
| 组大小上限 | K ≤ 5（默认 3） |

**不做共识检测**（MVP）：对齐 HeavySkill 原意——讨论目标是产生新解，不是达成一致。

## 7. Orch 旁听策略

### 默认：DB + UI 旁听（不注入 Orch stdin）

- 讨论消息实时写入 DB，前端通过 WebSocket subscription 推送到 Discussion Panel
- Orch stdin **不**实时注入讨论消息（避免 LLM 自动响应干扰讨论）
- 仅在讨论 concluded 后，将综合报告一次性注入 Orch stdin

### 可选：`--listen=stdin`

创建时可选 `team discuss --start --listen=stdin ...`，开启实时 stdin 注入（Orch 每条都看到）。

## 8. 数据模型

```sql
CREATE TABLE discussion_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  current_round INTEGER NOT NULL DEFAULT 0,
  max_messages INTEGER NOT NULL DEFAULT 20,
  message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('thinking','discussing','concluding','concluded','cancelled')),
  listen_mode TEXT NOT NULL DEFAULT 'db', -- 'db' | 'stdin'
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  concluded_at INTEGER
);

CREATE INDEX idx_discussion_groups_workspace
  ON discussion_groups (workspace_id, status);

CREATE TABLE discussion_members (
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  member_status TEXT NOT NULL DEFAULT 'invited'
    CHECK (member_status IN ('invited','initial_submitted','active','round_submitted','skipped','final_submitted','failed')),
  initial_position TEXT,
  final_position TEXT,
  rounds_participated INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE discussion_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  from_agent_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('initial','discuss','conclude')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_discussion_messages_group_round
  ON discussion_messages (group_id, round, sequence);

CREATE UNIQUE INDEX idx_discussion_messages_one_per_round
  ON discussion_messages (group_id, round, from_agent_id)
  WHERE message_type = 'discuss';
```

## 9. 消息路由实现

### 9.1 Per-agent 写入队列

为保证同一 Worker 收到的消息顺序与 DB sequence 一致，使用 per-agent Promise chain：

```typescript
const writeQueues = new Map<string, Promise<void>>()

const enqueueStdinWrite = (agentId: string, text: string) => {
  const prev = writeQueues.get(agentId) ?? Promise.resolve()
  const next = prev.then(() => writeToActiveAgentRun(agentId, text))
  writeQueues.set(agentId, next)
}
```

### 9.2 广播流程

1. Worker A POST `/api/team/discuss/message`
2. 服务端验证：A 是 active member、group 在 discussing 阶段、本轮 A 未发过言
3. 持久化到 `discussion_messages`
4. 更新 `message_count`、member `last_message_at`、member status → `round_submitted`
5. 对组内除 A 外每个 active member，通过写入队列注入 stdin
6. 如果 `listen_mode = 'stdin'`，也注入 Orch
7. 通过 WebSocket emit 通知前端
8. 检查：本轮所有 active member 均已 `round_submitted` → 推进 round

## 10. 前端 UI

### 10.1 Discussion Panel（右侧 resizable drawer）

- 与终端区域共存，不遮挡主视觉焦点
- 按轮次分组，消息显示前 2-3 行 + expand
- Typing indicator：未提交当轮观点的 member 显示 "思考中..."
- 讨论历史列表：concluded 的讨论可回溯

### 10.2 Worker 卡片

- Badge overlay："讨论中 (2/3轮)"，点击 tooltip 显示话题 + 成员
- 不引入新状态枚举，讨论通过独立的 `active_discussion_count` 影响是否显示 badge

### 10.3 触发入口

- Orch 终端自然语言触发（"让大家讨论一下 X"）
- Workspace toolbar "New Discussion" 按钮 → dialog 选 members + 输入 topic

### 10.4 实时更新

- 新增 tRPC subscription：`discussion.onMessage`、`discussion.onStateChange`
- 不用 polling

## 11. 实现分阶段

### Phase 1: MVP（当前）

1. DB schema（discussion_groups / discussion_members / discussion_messages）
2. 后端 4 个 API 端点 + authz 扩展
3. `team` CLI discuss 子命令
4. 消息路由 + per-agent 写入队列
5. 生命周期状态机 + round 推进逻辑
6. Orch 综合报告注入
7. 前端 Discussion Panel（右侧 drawer）
8. WebSocket subscription

### Phase 2: 增强

- Orch 参与模式（phase-gated：Orch 也要先独立提交再看别人）
- 异构模型讨论
- 角色化讨论 prompt 模板
- 讨论回放 timeline UI
- `--skip` 命令实现

### Phase 3: 自动触发

- Orch 角色模板内置讨论触发规则
- 讨论结果自动接入后续任务分配
