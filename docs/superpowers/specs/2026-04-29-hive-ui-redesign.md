# Hive UI 重做设计文档（M6 — UI Redesign）

**日期**：2026-04-29
**状态**：Draft / Pending review
**作者**：brainstorming session（authorize-and-design 模式，用户授权直接出 spec）
**前置**：[2026-04-18-hive-design.md](./2026-04-18-hive-design.md)（产品 spec，单一事实来源）

> **关系**：本 spec 是 [产品 spec §6 前端 UI 设计](./2026-04-18-hive-design.md) 的**修订与扩展**。两者冲突时以本 spec 为准；本 spec 未覆盖的部分（协议、数据模型、状态机）仍以产品 spec 为准。

---

## 1. 为什么要做

M5 已经把 UI 升到 Linear 风深色 shell，但有结构与品味两层问题：

**结构层**（光精修视觉解决不了）：
1. 主区固定 `OrchestratorPane (40%) │ WorkersPane (60%)` 左右分栏，小屏挤死大屏空，且 Worker 网格上限 `lg:grid-cols-2` 浪费横向空间
2. 任务图（spec §3.4 称为"项目蓝图"）藏在右侧抽屉，靠按钮唤出 — 跟它在协议中的核心地位不匹配
3. 没有命令 palette / 键盘工作流，跟 Linear 美学只有"皮"没有"骨"
4. WorkerModal 全屏遮罩盖死主区，看不到 Queen 上下文，无法对照
5. WorkerCard 同一维度（pending_task_count）三处显示（status pill / queue badge / 底部 footer 行）

**品味层**（视觉廉价）：
6. 全局散布 emoji 当装饰（🐝 👑 📋 ⚙️）—— Linear 自家产品几乎不用 emoji
7. Stop / Restart 用浏览器原生 `window.confirm()`
8. card hover `translateY(-1px)` 是廉价 AI 痕迹，且在网格中容易抖动
9. 错误条直接横亘 WorkspaceDetail 底部（`<p role="alert" class="border-t border-status-red/30 bg-status-red/10 ...">`），跟正常布局割裂
10. 节奏不齐：Topbar / Sidebar / Footer 各自一种字号叠层

本文档定义把这两层都解决到 production 标准的设计。

---

## 2. 范围与非范围

### In Scope
- 主区信息架构重组（垂直堆叠 + Inspector drawer）
- Blueprint Bar 把任务图提升为常驻一等公民
- Worker 从 tile 网格改行卡 strip
- 命令 Palette（⌘K）+ 全局键盘快捷键
- Icon 系统替换（emoji → lucide-react SVG）
- 自研 Dialog / Toast / Confirm 替换 `window.confirm`
- 状态视觉规范（dot / pill / progress 的统一应用规则）
- 动效规范（曲线 / 时长 / 触发条件）
- 空态 / 失败态 / 加载态 三态视觉

### Out of Scope（明确不做）
- 浅色主题（M6 仅深色，浅色延后到 v0.3）
- 自定义主题/配色编辑
- DAG 任务图编辑器（spec §10.2 已明确不做，沿用 markdown）
- 屏幕宽度 < 720px 的优化（开发者工具，桌面优先）
- 多 workspace 同屏分割视图（spec §10.2 明确不做）
- i18n / 多语言（沿用现有英文 + 必要中文 placeholder）
- 国际化文本提取层（视觉重做与文本系统正交，留给独立 milestone）
- 性能优化（虚拟滚动等）—— Worker ≤6 / workspace ≤10 量级用不上

### 跟产品 spec 的兼容性
本设计**不修改**产品 spec 的协议、数据模型、状态机、安全模型。仅修改产品 spec §6 的 UI 描述。具体 §6 字段冲突时按本 spec 第 11 节"产品 spec §6 修订"覆盖。

---

## 3. 信息架构

### 3.1 整体布局（4 区复合）

