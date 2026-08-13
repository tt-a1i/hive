# Auto-Resume on Runtime Restart

## 背景

Hive runtime（Node.js 进程）重启时，所有 PTY 子进程被杀死，agent 丢失上下文。当前行为：用户必须手动点击 [Restart] 逐个恢复 agent。对于常驻服务场景（升级、crash recovery），这个手动步骤不可接受。

## 现有能力

| 模块 | 能力 |
|---|---|
| `agent-run-bootstrap.ts` | 启动时查 `sessionStore.getLastSessionId()`，有值则走 resume 路径 |
| `preset-launch-support.ts` | `withPresetResumeArgs()` 拼装 resume CLI 参数 |
| `command-preset-defaults.ts` | 各 CLI 的 `resumeArgsTemplate`（如 `--resume {session_id}`） |
| `agent-run-exit-handler.ts` | 仅非零退出码 + resumed run 时清除 session_id（kill 不清） |
| `agent_runs` 表 | 记录每次运行的 start/exit 状态 |
| 派单队列（SQLite） | 待执行 dispatch 持久化，不随进程丢失 |

结论：resume 基础设施完备，缺的只是"runtime 启动时自动触发"。

## 缺失环节

1. Runtime boot 后无逻辑扫描"上次运行中被中断的 agent"
2. 无自动调用 `startAgent` 的流程
3. 无 crash-loop 保护
4. 无用户 opt-out 开关

## 方案

### 4.1 识别需恢复的 agent

Runtime hydration 完成后，查询：

```sql
SELECT agent_id, last_session_id
FROM agent_runs
WHERE exit_code IS NULL
  AND workspace_id IN (SELECT id FROM workspaces WHERE auto_resume = 1)
```

`exit_code IS NULL` 表示非正常退出（kill / runtime crash）。

### 4.2 自动启动

对每个命中的 agent，按顺序（间隔 500ms）调用现有 `startAgent(agentId)`。该流程已内置 resume 逻辑——检测到 `last_session_id` 即拼装 resume args。

启动顺序：Orchestrator 优先，Worker 按 `agent_id` 升序。

### 4.3 Workspace 设置

`workspaces` 表新增列：

```sql
ALTER TABLE workspaces ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 1;
```

UI：Workspace Settings 面板增加 toggle "Runtime 重启后自动恢复 agent"。

### 4.4 待派发任务

无需额外处理。派单持久化在 SQLite `dispatch_queue` 表，agent resume 后进入 idle 态，runtime 按现有逻辑 flush pending dispatches。

## 安全措施

### Crash-loop 保护

`agent_runs` 表新增列：

```sql
ALTER TABLE agent_runs ADD COLUMN consecutive_fast_exits INTEGER NOT NULL DEFAULT 0;
```

规则：
- 若 agent 启动后 **10 秒内**退出（exit_code != 0），`consecutive_fast_exits += 1`
- 达到 **3 次**后，标记该 agent 为 `suspended`，不再自动 resume
- 用户手动点击 [Restart] 时重置计数器
- 正常退出（exit_code = 0）或运行超过 10s 后退出，计数器归零

### 其他

- Runtime 启动后等待 hydration 完成（DB ready + WebSocket ready）再触发 auto-resume
- 单次 auto-resume 批量上限 = workspace 内 agent 总数（不额外限制）
- 日志记录每个 auto-resume 动作及结果

## 验证步骤

1. 启动 2 个 agent（1 orch + 1 worker），确认运行中
2. `kill -9` Hive runtime 进程
3. 重启 runtime，观察两个 agent 在 5s 内自动恢复，终端显示 resume 后的上下文
4. 验证 pending dispatch 在 worker resume 后被投递
5. 模拟 fast-exit：让 worker 的 CLI 路径指向一个立即退出的脚本，确认 3 次后停止重试
6. 关闭 workspace 的 `autoResumeOnRestart`，重启 runtime，确认不自动恢复
