# Hive Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库实现可本地运行的 Hive MVP 骨架，先打通 `workspace 列表 + runtime API + team CLI + 最小 Web UI` 的第一条垂直链路。

**Architecture:** 采用单仓 Node.js + React + TypeScript 结构：`src/` 放 runtime 与共享类型，`web/` 放 Vite 前端。第一阶段先不接 `node-pty`，用可替换的 in-memory runtime 打通 workspace、agent、`team list` 和基础 UI；第二阶段再接入 PTY、恢复、watcher 等能力。

**Tech Stack:** Node.js 22+, TypeScript, Vitest, React 19, Vite 6, commander, ws, better-sqlite3, Drizzle（后续接入）

---

## 文件结构

- `package.json`
  - 根工作区脚本、依赖、CLI 入口
- `tsconfig.json`
  - 根 TypeScript 配置
- `vitest.config.ts`
  - 测试配置
- `src/cli/hive.ts`
  - `hive` 主命令入口，负责启动 runtime HTTP 服务
- `src/cli/team.ts`
  - `team` 子命令入口，负责读取 `HIVE_*` 环境变量并发 HTTP 请求
- `src/server/app.ts`
  - 组装 HTTP 路由与运行时依赖
- `src/server/runtime-store.ts`
  - MVP 的内存状态层，管理 workspace、agent、pending 计数
- `src/server/routes/*.ts`
  - workspace / agent / team 的 HTTP 路由
- `src/shared/types.ts`
  - 前后端共享 DTO 与状态类型
- `web/index.html`
  - 前端入口 HTML
- `web/src/main.tsx`
  - React 启动入口
- `web/src/app.tsx`
  - 主界面骨架
- `web/src/api.ts`
  - 调 runtime HTTP API 的最小客户端
- `tests/**/*.test.ts`
  - runtime、CLI、共享逻辑测试

## 分块

## Chunk 1: 基础工程与共享类型

### Task 1: 建立根工程配置

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: 写出配置存在性的 failing test**

```ts
import { existsSync } from 'node:fs'
import { test, expect } from 'vitest'

test('root project config exists', () => {
  expect(existsSync('package.json')).toBe(true)
  expect(existsSync('tsconfig.json')).toBe(true)
  expect(existsSync('vitest.config.ts')).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/setup/root-config.test.ts`
Expected: FAIL，因为文件尚不存在。

- [ ] **Step 3: 写最小配置**

实现内容：
- `package.json` 提供 `dev`、`build`、`test`、`web:dev`、`web:build` 脚本
- 暴露 bin：`hive`、`team`
- 引入最小依赖：`typescript`、`vitest`、`tsx`、`react`、`react-dom`、`vite`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/setup/root-config.test.ts`
Expected: PASS

### Task 2: 定义共享类型

**Files:**
- Create: `src/shared/types.ts`
- Test: `tests/shared/types-shape.test.ts`

- [ ] **Step 1: 先写 failing test，锁定 MVP 共享结构**

```ts
import { describe, expect, test } from 'vitest'
import type { AgentStatus, TeamListItem } from '../../src/shared/types'