```
┌─────────────────────────────────────────────────────────────────────┐
│  Topbar (h-10)   Hive › my-app · main         ⌘K   Inspector  ⚙   │ ← 全局
├──────┬─────────────────────────────────────────────────────┬────────┤
│      │  Workspace Canvas (垂直堆叠)                         │        │
│  WS  │ ┌───────────────────────────────────────────────┐   │  Side  │
│  Nav │ │ Blueprint Bar  3/8 ▌▌▌▌▌▌▌▌▌▌  [↕]          │   │ Inspe  │
│ 56-  │ ├───────────────────────────────────────────────┤   │ ctor   │
│ 240  │ │ Queen Pane (Orch PTY)              [⛶][⏷][⏹] │   │  ←off  │
│ ↔    │ │   ...PTY xterm output...                       │   │ 380px  │
│      │ ├───────────────────────────────────────────────┤   │        │
│      │ │ Workers Strip                          [+ New]│   │        │
│      │ │ ● Alice  Coder    │working│ "implement /login"│   │        │
│      │ │ ○ Bob    Tester   │idle  │                   │   │        │
│      │ │ ⚠ Eve    Reviewer │stop  │ exit 1            │   │        │
│      │ └───────────────────────────────────────────────┘   │        │
├──────┴─────────────────────────────────────────────────────┴────────┤
│  Footer (h-6 mono) · 3 ws · 2 working · :4010 · ⌘? help            │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 区块定义

| 区块 | 尺寸 | 默认 | 角色 |
|---|---|---|---|
| **Topbar** | 全宽 × 40px | 常驻 | 品牌 + workspace breadcrumb（含 git 分支）+ ⌘K + Inspector toggle + Settings |
| **WS Sidebar** | 56–240px × full | 240px 展开 | workspace 列表，可折叠到 56px icon-only |
| **Workspace Canvas** | flex × full | 自适应 | 垂直堆三块：Blueprint / Queen / Workers |
| **Blueprint Bar** | full × 40–360px | 紧凑 (≈40px) | 项目蓝图（tasks.md），可展开/折叠 |
| **Queen Pane** | full × flex | 占主要垂直空间 | Orchestrator PTY，可折叠到 32px 状态条，可全屏遮蔽其他两块 |
| **Workers Strip** | full × auto | 显示全部 worker | 行卡列表，溢出滚动 |
| **Inspector Drawer** | 380px × full | 关闭 | 侧抽屉，承载 worker 详情 / palette / activity |
| **Footer** | 全宽 × 24px | 常驻 | mono 状态栏 |

### 3.3 三块面板的伸缩规则

主区垂直堆叠的三块（Blueprint / Queen / Workers）按"焦点-上下文"原则：

```
mode = 'balanced' （默认，初始进入 workspace）
  Blueprint  ─ 紧凑 40px
  Queen      ─ flex（剩余空间）
  Workers    ─ auto，按行卡内容；上限 = canvas 高度 × 0.4，超过内部滚动

mode = 'queen-focus' （按 ⌘⇧2 / 点 Queen 全屏按钮触发）
  Blueprint  ─ 折叠为 12px chip 行（保留蓝图存在感，悬停显示进度数字）
  Queen      ─ 满铺
  Workers    ─ 折叠为底部 32px 状态条（点击展开 = 切回 balanced）

mode = 'workers-focus' （按 ⌘⇧3 / 点 Workers 全屏按钮触发）
  Blueprint  ─ 紧凑 40px
  Queen      ─ 折叠为 32px 状态条
  Workers    ─ flex 满铺

mode = 'blueprint-focus' （按 ⌘⇧4 / 点 Blueprint 展开按钮触发）
  Blueprint  ─ flex 满铺（含 raw editor）
  Queen      ─ 折叠为 32px 状态条
  Workers    ─ 折叠为 32px 状态条
```

**实现**：用 CSS grid `grid-template-rows` 三段，按 mode 切换 row 高度模板（不重渲染、不卸载 PTY）。模式状态存 `localStorage`（per-workspace）。

### 3.4 响应式

| 屏宽 | sidebar | inspector | blueprint |
|---|---|---|---|
| ≥ 1280 | 240 展开 | 380 同屏 | 紧凑常驻 |
| 960–1279 | 240 展开 | overlay drawer (半透明遮罩) | 紧凑常驻 |
| 720–959 | 56 自动折叠 | overlay drawer | 折叠为按钮 |
| < 720 | 不优化 | — | — |

### 3.5 Inspector Drawer 内容

右侧 drawer，单一容器承载多种上下文（同一时间只有一个内容）：

| 触发 | 内容 |
|---|---|
| 点击某个 worker 行卡 | **Worker Detail**：worker 元信息 + 该 worker PTY（取代 WorkerModal）+ start/stop/restart/delete 操作 |
| 按 ⌘K 或点 Topbar Inspector 按钮 | **Command Palette**：搜索框 + 命令列表 |
| 默认（无主动触发） | **Activity Stream**：当前 workspace 最近 messages 时间线（user_input / send / report） |
| 点 Topbar Settings | **Settings**：全局设置（角色模板管理 / preset / 主题）—— M6 范围内仅做骨架，模板 CRUD 延后到 M7 |

**关键交互**：
- Inspector drawer 状态机：`closed | worker | palette | activity | settings | cheatsheet`
- 点击同一个 worker 行卡两次 → 关闭 drawer（toggle 语义）
- 切换 workspace → drawer 自动关闭（避免显示无关上下文）
- Esc 键 → 关闭 drawer

---

## 4. 视觉系统

### 4.1 色彩 Tokens

保留 M5 已建立的 Linear dark token，**追加 4 个语义层**（修补现有 token 的语义缺口）：

```css
/* M5 已有，保留 */
--bg-0 / --bg-1 / --bg-2 / --bg-3 / --bg-crust
--border / --border-bright
--text-primary / --text-secondary / --text-tertiary
--accent / --accent-hover
--status-green / --status-orange / --status-red / --status-blue / --status-purple / --status-gold

