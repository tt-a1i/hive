# Hive 统一任务模型设计方案（修订版）

> 原方案经 4 人讨论后撤回重写。原方案见 git history。

## 问题陈述

当前 Hive 有两套并行的任务系统，且互不关联：
1. **tasks.md**（GFM checklist）：Orch 手动维护 + 讨论 concluded 时自动 append
2. **dispatches**（SQLite 表）：跟踪 `team send` 派单生命周期

后果：Orch 忘记更新 tasks.md、新需求不创建 task、用户无法从单一视图看到真实状态。

## 设计决策（讨论共识）

| 决策 | 理由 |
|---|---|
| tasks.md 保持可读写主源 | spec 核心体验，Layer B 恢复依赖，不可单方面降级 |
| Dispatch 不自动推进 task 状态 | 1:N 关系下语义错误，会制造虚假完成 |
| 引入轻量 DB 索引 + 事件审计 | 稳定 ID、可追溯、可关联 |
| Anchor 丢失为正常路径 | HTML comment 可能被 LLM/用户删除，必须容错 |
| Worker 无 task 写权限 | Orch 管计划，Worker 管执行 |
| 讨论产出用 proposed 状态 | 避免与 Orch 手动建 task 重复 |

## Phase 1：Task Identity + Event Audit + Suggestion（~500 行）

### 核心原则

- tasks.md 保持为可读写主源，不反转 source of truth
- Dispatch 生命周期事件只产生 suggestion，不自动改 task 状态
- Done/blocked/cancelled 由 Orch 显式确认
- Anchor 丢失作为正常路径处理（orphan workflow）

### 数据模型

#### tasks 注册表（ID 索引，非真源）

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- proposed | open | in_progress | done | blocked | cancelled
  source TEXT,                           -- orch | discussion | user
  source_ref TEXT,                       -- discussion group_id 等来源引用
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_workspace ON tasks (workspace_id, status);
```

#### task_events 审计表

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- created | dispatched | report_suggested | marked_done | blocked | cancelled | relinked | archived
  agent_id TEXT,
  dispatch_id TEXT,
  payload TEXT,              -- JSON: 额外上下文
  line_snapshot TEXT,        -- 事件发生时的 task 文本快照
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_task_events_task ON task_events (task_id, created_at);
```

#### dispatch 表扩展

```sql
ALTER TABLE dispatches ADD COLUMN task_id TEXT;
```

### Anchor 机制

- 系统创建 task 时在 tasks.md 行末写入：`<!-- tid:uuid -->`
- Parser 容忍 anchor 缺失——缺失时用 normalized title 模糊匹配 tasks 注册表
- Anchor 丢失 → dispatch 变 orphan → UI 专区展示 → Orch 可 relink/cancel/archive

### CLI 扩展：`team task`

```
team task list [--status open]              # Orch + Worker 可用（只读）
team task create "<title>"                  # 仅 Orch
team task done <id>                         # 仅 Orch
team task block <id>                        # 仅 Orch
team task cancel <id>                       # 仅 Orch
team task show <id>                         # Orch + Worker
```

`team send` 扩展：
```
team send "<worker>" "<text>" --task <id>           # 关联已有 task
team send "<worker>" "<text>" --create-task         # 自动创建 task + 关联
```

### 状态推进规则

| 事件 | 系统行为 |
|---|---|
| team send --task <id> | task_events: dispatched; task: open → in_progress |
| dispatch reported | task_events: report_suggested; UI badge 更新; **不改 task status** |
| Orch 执行 team task done | task_events: marked_done; task: → done |
| Orch 执行 team task block | task_events: blocked; task: → blocked |
| anchor 丢失 | dispatch 标记 orphan; UI 专区展示 |

### 讨论产出改造

- 创建 proposed task（status=proposed, source=discussion, source_ref=group_id）
- Orch prompt 注入："N 个新提议任务待认领"
- Orch 认领后变 open，避免与手动建 task 重复

### UI 增强

- task 行旁显示 dispatch badge（0/3 done, 2/3 done）
- 所有 dispatch resolved → 高亮"建议完成"
- Orphan dispatch 专区 + relink 操作

### 权限

- Worker：team task list/show（只读）
- Orch/user：team task create/done/block/cancel
- 系统：task_events 追加、suggestion 生成

### 不做

- parent_id 层级（用 section heading 分组）
- priority 独立字段（markdown 行序即排序）
- dispatch → task 自动状态推进（done/blocked/cancelled）
- 自动超时/卡死检测
- tasks.md 只读/生成逻辑

## Phase 2 触发条件

仅当 Phase 1 运行 2 周数据显示以下任一时启动：
- Orch suggestion 响应率 < 40%
- 用户明确反馈 markdown 管理负担过大（task > 30）

Phase 2 前置：更新主 spec 明确 tasks.md 角色变更。

## 实现估算

| 模块 | 行数 |
|---|---|
| SQLite schema（tasks + task_events + dispatch.task_id） | ~60 |
| task CRUD service | ~120 |
| CLI team task | ~100 |
| dispatch report → suggestion event 钩子 | ~40 |
| tasks.md anchor 注入/解析 | ~60 |
| orphan 检测 + UI 展示 | ~80 |
| 讨论产出改造（proposed task） | ~40 |
| **合计** | **~500** |

## 关键洞察（讨论涌现）

1. Task 是"用户意图"，dispatch 是"执行事件"——二者不应有直接状态映射
2. Stable ID > fingerprint（编辑半衰期问题），但 anchor 必须容忍丢失
3. 讨论产出应创建 proposed task（非 open），避免 Orch 手动建 task 时重复
4. Orphan dispatch 是正常路径（anchor 删除/task 删除），需一等 UI 支持
5. Worker 不应有 task 写权限（Orch 管计划，Worker 管执行）
6. Source of truth 反转是架构身份变更，需 spec 级决策，不能作为 feature 偷偷实施