describe('shared types contract', () => {
  test('team list item status uses three-state model', () => {
    const item: TeamListItem = {
      id: 'alice',
      name: 'Alice',
      role: 'coder',
      status: 'working' satisfies AgentStatus,
      pendingTaskCount: 1,
    }

    expect(item.status).toBe('working')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/types-shape.test.ts`
Expected: FAIL，因为 `src/shared/types.ts` 不存在。

- [ ] **Step 3: 写最小共享类型**

实现内容：
- `AgentStatus = 'idle' | 'working' | 'stopped'`
- `WorkerRole = 'coder' | 'reviewer' | 'tester' | 'custom'`
- `TeamListItem`、`WorkspaceSummary`、`AgentSummary`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/shared/types-shape.test.ts`
Expected: PASS

## Chunk 2: Runtime 内存状态与 `team list`

### Task 3: 实现 runtime 内存状态层

**Files:**
- Create: `src/server/runtime-store.ts`
- Test: `tests/server/runtime-store.test.ts`

- [ ] **Step 1: 先写 failing tests，锁定状态机的最小行为**

测试覆盖：
- 可添加 workspace
- 每个 workspace 只有一个 orchestrator
- `send` 会让 worker `pendingTaskCount + 1` 并进入 `working`
- `report` 会让 worker 计数归零并回到 `idle`
- `team list` 只返回 worker，不返回 orchestrator

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/runtime-store.test.ts`
Expected: FAIL，因为 store 不存在。

- [ ] **Step 3: 写最小实现**

实现内容：
- `createRuntimeStore()`
- `createWorkspace(path, name)`
- `addWorker(projectId, input)`
- `dispatchTask(projectId, workerId, text)`
- `reportTask(projectId, workerId)`
- `listWorkers(projectId): TeamListItem[]`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/runtime-store.test.ts`
Expected: PASS

### Task 4: 暴露最小 HTTP API

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/routes/workspaces.ts`
- Create: `src/server/routes/team.ts`
- Test: `tests/server/app.test.ts`

- [ ] **Step 1: 先写 failing API tests**

测试覆盖：
- `GET /api/workspaces` 返回列表
- `POST /api/workspaces` 新建 workspace
- `GET /api/workspaces/:id/team` 返回 `team list`
- `POST /api/team/send` 与 `POST /api/team/report` 更新状态

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/server/app.test.ts`
Expected: FAIL，因为 app 不存在。

- [ ] **Step 3: 写最小实现**

实现内容：
- Node `http` server
- JSON body parse
- 上述 4 个端点

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/server/app.test.ts`
Expected: PASS

## Chunk 3: `team` CLI 与 `hive` 主命令

### Task 5: 实现 `team list` / `team send` / `team report` CLI

**Files:**
- Create: `src/cli/team.ts`
- Test: `tests/cli/team-cli.test.ts`

- [ ] **Step 1: 先写 failing CLI tests**

测试覆盖：
- 缺少 `HIVE_PORT/HIVE_PROJECT_ID/HIVE_AGENT_ID` 时失败
- `team list` 调用正确 endpoint
- `team send` 和 `team report` 发出正确 payload

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/team-cli.test.ts`
Expected: FAIL，因为 CLI 不存在。

- [ ] **Step 3: 写最小实现**

实现内容：
- 解析 argv
- 读取环境变量
- `fetch` 到 runtime HTTP server
- `team list` 打印单行 JSON

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cli/team-cli.test.ts`
Expected: PASS

### Task 6: 实现 `hive` 主命令启动 runtime

**Files:**
- Create: `src/cli/hive.ts`
- Test: `tests/cli/hive-cli.test.ts`

- [ ] **Step 1: 先写 failing tests**

测试覆盖：
- 默认启动 HTTP server
- 输出监听地址
- 支持 `--port 0` 自动端口

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli/hive-cli.test.ts`
Expected: FAIL，因为 CLI 不存在。

- [ ] **Step 3: 写最小实现**

实现内容：
- 组装 `createApp()`
- 启动 server
- 输出 `Hive running at http://127.0.0.1:<port>`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cli/hive-cli.test.ts`
Expected: PASS

## Chunk 4: Web UI 最小壳子

### Task 7: 搭最小 Vite React 前端

**Files:**
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/app.tsx`
- Create: `web/src/api.ts`
- Test: `tests/web/app-shell.test.tsx`

- [ ] **Step 1: 先写 failing UI shell tests**

测试覆盖：
- 渲染 `Hive`
- 能展示 workspace sidebar
- 无 workspace 时显示空态 CTA

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web/app-shell.test.tsx`
Expected: FAIL，因为前端文件不存在。

- [ ] **Step 3: 写最小实现**

实现内容：
- 三段布局骨架
- 从 `/api/workspaces` 拉 workspace 列表
- 空态与基础 sidebar 渲染

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web/app-shell.test.tsx`
Expected: PASS

### Task 8: 打通添加 workspace 与 worker 列表展示

**Files:**
- Modify: `web/src/app.tsx`
- Modify: `web/src/api.ts`
- Test: `tests/web/workspace-flow.test.tsx`

- [ ] **Step 1: 先写 failing flow tests**

测试覆盖：
- 可添加 workspace
- 选中后展示 orchestrator 区域占位
- 展示 worker cards 区域占位

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web/workspace-flow.test.tsx`
Expected: FAIL

- [ ] **Step 3: 写最小实现**

实现内容：
- `Add Workspace` 按钮与最简表单
- active workspace 切换
- orch 区与 worker 区占位

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web/workspace-flow.test.tsx`
Expected: PASS

## Chunk 5: 验证与后续切片

### Task 9: 端到端手动验证第一条链路

**Files:**
- Modify: `README.md`（如果尚不存在则 Create）

- [ ] **Step 1: 写出本地启动说明**

内容至少包括：
- `npm install`
- `npm run dev`
- `npm test`
- 如何用 HTTP API 或 UI 创建 workspace

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 跑一次手动链路**

Run:
- `npm run dev`
- 打开浏览器
- 创建 workspace
- 调 runtime API 添加 worker
- 运行 `team list` 验证输出结构

- [ ] **Step 4: 记录下一批实现项**

下一批留给后续计划/任务：
- `node-pty` 接入
- xterm.js 终端流
- SQLite + Drizzle 落库
- `tasks.md` watcher
- Layer A / Layer B 恢复

---

Plan complete and saved to `docs/superpowers/plans/2026-04-18-hive-implementation.md`.