/* M6 追加 */
--bg-overlay: rgba(8, 9, 10, 0.72);   /* dialog/drawer 遮罩，原 modal-backdrop 提升为 token */
--bg-elevated: #1c1c20;                /* dialog/popover/dropdown 背景 (高于 bg-2) */
--ring-focus: rgba(94, 106, 210, 0.45); /* focus ring，用于键盘聚焦 (accent 35% alpha) */
--shadow-elev-2: 0 4px 12px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3); /* dialog/popover */
```

**禁止使用**：
- 任意硬编码 hex（`#1c3d5a` 等）必须改用 token 或 `color-mix()`
- 旧版 `role-badge--coder { background: #1c3d5a }` 这类硬编码改为 `color-mix(in oklab, var(--status-blue) 22%, var(--bg-2))`

### 4.2 Typography

```css
--font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
```

**字号体系**（保留 M5 13px 基线，追加 scale token）：

| Token | 像素 | 用途 |
|---|---|---|
| `--text-xs` | 10px | mono 标签、Footer、metadata |
| `--text-sm` | 11px | 副文本、placeholder hint |
| `--text-base` | 13px | 默认正文（M5 已是 13） |
| `--text-md` | 14px | 区块标题（Topbar、Pane header） |
| `--text-lg` | 15px | 主标题（dialog title） |

**Weight**：仅用 400 / 500 / 600 三档；不用 700 及以上，避免视觉重度过载。

### 4.3 Icon 系统

**强制规则**：
- UI chrome（Topbar / Sidebar / 按钮 / 状态指示）**不允许**出现 emoji
- 所有 icon 改用 `lucide-react`（package.json 已依赖 ^1.8.0）
- Worker 头像 emoji 改用"role-color block + initial"组合（详见 4.4）
- **唯一例外**：Footer "Hive runtime" 旁可保留小蜂窝图标作品牌锚点（用 lucide `Hexagon`，非 emoji）

**Icon 尺寸 token**：

| Token | 像素 | 用途 |
|---|---|---|
| `--icon-xs` | 12 | 行内、Footer |
| `--icon-sm` | 14 | Topbar 按钮、行卡 |
| `--icon-md` | 16 | Pane header、Drawer header |
| `--icon-lg` | 20 | 空态、Dialog |

**当前需替换的 emoji 清单**：

| 位置 | 现状 | 替换 |
|---|---|---|
| Topbar 品牌 | `🐝` | `<Hexagon size={16} />` + 文字 "Hive" |
| Topbar Task Graph 按钮 | `📋 Task Graph` | `<ListChecks size={14} />` + "Blueprint"（同时改名，见 §11.4） |
| Topbar Settings | `⚙️ Settings` | `<Settings size={14} />` |
| OrchestratorPane 头 | `👑 Queen` | `<Crown size={16} />` + "Queen" |
| OrchestratorPane 空态 | `👑` 大图 + tutorial | 见 §6.3 空态规范 |
| Worker 卡头像 | `role.emoji`（🐝🐝🐝） | role-block（详见 4.4） |
| WorkersPane "+ New Member" | `+ 文字` | `<UserPlus size={14} />` + "Add Member" |
| Footer 状态点 | `●` `○` 字符 | `<span class="dot dot--green/red">` 圆点 |
| Sidebar workspace working dot | `status-dot status-dot--working` | 保留（原本就是 div，非 emoji） |
| Stop/Restart 按钮 | `⏹` `↻` | `<Square size={12} />` `<RotateCcw size={12} />` |
| Start | `▶` | `<Play size={12} />` |

### 4.4 Role 视觉表达

**Worker 头像**统一为"role-block + initial"：

```
┌────┐
│ Co │ ← 32×32 圆角 8、role 色背景 12% alpha + role 色边框 35% alpha
└────┘   ← 内部 mono 大写 2 字符（Co / Re / Te / Cu / Or）+ role 色文字
```

| Role | 缩写 | 颜色 token |
|---|---|---|
| Orchestrator | Or | `--accent`（项目核心，独占 accent 色） |
| Coder | Co | `--status-blue` |
| Reviewer | Re | `--status-purple` |
| Tester | Te | `--status-orange` |
| Custom | Cu | `--text-secondary` |

**理由**：role-block 比 emoji 更具识别性（缩写直接说明角色）、跟 Linear 团队成员视觉风格一致、深色背景下不会有 emoji 在 macOS/Windows 跨平台渲染差异。

### 4.5 Motion / 动效规范

**全局 ease 与时长 token**：

