# Hive

Hive 是一个本地运行的多 CLI agent 协作工作台原型。当前仓库已经具备最小可运行骨架：

- `hive` runtime HTTP server
- `team list` / `team send` / `team report` 最小 CLI
- 内存版 workspace / worker 状态层
- 最小 Web 壳子，可展示 workspace 空态和列表

## 当前进度

已完成：

- 根工程配置（TypeScript + Vitest + React）
- 共享类型与三态 worker 模型
- 最小 runtime store
- 最小 HTTP API
- 最小 `team` CLI
- 最小 `hive` 启动命令
- 最小前端壳子

尚未完成：

- `node-pty` 集成
- xterm.js 终端渲染
- SQLite + Drizzle 落库
- `tasks.md` watcher
- Crash 恢复 Layer A / Layer B
- 完整 workspace 创建与 worker 管理 UI

## 安装

```bash
pnpm install
```

## 测试

```bash
pnpm test
```

## 构建

```bash
pnpm build
```

## 启动当前最小 runtime

```bash
pnpm dev -- --port 3000
```

启动后会输出：

```text
Hive running at http://127.0.0.1:3000
```

## 当前 HTTP API

- `GET /api/workspaces`
- `POST /api/workspaces`
- `GET /api/workspaces/:id/team`
- `POST /api/team/send`
- `POST /api/team/report`

## 当前前端

当前前端只实现了最小壳子组件：

- 标题 `Hive`
- workspace 列表
- 空态文案 `No workspaces yet`
- `Add Workspace` 按钮占位

后续会补 Vite dev server 配置、布局细节、workspace 创建流和 PTY 终端区。