```css
--ease-out: cubic-bezier(0.16, 0.84, 0.44, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
--dur-fast: 120ms;
--dur-base: 180ms;
--dur-slow: 280ms;
```

**强制规则**：
- **禁止**任何 `transform: translateY(-1px)` 一类的 hover 抬升动效（廉价 AI 味）
- card / row hover 仅用 `border-color` + `background` 渐变（120ms ease-out）
- 状态变化用 `opacity` + 颜色过渡，不用尺寸变化
- 脉动动画（`hive-pulse`）仅用于 `working` 状态，且**整屏最多 1 个工作流**同时脉动（多 worker 同时 working 时合并为 sidebar 顶层提示，避免视觉噪音）
- Drawer 滑入用 `transform: translateX` + 280ms `--ease-out`
- Dialog 进入：`opacity 0→1` + `scale 0.96→1`，180ms `--ease-out`

### 4.6 圆角 / 间距

**圆角 token**：

```css
--radius-sm: 4px;   /* badge / pill */
--radius-md: 6px;   /* button / input */
--radius-lg: 8px;   /* card / dialog / drawer corner */
--radius-xl: 12px;  /* 大型 panel */
```

**间距**沿用 Tailwind v4 默认 scale，但建立"垂直节奏"硬约束：
- 容器 padding：`px-4 py-3`（pane header）/ `px-3 py-2`（list row）
- 同级间距：`gap-2`（标签）/`gap-3`（按钮组）/`gap-4`（区块）
- 跨级缩进：每级 `pl-2`，禁止超过 3 级

---

## 5. 关键交互

### 5.1 命令 Palette（⌘K）

**触发**：⌘K（mac）/ Ctrl+K（win/linux）/ Topbar 中段按钮

**位置**：Inspector drawer 内（取代 worker 详情/activity，drawer 自动展开）。理由：palette 跟主区共存才能边搜边看上下文；不用居中弹窗。

**交互结构**：

```
┌─ Inspector ─────────────────┐
│ 🔍 Search or run a command  │
│ ─────────────────────────── │
│ Workspaces                  │
│   my-app          ⌘1        │
│   other-app       ⌘2        │
│ Workers (my-app)            │
│   Alice (Coder)             │
│   Bob (Tester)              │
│ Actions                     │
│   ⏵ Start Queen             │
│   ⏹ Stop Queen              │
│   + Add Worker              │
│   📋 Open Blueprint editor  │ (这里 palette 内允许保留装饰，因为是命令名)
│ Recent                      │
│   "implement login" → Alice │
└─────────────────────────────┘
```

**命令分组**（按 score 排序，默认显示）：

| Group | 命令例 | 处理 |
|---|---|---|
| Workspaces | 切到 N | `selectWorkspace(id)` |
| Workers | 选中 / 派单给 N | 选中 = 打开 worker drawer；派单 = 进入子模式 "Send task to N..." 收集文本 |
| Actions | Start/Stop/Restart Queen / Add Worker / Open Blueprint editor | 直接执行 |
| Recent dispatches | 历史 send 文本（最近 10 条） | 选中后填入 "Send task to ..." 子模式 |

**键盘**：
- `↑↓` 选择
- `Enter` 执行
- `⌘1` … `⌘9` 直接跳前 9 个 workspace
- `Esc` 关闭

**实现要点**：
- 列表数据源：`listWorkspaces()` + `useWorkspaceWorkers()` + 静态 actions table + `messages` 表 query (recent send)
- fuzzy match：自实现 subsequence match（无需新依赖；M6 不引入 cmdk 等大库）
- palette 状态独立 hook：`useCommandPalette()`

### 5.2 全局键盘快捷键

| 键 | 动作 |
|---|---|
| `⌘K` / `Ctrl+K` | 打开/关闭 palette |
| `⌘1` … `⌘9` | 切到第 N 个 workspace |
| `⌘⇧1` | canvas mode = balanced |
| `⌘⇧2` | canvas mode = queen-focus |
| `⌘⇧3` | canvas mode = workers-focus |
| `⌘⇧4` | canvas mode = blueprint-focus |
| `⌘\\` | 折叠/展开 sidebar |
| `⌘.` | 切换 inspector drawer |
| `⌘Enter` | （在 palette 中）确认选中 |
| `Esc` | 关闭顶层 overlay（palette > drawer > dialog） |
| `?` | 打开快捷键 cheatsheet（在 inspector drawer 显示） |

**冲突处理**：
- canvas mode 用 `⌘⇧[1-4]`，跟 workspace 切换 `⌘[1-9]` 区分清楚，不依赖上下文裁决
- 文本输入框聚焦时仅响应 `Esc` / `⌘K` / `⌘.`，其余快捷键不抢焦

**实现**：单一 `useKeyboardShortcuts()` hook 接 window keydown，按 `data-input-focused` / palette 状态分派。

### 5.3 状态视觉规范

**三态视觉一致性**（spec §3.6 三态）：

| 状态 | dot | pill 背景 | pill 边框 | pill 文字 |
|---|---|---|---|---|
| `idle` | `--text-tertiary` 实心 | `--bg-3` | `--border` | `--text-secondary` |
| `working` | `--status-green` 脉动 | `green 12%` | `green 35%` | `--status-green` |
| `stopped` (exit 0) | `--text-tertiary` | `--bg-3` | `--border` | `--text-secondary` |
| `stopped` (exit ≠ 0) | `--status-red` | `red 10%` | `red 32%` | `--status-red` |

**显示规则（强制）**：
- **status pill 与 queue badge 是两个正交维度**（spec §3.6 + §3.6.4）
- worker 行卡：左侧 dot 显 status；右侧 queue badge 仅在 `pending_task_count > 0` 时显示
- 不再像现状的 WorkerCard 一样底部再追加一行 "queue: N / N pending task(s)"（重复信息）
- sidebar 行：仅当 workspace 内有 worker 处于 `working` 时显示绿点；其他状态不显（保持现状）

### 5.4 错误 / 警告 / 通知

**Toast 系统**（自研，非全局组件库）：

```
位置：右下角，距 Footer 上 16px
最多 3 条，超过堆叠后压栈
默认存活：success 3s / warning 5s / error 持续直到点击关闭
进入：translateY 8px → 0 + opacity 0→1, 180ms
退出：opacity 1→0, 120ms
```

**类型**：
- `success`：绿点 + 文字（任务完成、worker 创建）
- `warning`：橙点 + 文字（连接中断、降级到 Layer B）
- `error`：红点 + 文字 + close 按钮（请求失败、PTY 启动失败）

**用法约束**：
- 现状的 "border-t bg-status-red/10 横亘底部" 错误条 全部改 toast
- Inline error（dialog 内表单错误）保留就近显示，不走 toast

### 5.5 Dialog 系统

**自研 Dialog**（已依赖 `@radix-ui/react-dialog`）替换 `window.confirm`：

```tsx
<Confirm
  title="Stop Queen?"
  description="The orchestrator PTY will be killed. Worker dispatches stay in queues."
  confirmLabel="Stop"
  confirmKind="danger"
  onConfirm={() => orchestrator.stop()}
/>
```

**视觉**：
- 居中弹窗，`max-w-[420px]`
- 背景 `--bg-elevated`，shadow `--shadow-elev-2`
- 入场动效见 §4.5

**强制**：所有 `window.confirm` / `window.alert` 必须删除。

### 5.6 三态空态

每个主要区块的空态有统一格式（不再是 trivial "No workspaces yet"）：

```tsx
<EmptyState
  icon={<Hexagon size={28} />}
  title="No workspaces yet"
  description="Add a workspace to get started. Hive will start an Orchestrator PTY and load your tasks.md."
  action={<Button onClick={onAdd}>Add Workspace</Button>}
/>
```

**应用位置**：
- Sidebar 无 workspace
- Workers Strip 无 worker
- Blueprint Bar tasks.md 不存在
- Inspector Activity 无消息

---

## 6. 组件清单

### 6.1 新增组件

| 组件 | 路径 | 用途 |
|---|---|---|
| `BlueprintBar` | `web/src/blueprint/BlueprintBar.tsx` | 顶部蓝图条容器（紧凑/展开/raw editor 三模式切换） |
| `WorkerRow` | `web/src/worker/WorkerRow.tsx` | 行卡（取代 WorkerCard） |
| `Inspector` | `web/src/inspector/Inspector.tsx` | 侧栏容器（多内容路由） |
| `WorkerInspector` | `web/src/inspector/WorkerInspector.tsx` | worker 详情（取代 WorkerModal） |
| `CommandPalette` | `web/src/inspector/CommandPalette.tsx` | ⌘K palette |
| `ActivityStream` | `web/src/inspector/ActivityStream.tsx` | 默认 activity 时间线 |
| `SettingsInspector` | `web/src/inspector/SettingsInspector.tsx` | 设置入口骨架（M6-D 仅占位，模板 CRUD 延后到 M7） |
| `KeyboardCheatsheet` | `web/src/inspector/KeyboardCheatsheet.tsx` | `?` 键打开的快捷键速查（drawer 内显示） |
| `Confirm` | `web/src/ui/Confirm.tsx` | 自研确认 dialog（替换 `window.confirm`） |
| `Toast` + `useToast` | `web/src/ui/toast.tsx` + `web/src/ui/useToast.ts` | toast 通知系统 |
| `EmptyState` | `web/src/ui/EmptyState.tsx` | 统一空态组件 |
| `RoleAvatar` | `web/src/worker/RoleAvatar.tsx` | role-block 头像（取代 emoji） |
| `Icon` | （直接 lucide-react import，不再包） | — |
| `useKeyboardShortcuts` | `web/src/hooks/useKeyboardShortcuts.ts` | 全局键盘 |
| `useCanvasMode` | `web/src/hooks/useCanvasMode.ts` | 三块面板伸缩状态 + localStorage |
| `useInspector` | `web/src/hooks/useInspector.ts` | inspector drawer 状态机 |
| `useCommandPaletteCommands` | `web/src/inspector/useCommandPaletteCommands.ts` | palette 命令源数据 |

### 6.2 修改组件

| 组件 | 改动 |
|---|---|
| `MainLayout` | 接 inspector / canvas mode；不再自己管 sidebar 折叠（移到 sidebar 自身） |
| `Topbar` | 删 emoji；加 breadcrumb（workspace › branch）；加 ⌘K 按钮、Inspector toggle |
| `Footer` | 删字符 ●○，改用 dot 类；加 ⌘? 提示 |
| `Sidebar` | 自身管折叠状态（icon-only / expanded） |
| `OrchestratorPane` | 删宽度 40% 写死、min-w-480；改为垂直堆叠中的一块；加折叠/全屏按钮；空态走 `EmptyState`；`window.confirm` → `<Confirm>` |
| `WorkersPane` | 删 grid，改为 `<WorkerRow>` 列表；header 加 mode toggle 按钮 |
| `WorkspaceDetail` | 重组为三块垂直堆叠；inline error 改 toast；删 WorkerModal 渲染 |
| `TaskGraphDrawer` | 改名 `BlueprintEditor`（仍渲染 task list + raw 切换），脱去 drawer 外壳，被 `BlueprintBar` 在展开模式内嵌渲染 |
| `TaskGraphRawEditor` | 改名 `BlueprintRawEditor`（仅命名，逻辑不变） |
| `App` (`web/src/app.tsx`) | ≤150 行约束保持，state 大量下沉到新 hook |
| `globals.css` | 追加 §4 token；删 `card:hover transform`；删 `.modal-backdrop`（改 `--bg-overlay`）|

### 6.3 删除组件

| 组件 | 替换 |
|---|---|
| `WorkerCard` | `WorkerRow` |
| `WorkerModal` | `WorkerInspector`（在 drawer 内） |
| 任何 `window.confirm` / `window.alert` 调用 | `<Confirm>` |

---

## 7. 数据流（不变 + 新增）

### 7.1 不变（保留 M5）
- workspace / worker 列表、tasks.md WS 流、PTY ws stream、startup config 等所有 server 端数据流
- workspace store / runtime store / agent runtime 端 API 完全保留

### 7.2 新增前端状态

| state | 位置 | 持久化 | 作用 |
|---|---|---|---|
| `canvasMode` | `useCanvasMode` | `localStorage` per workspace | 三块面板伸缩 |
| `inspector` | `useInspector` | session（关掉浏览器丢失） | drawer 状态机 |
| `commandPaletteOpen` | `useCommandPalette` | 不持久化 | palette 开关 |
| `paletteRecentDispatches` | 同上 | 由 server messages 表派生 | recent 命令源 |
| `toasts` | `useToast` | 不持久化 | toast 列表 |

### 7.3 新增 server 端只读 API（最小）

为了让 palette 显示 recent dispatches：

```
GET /api/ui/workspaces/:id/recent-dispatches?limit=10
  → [{ to_agent_id, to_agent_name, text, created_at }]
```

**约束**：
- 走 UI session token（`hive_ui_token` cookie）
- 实现：从现有 `messages` 表筛 `type='send'`，无需新表
- 不实现 server 端 push（M6 内 polling 或 manual refresh，刷 palette 时即时拉）

---

## 8. 错误处理

### 8.1 错误展示规则
| 来源 | 现状 | 重做 |
|---|---|---|
| WorkspaceDetail 底部 inline error 条 | `<p role="alert">` border-t | 删除，改 toast |
| OrchestratorPane 失败态 | inline body | 保留 inline + 追加 toast（中心确认 + 角落记录） |
| Worker create 失败 | inline | 保留 dialog 内 inline |
| API 网络错误 | 控制台/silent | 全部 toast (`error` kind) |

### 8.2 失败态可恢复性
- Queen 失败：placeholder body 显示 error + Retry 按钮（保留）
- Worker 失败：行卡显示 stopped + exit code，点开 inspector 看完整 PTY scrollback
- runtime 重启：Footer connected 灰，所有行卡 stopped，sidebar 全 idle dot

### 8.3 边界状态
- 切 workspace 时 inspector 自动关（避免显示无关 worker）
- 删除 worker 时若 inspector 正显示该 worker → 自动关
- workspace 列表为空进入 → empty state 引导添加（保留 M5 emptyStateTriggeredRef 行为）

---

## 9. 测试策略

### 9.1 保留的测试
所有 server / cli / shared / unit 测试不动。

### 9.2 修改的 web 测试
现有测试在 `tests/web/`：

| 测试 | 处置 |
|---|---|
| `app-shell.test.tsx` | 改：断言新布局（4 区） |
| `m5-linear-visual.test.tsx` | 删（M5 视觉冻结测试不再适用），改写为 `m6-redesign-visual.test.tsx` 断言新结构 |
| `orchestrator-pane.test.tsx` | 改：删 `window.confirm` 期望，改测 `<Confirm>` |
| `sidebar-workspace-flow.test.tsx` | 改：sidebar 折叠态测试 |
| `tasks-flow.test.tsx` | 改：blueprint bar 而非 drawer |
| `terminal-view.test.tsx` | 不变（PTY 流不动） |
| `worker-flow.test.tsx` | 改：WorkerRow + WorkerInspector |
| `worker-modal.test.tsx` | 删除 / 改名 `worker-inspector.test.tsx` |
| `workspace-create-initial-state.test.tsx` | 不变 |
| `workspace-flow.test.tsx` | 改：三块垂直堆叠断言 |
| `workspace-picker.test.tsx` | 不变 |

### 9.3 新增 web 测试

| 测试文件 | 覆盖 |
|---|---|
| `command-palette.test.tsx` | ⌘K 打开、命令搜索、Enter 执行、Esc 关闭 |
| `keyboard-shortcuts.test.tsx` | 全局快捷键路由（含输入框聚焦时的失活） |
| `inspector-state.test.tsx` | drawer 状态机切换 |
| `toast.test.tsx` | toast 入场 / 自动消失 / 手动关 |
| `confirm-dialog.test.tsx` | 替换 window.confirm 后流程 |
| `canvas-mode.test.tsx` | 三块面板 mode 切换 + localStorage 持久化 |
| `blueprint-bar.test.tsx` | Blueprint Bar 紧凑/展开 + 编辑落库 |
| `worker-row.test.tsx` | 行卡 status pill / queue badge 正交（spec §3.6.4） |
| `recent-dispatches-api.test.ts` | server 端 `/api/ui/workspaces/:id/recent-dispatches` 集成 |

### 9.4 测试纪律（沿用 AGENTS.md §三）
- 集成测试（`tests/integration/*` + `tests/server/*` + `tests/cli/*`）禁止 mock node-pty
- 每条 assert 自问"产品代码完全写反这断言还能过吗"
- 视觉重做不许写"循环验证"测试（断言自己 stub 出来的东西）

---

## 10. 实施分阶段

按 PR 大小拆 4 个 milestone（M6-A→M6-D），每个独立可发布、可单独 review：

### M6-A — 视觉系统与 chrome （最小风险）
- 4.1–4.6 全部 token 落 `globals.css`
- emoji 全替为 lucide icon（5 处替换）
- 删除 `card:hover transform`
- `RoleAvatar` 替换 emoji 头像
- 自研 `<Confirm>` 替换 `window.confirm`
- `<Toast>` + `useToast` 系统
- `<EmptyState>` 统一组件
- 现有结构不动，仅替换"皮"

**测试**：`confirm-dialog.test.tsx` `toast.test.tsx`，更新现有视觉测试。

### M6-B — 信息架构（结构重做）
- `MainLayout` 改三块垂直堆叠
- `BlueprintBar` 替换抽屉模式（保留 `BlueprintEditor` 为内部组件）
- `WorkerRow` 替换 `WorkerCard`
- `OrchestratorPane` 删 40% width + min-w 480 写死
- `useCanvasMode` hook + `localStorage` 持久化
- 删 `WorkerModal`（行卡点击行为暂留为 stub，到 M6-C 接 Inspector）

**测试**：`canvas-mode.test.tsx` `blueprint-bar.test.tsx` `worker-row.test.tsx`。

### M6-C — Inspector & Palette
- `Inspector` 容器 + `useInspector` 状态机
- `WorkerInspector`（在 drawer 内）取代 WorkerModal
- `CommandPalette` 实现 + fuzzy match
- `ActivityStream`
- server 端 `GET /api/ui/workspaces/:id/recent-dispatches`
- `useKeyboardShortcuts` 全局键盘

**测试**：`command-palette.test.tsx` `keyboard-shortcuts.test.tsx` `inspector-state.test.tsx` `recent-dispatches-api.test.ts`。

### M6-D — 收口
- 设置 drawer 骨架（仅放置，模板 CRUD 延后）
- 全部测试切到新结构
- 文档：README + CLAUDE.md "当前进度" 同步更新（顺手）
- AGENTS.md §10 单文件上限复检（确保 `app.tsx` ≤150 / 任何单 component ≤300）

**测试**：跑全套 `pnpm check && pnpm build && pnpm test`。

---

## 11. 产品 spec §6 修订（覆盖原文）

本节覆盖产品 spec [§6 前端 UI 设计](./2026-04-18-hive-design.md#61-主布局)。实施 M6 时同步修改产品 spec 引用本 spec。

### 11.1 §6.1 主布局
**原文**："三段结构：左 = Workspace 列表，中 = Orchestrator PTY，右 = Worker 卡片网格"
**改为**：四区复合（Topbar / WS Sidebar / Workspace Canvas / Inspector Drawer + Footer），canvas 内部三块垂直堆叠（Blueprint / Queen / Workers）。详见本文档 §3。

### 11.2 §6.3 Worker 卡片字段
**原文**：tile 卡片，2-3 列响应式
**改为**：行卡（WorkerRow），单行显示。点击打开 Inspector drawer 而非 WorkerModal。详见本文档 §6.1。

### 11.3 §6.4 添加 Worker 流程
不变（仍然 Add Worker dialog），仅视觉用新 `<Confirm>` / `<Dialog>` 系统。

### 11.4 §6.6 任务图抽屉
**原文**："抽屉打开后默认是渲染视图……右上角切换按钮可切到原始 markdown 编辑器"
**改为**：Blueprint Bar 常驻顶栏。紧凑模式仅显示进度条 + 计数；展开模式（按 ⌘3 或点 toggle）显示完整 task list；进一步进入 raw editor 模式（按钮切换）。详见本文档 §3.3。

**命名修订**：UI 内 "Task Graph" 全部改为 "Blueprint"（更贴蜂巢隐喻 + 跟产品 spec §13 命名"Hive Blueprint" 对齐）。

### 11.5 §6.5 角色模板管理
M6 不实施模板 CRUD，仅做 settings drawer 骨架。模板 CRUD 延到 M7。

---

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 行卡 + 垂直堆叠在小屏（< 720px）展示挤 | spec 明确不优化 < 720px；workers strip 内部允许横向溢出滚动 |
| 任务图常驻顶栏挤占 PTY 高度 | balanced 模式 blueprint 紧凑仅 40px；用户嫌挤可一键 ⌘1 切 queen-focus |
| 命令 palette 自实现 fuzzy match 效果差 | 先 ship MVP（subsequence），观察实际使用反馈；不行再换 cmdk 库（next milestone） |
| `useCanvasMode` localStorage per-workspace 数据膨胀 | 限制 key 上限（仅存 mode 字符串），workspace 删除时一并清理 |
| 现有 web 测试大量重写 | 在 M6-B/C 一次性完成，不留过渡测试；按 §9.2 表格逐项处理 |
| 用户不喜欢 blueprint 常驻 | 紧凑模式仅 40px，进入 queen-focus 模式后再折成 12px chip 行；不会逼用户看 |
| 全局键盘冲突浏览器原生 | `⌘\\` `⌘.` 不冲突；输入框聚焦时仅响应 `Esc` `⌘K` `⌘.`，不抢 `⌘1`–`⌘9` |
| 三块面板 grid-template-rows 切换抖动 | 用 grid + transition rows，避免重渲染 PTY；测试 canvas-mode 切换时 PTY xterm 不重 mount |

---

## 13. 后续路线（M6 之后）

- M7：Settings drawer 实质内容（角色模板 CRUD、preset CRUD）
- M8：浅色主题
- M9：Activity Stream → 真实 push（WS）替换 polling
- v0.3：i18n 文本提取
- v0.3：可选 cmdk 库替换自实现 fuzzy palette（如反馈差）

---

## 14. 命名

- "Task Graph" → **"Blueprint"**（同步产品 spec §13 命名）
- "Worker Card" → **"Worker Row"**
- "Worker Modal" → **"Worker Inspector"**
- "PTY pane" 内部俗称保留

---

## 附录 A：变更摘要（给 reviewer 一眼看完）

1. 主区从「左右分栏（Orch │ Workers）」→「垂直堆叠（Blueprint / Queen / Workers）」
2. 任务图从「按需抽屉」→「常驻顶栏 Blueprint Bar」
3. WorkerCard 网格 → WorkerRow 行卡列表
4. WorkerModal 全屏遮罩 → Inspector drawer（同屏共存）
5. 新增 ⌘K Command Palette
6. 新增全局键盘快捷键
7. 全局 emoji → lucide-react SVG
8. `window.confirm` → 自研 `<Confirm>` dialog
9. inline error 条 → Toast 通知
10. 三块面板伸缩：balanced / queen-focus / workers-focus / blueprint-focus（localStorage 持久化）
11. 视觉 token 追加：`--bg-overlay` `--bg-elevated` `--ring-focus` `--shadow-elev-2` + typography scale + icon scale + radius scale + motion scale
12. Worker 头像从 emoji → role-block "Co/Re/Te/Cu"
13. spec §6 修订（本文档 §11）
