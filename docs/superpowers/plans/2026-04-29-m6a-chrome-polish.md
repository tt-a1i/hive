# M6-A — Chrome Polish & 视觉系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M5 已有的 Linear dark shell 上做"皮"层重做：emoji 全替为 lucide SVG，自研 `EmptyState`/`Toast`/`Confirm`/`RoleAvatar` 通用组件，删除 `window.confirm` 和廉价 hover transform，inline error 改 toast。**不动信息架构**（M6-B 才做）。

**Architecture:**
- 新建 `web/src/ui/` 目录承载通用组件（`EmptyState` / `Toast` + `useToast` / `Confirm`）
- `web/src/worker/RoleAvatar.tsx` 用 role-block + initials 替换 emoji 头像
- `globals.css` 追加 motion / typography / icon / radius / overlay tokens；删除 `.card:hover` 的 `translateY(-1px)`
- `lucide-react` 替换所有 emoji 装饰（Hexagon / ListChecks / Settings / Crown / UserPlus / Play / Square / RotateCcw）
- `WorkspaceDetail` 的 inline error 横条改用 `useToast()` 通知
- `App` 顶层挂载 `<ToastProvider>`

**Tech Stack:** React 19 · Tailwind v4 · `@radix-ui/react-dialog@1.1.15` · `lucide-react@1.8.0` · Vitest + `@testing-library/react` + jsdom

**Spec：** [`docs/superpowers/specs/2026-04-29-hive-ui-redesign.md`](../specs/2026-04-29-hive-ui-redesign.md) §4 (视觉系统) + §6.2 修改组件 + §10 M6-A 范围

**TDD 纪律：** AGENTS.md §三 — 每条 assert 自问"产品代码完全写反这断言还能过吗"。集成测试不允许 mock node-pty（本 plan 全 web 单元测试，无 PTY）。

---

## File Structure

**Create:**
- `web/src/ui/EmptyState.tsx` — 统一空态组件
- `web/src/ui/toast.tsx` — `<Toaster>` 容器 + 单条 toast 渲染
- `web/src/ui/useToast.tsx` — `<ToastProvider>` + `useToast()` hook（context-based；含 JSX 故 `.tsx` 而非 spec §6.1 表格的 `.ts`）
- `web/src/ui/Confirm.tsx` — 自研确认 dialog（基于 `@radix-ui/react-dialog`）
- `web/src/worker/RoleAvatar.tsx` — role-block 头像（替换 emoji）
- `tests/web/empty-state.test.tsx`
- `tests/web/toast.test.tsx`
- `tests/web/confirm-dialog.test.tsx`
- `tests/web/role-avatar.test.tsx`

**Modify:**
- `web/src/styles/globals.css` — 追加 token / 删除 hover transform
- `web/src/worker/role-presentation.ts` — 删除 `emoji` 字段（破坏性，所有 caller 同 PR 改）
- `web/src/worker/OrchestratorPane.tsx` — emoji → Crown/Play/Square/RotateCcw；`window.confirm` → `<Confirm>`；空态 placeholder → `<EmptyState>`
- `web/src/worker/WorkerCard.tsx` — emoji 头像 → `<RoleAvatar>`
- `web/src/worker/WorkersPane.tsx` — `+` emoji → `<UserPlus>`
- `web/src/layout/Topbar.tsx` — 🐝/📋/⚙️ → Hexagon/ListChecks/Settings
- `web/src/layout/Footer.tsx` — `●○` 字符 → div dot
- `web/src/sidebar/Sidebar.tsx` — empty 文案 → `<EmptyState>`
- `web/src/WorkspaceDetail.tsx` — inline error band → `useToast()`
- `web/src/app.tsx` — 顶层挂 `<ToastProvider>`

**Update existing tests:**
- `tests/web/orchestrator-pane.test.tsx` — `window.confirm` 断言改 `<Confirm>` 流程；emoji 字符串断言改 lucide 渲染断言
- `tests/web/worker-flow.test.tsx` — emoji 头像断言改 `<RoleAvatar>`
- `tests/web/m5-linear-visual.test.tsx` — 删除（M5 视觉冻结测试不再适用）

---

## Test Style Cheatsheet

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
afterEach(() => cleanup())
```

约束：
- 所有 web 测试文件首行加 `// @vitest-environment jsdom`
- 用 `data-testid` 选择，避免脆弱的文本匹配
- 不允许 `expect(true).toBe(true)` / 仅 `not.toThrow()` / `expect(readFileSync).toContain(...)` （AGENTS.md §三）
- 每条 assert 必须能被"反向写产品代码"打破

---

## Task 1: 追加视觉 tokens 到 globals.css

**Files:**
- Modify: `web/src/styles/globals.css`

> tokens 是 CSS 变量，没有可独立验证的 behavior。后续组件 task 的视觉测试隐含验证 tokens 已就位。**本 task 不写专门测试**——按 AGENTS.md "禁止架构警察伪装成单测"的约束。

- [ ] **Step 1: 在 `:root` 块底部追加 token（在现有 `color-scheme: dark` 之前）**

修改 `web/src/styles/globals.css`，把现有 `:root { ... color-scheme: dark; }` 块替换为：

```css
:root {
  /* Linear dark — surfaces */
  --bg-0: #08090a;
  --bg-1: #0f0f11;
  --bg-2: #18181b;
  --bg-3: #232326;
  --bg-crust: #050506;

  /* M6 — overlay & elevated */
  --bg-overlay: rgba(8, 9, 10, 0.72);
  --bg-elevated: #1c1c20;

  /* Borders */
  --border: #222226;
  --border-bright: #2b2b30;

  /* Text */
  --text-primary: #f7f8f8;
  --text-secondary: #8a8f98;
  --text-tertiary: #62656c;

  /* Accent */
  --accent: #5e6ad2;
  --accent-hover: #7078e3;

  /* Status */
  --status-green: #3FB950;
  --status-orange: #D29922;
  --status-red: #F85149;
  --status-blue: #4C9AFF;
  --status-purple: #A371F7;
  --status-gold: #D4A72C;

  /* M6 — typography scale */
  --text-xs: 10px;
  --text-sm: 11px;
  --text-base: 13px;
  --text-md: 14px;
  --text-lg: 15px;

  /* M6 — icon scale */
  --icon-xs: 12px;
  --icon-sm: 14px;
  --icon-md: 16px;
  --icon-lg: 20px;

  /* M6 — radius scale */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;

  /* M6 — motion */
  --ease-out: cubic-bezier(0.16, 0.84, 0.44, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --dur-slow: 280ms;

  /* M6 — focus ring & elevation */
  --ring-focus: rgba(94, 106, 210, 0.45);
  --shadow-elev-2: 0 4px 12px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);

  color-scheme: dark;
}
```

- [ ] **Step 2: 同步 `@theme` 块（Tailwind v4 token 注入）**

在文件顶部 `@theme { ... }` 块的末尾大括号前追加：

```css
  /* M6 — overlay & elevated */
  --color-bg-overlay: rgba(8, 9, 10, 0.72);
  --color-bg-elevated: #1c1c20;
```

> 不把 typography/icon/radius/motion 暴露给 Tailwind `@theme` —— 它们仅在 `globals.css` 自定义类里用，不需要 utility 类。

- [ ] **Step 3: 验证 build 不挂**

```bash
pnpm exec vite build --config web/vite.config.ts
```

Expected: build 成功，无 css 解析错误。

- [ ] **Step 4: Commit**

```bash
git add web/src/styles/globals.css
git commit -m "feat(ui): M6-A token scale (typography/icon/radius/motion/overlay)"
```

---

## Task 2: 删除 `card:hover` 的 `translateY(-1px)`

**Files:**
- Modify: `web/src/styles/globals.css:227-230`

- [ ] **Step 1: 修改 `.card:hover` 规则**

将：

```css
.card:hover {
  border-color: var(--border-bright);
  transform: translateY(-1px);
}
```

改为：

```css
.card:hover {
  border-color: var(--border-bright);
  background: color-mix(in oklab, var(--bg-2) 85%, var(--bg-3));
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/styles/globals.css
git commit -m "refactor(ui): drop card hover translate (廉价动效) — replace with bg shift"
```

---

## Task 3: `EmptyState` 组件（TDD）

**Files:**
- Create: `web/src/ui/EmptyState.tsx`
- Test: `tests/web/empty-state.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/web/empty-state.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { EmptyState } from '../../web/src/ui/EmptyState.js'

afterEach(() => cleanup())

describe('EmptyState', () => {
  test('renders title + description, no action when not provided', () => {
    render(<EmptyState title="No workspaces" description="Add one to start" />)
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('No workspaces')
    expect(screen.getByTestId('empty-state-description')).toHaveTextContent('Add one to start')
    expect(screen.queryByTestId('empty-state-action')).toBeNull()
  })

  test('renders icon slot when provided', () => {
    render(
      <EmptyState
        title="t"
        description="d"
        icon={<svg data-testid="custom-icon" />}
      />
    )
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument()
  })

  test('renders action and triggers click', () => {
    const onClick = vi.fn()
    render(
      <EmptyState
        title="t"
        description="d"
        action={
          <button type="button" data-testid="empty-state-action" onClick={onClick}>
            Add
          </button>
        }
      />
    )
    fireEvent.click(screen.getByTestId('empty-state-action'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/web/empty-state.test.tsx
```

Expected: FAIL — module `web/src/ui/EmptyState` 不存在

- [ ] **Step 3: 实现 EmptyState**

`web/src/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
}

export const EmptyState = ({ title, description, icon, action }: EmptyStateProps) => (
  <div
    className="m-auto flex max-w-[360px] flex-col items-center gap-3 px-6 py-8 text-center"
    data-testid="empty-state"
  >
    {icon ? (
      <div className="text-ter" aria-hidden data-testid="empty-state-icon">
        {icon}
      </div>
    ) : null}
    <div className="text-md text-pri" data-testid="empty-state-title">
      {title}
    </div>
    <div className="text-sm text-ter" data-testid="empty-state-description">
      {description}
    </div>
    {action}
  </div>
)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm exec vitest run tests/web/empty-state.test.tsx
```

Expected: PASS — 3 个 test 全过

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/EmptyState.tsx tests/web/empty-state.test.tsx
git commit -m "feat(ui): EmptyState component"
```

---

## Task 4: `Toast` 系统（TDD）

**Files:**
- Create: `web/src/ui/useToast.ts`
- Create: `web/src/ui/toast.tsx`
- Test: `tests/web/toast.test.tsx`

> 设计：`<ToastProvider>` 包根，`useToast()` 返回 `{ show(opts), dismiss(id) }`；`<Toaster />` 是 portal-style 渲染容器（M6-A 简化为内联 div，不用 `createPortal`，挂在 ToastProvider 内部）。
> Toast 类型：`success`(3000ms) / `warning`(5000ms) / `error`(0 = 持续直到点关闭)。

- [ ] **Step 1: 写失败测试**

`tests/web/toast.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ToastProvider, useToast } from '../../web/src/ui/useToast.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

const wrap = (children: ReactNode) => <ToastProvider>{children}</ToastProvider>

const ShowButton = ({
  kind,
  message,
  durationMs,
}: {
  kind: 'success' | 'warning' | 'error'
  message: string
  durationMs?: number
}) => {
  const { show } = useToast()
  return (
    <button
      type="button"
      data-testid={`show-${kind}`}
      onClick={() => show({ kind, message, durationMs })}
    >
      show
    </button>
  )
}

describe('Toast system', () => {
  test('show success toast — appears, then auto-dismisses after 3000ms', () => {
    render(wrap(<ShowButton kind="success" message="hi" />))
    fireEvent.click(screen.getByTestId('show-success'))

    expect(screen.getByTestId('toast').textContent).toContain('hi')
    expect(screen.getByTestId('toast').getAttribute('data-kind')).toBe('success')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('error toast — stays until manual close (durationMs=0 default for error)', () => {
    render(wrap(<ShowButton kind="error" message="boom" />))
    fireEvent.click(screen.getByTestId('show-error'))

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('toast-close'))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('warning toast — auto-dismisses after 5000ms', () => {
    render(wrap(<ShowButton kind="warning" message="careful" />))
    fireEvent.click(screen.getByTestId('show-warning'))

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('explicit durationMs override wins', () => {
    render(wrap(<ShowButton kind="success" message="custom" durationMs={500} />))
    fireEvent.click(screen.getByTestId('show-success'))

    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('throws when used outside provider', () => {
    const Bad = () => {
      useToast()
      return null
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Bad />)).toThrow(/ToastProvider/)
    consoleError.mockRestore()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/web/toast.test.tsx
```

Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现 useToast.tsx**

`web/src/ui/useToast.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'success' | 'warning' | 'error'

export interface ToastEntry {
  id: string
  kind: ToastKind
  message: string
}

interface ShowOptions {
  kind: ToastKind
  message: string
  /** ms; defaults: success=3000, warning=5000, error=0 (sticky). 0 = 永不自动关 */
  durationMs?: number
}

interface ToastApi {
  show: (opts: ShowOptions) => string
  dismiss: (id: string) => void
  toasts: ToastEntry[]
}

const ToastContext = createContext<ToastApi | null>(null)

const defaultDuration = (kind: ToastKind): number => {
  if (kind === 'success') return 3000
  if (kind === 'warning') return 5000
  return 0
}

const generateId = () => `t-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    ({ kind, message, durationMs }: ShowOptions): string => {
      const id = generateId()
      setToasts((current) => [...current, { id, kind, message }])
      const ms = durationMs ?? defaultDuration(kind)
      if (ms > 0) {
        const timer = setTimeout(() => dismiss(id), ms)
        timers.current.set(id, timer)
      }
      return id
    },
    [dismiss]
  )

  useEffect(() => {
    const timersAtMount = timers.current
    return () => {
      for (const timer of timersAtMount.values()) clearTimeout(timer)
      timersAtMount.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={{ show, dismiss, toasts }}>{children}</ToastContext.Provider>
  )
}

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
```

> 设计：`<Toaster />` **不在** `ToastProvider` 内部自动渲染，而是由 caller（`app.tsx`）显式挂在 Provider 内的 children 末尾。这避免了 useToast.ts ↔ toast.tsx 循环 import，且让 Toaster 容器位置可控。文件后缀用 `.ts` 还是 `.tsx`：含 JSX 的 ToastProvider 必须是 `.tsx` —— 把文件名改为 `web/src/ui/useToast.tsx`（即建立时直接命名 .tsx）。所有 import path 改用 `./useToast.js`（仍能被 ESM 解析为 .tsx 源文件）。

> ⚠️ Spec §6.1 表格写的是 `useToast.ts`，但因为含 JSX，必须 `.tsx`。这是 spec 笔误，按 `.tsx` 实施。

- [ ] **Step 4: 实现 Toaster**

`web/src/ui/toast.tsx`:

```tsx
import { useToast } from './useToast.js'

export const Toaster = () => {
  const { toasts, dismiss } = useToast()
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-8 z-50 flex flex-col gap-2"
      data-testid="toaster"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          data-kind={toast.kind}
          className="pointer-events-auto flex min-w-[260px] max-w-[400px] items-start gap-3 rounded-lg border px-3 py-2"
          style={{
            background: 'var(--bg-elevated)',
            borderColor:
              toast.kind === 'error'
                ? 'color-mix(in oklab, var(--status-red) 35%, var(--border))'
                : toast.kind === 'warning'
                  ? 'color-mix(in oklab, var(--status-orange) 35%, var(--border))'
                  : 'color-mix(in oklab, var(--status-green) 35%, var(--border))',
            boxShadow: 'var(--shadow-elev-2)',
          }}
        >
          <span
            className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
            style={{
              background:
                toast.kind === 'error'
                  ? 'var(--status-red)'
                  : toast.kind === 'warning'
                    ? 'var(--status-orange)'
                    : 'var(--status-green)',
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1 break-words text-sm text-pri">{toast.message}</div>
          <button
            type="button"
            data-testid="toast-close"
            onClick={() => dismiss(toast.id)}
            className="rounded p-0.5 text-ter hover:text-pri"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 在测试 `wrap` 里挂 `<Toaster />`**

修改 `tests/web/toast.test.tsx` 顶部 import 加：

```tsx
import { Toaster } from '../../web/src/ui/toast.js'
```

并将 `wrap` 改为同时渲染 Toaster：

```tsx
const wrap = (children: ReactNode) => (
  <ToastProvider>
    {children}
    <Toaster />
  </ToastProvider>
)
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm exec vitest run tests/web/toast.test.tsx
```

Expected: PASS — 5 个 test 全过。

- [ ] **Step 7: Commit**

```bash
git add web/src/ui/useToast.tsx web/src/ui/toast.tsx tests/web/toast.test.tsx
git commit -m "feat(ui): Toast system (success/warning/error + auto-dismiss)"
```

---

## Task 5: `Confirm` dialog（TDD）

**Files:**
- Create: `web/src/ui/Confirm.tsx`
- Test: `tests/web/confirm-dialog.test.tsx`

> 用 `@radix-ui/react-dialog` 作 a11y 基座，自定义 styling。`<Confirm>` 接受 `open` props（受控）+ 回调；不内置 `useConfirm()` hook（M6-A 范围内 caller 自己 useState）。

- [ ] **Step 1: 写失败测试**

`tests/web/confirm-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Confirm } from '../../web/src/ui/Confirm.js'

afterEach(() => cleanup())

describe('Confirm dialog', () => {
  test('renders when open=true; click confirm calls onConfirm and closes', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Confirm
        open
        onOpenChange={onOpenChange}
        title="Stop Queen?"
        description="The PTY will be killed."
        confirmLabel="Stop"
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')
    expect(screen.getByTestId('confirm-description')).toHaveTextContent('The PTY will be killed.')

    fireEvent.click(screen.getByTestId('confirm-action'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('cancel button calls onOpenChange(false), not onConfirm', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <Confirm
        open
        onOpenChange={onOpenChange}
        title="t"
        description="d"
        confirmLabel="OK"
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('open=false does not render dialog content', () => {
    render(
      <Confirm
        open={false}
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="OK"
        onConfirm={() => {}}
      />
    )
    expect(screen.queryByTestId('confirm-title')).toBeNull()
  })

  test('confirmKind=danger applies danger styling on action button', () => {
    render(
      <Confirm
        open
        onOpenChange={() => {}}
        title="t"
        description="d"
        confirmLabel="Delete"
        confirmKind="danger"
        onConfirm={() => {}}
      />
    )
    expect(screen.getByTestId('confirm-action').className).toContain('icon-btn--danger')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/web/confirm-dialog.test.tsx
```

Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现 Confirm**

`web/src/ui/Confirm.tsx`:

```tsx
import * as Dialog from '@radix-ui/react-dialog'

type ConfirmKind = 'default' | 'danger'

type ConfirmProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  confirmKind?: ConfirmKind
  cancelLabel?: string
  onConfirm: () => void
}

export const Confirm = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmKind = 'default',
  cancelLabel = 'Cancel',
  onConfirm,
}: ConfirmProps) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay
        data-testid="confirm-overlay"
        className="fixed inset-0 z-40"
        style={{ background: 'var(--bg-overlay)' }}
      />
      <Dialog.Content
        data-testid="confirm-content"
        className="fixed top-1/2 left-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-bright)',
          boxShadow: 'var(--shadow-elev-2)',
        }}
      >
        <Dialog.Title data-testid="confirm-title" className="text-md font-medium text-pri">
          {title}
        </Dialog.Title>
        <Dialog.Description
          data-testid="confirm-description"
          className="mt-2 text-sm text-sec"
        >
          {description}
        </Dialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={() => onOpenChange(false)}
            className="icon-btn"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid="confirm-action"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
            className={
              confirmKind === 'danger' ? 'icon-btn icon-btn--danger' : 'icon-btn icon-btn--primary'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm exec vitest run tests/web/confirm-dialog.test.tsx
```

Expected: PASS — 4 个 test 全过。

> ⚠️ 若 radix `Dialog.Portal` 在 jsdom 渲染到 `document.body` 而 `screen.getByTestId` 找不到，则把 portal container 显式传 `<Dialog.Portal container={document.body}>`。jsdom 默认应该能找到。

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/Confirm.tsx tests/web/confirm-dialog.test.tsx
git commit -m "feat(ui): Confirm dialog (replaces window.confirm)"
```

---

## Task 6: `RoleAvatar` 组件（TDD）

**Files:**
- Create: `web/src/worker/RoleAvatar.tsx`
- Test: `tests/web/role-avatar.test.tsx`

> 头像 = role-block：32×32 圆角 8、role-color 12% alpha 背景 + 35% alpha 边框 + role-color 文字（initials 2 字符大写）。

- [ ] **Step 1: 写失败测试**

`tests/web/role-avatar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { RoleAvatar } from '../../web/src/worker/RoleAvatar.js'

afterEach(() => cleanup())

describe('RoleAvatar', () => {
  test.each([
    ['coder', 'Co'],
    ['reviewer', 'Re'],
    ['tester', 'Te'],
    ['custom', 'Cu'],
    ['orchestrator', 'Or'],
  ])('role=%s renders initials %s', (role, expected) => {
    render(<RoleAvatar role={role as never} />)
    expect(screen.getByTestId('role-avatar').textContent).toBe(expected)
  })

  test('data-role attribute reflects role for theming', () => {
    render(<RoleAvatar role="coder" />)
    expect(screen.getByTestId('role-avatar').getAttribute('data-role')).toBe('coder')
  })

  test('size prop controls width/height', () => {
    render(<RoleAvatar role="coder" size={40} />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('40px')
    expect(el.style.height).toBe('40px')
  })

  test('default size is 32px', () => {
    render(<RoleAvatar role="coder" />)
    const el = screen.getByTestId('role-avatar')
    expect(el.style.width).toBe('32px')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm exec vitest run tests/web/role-avatar.test.tsx
```

Expected: FAIL — module 不存在。

- [ ] **Step 3: 实现 RoleAvatar**

`web/src/worker/RoleAvatar.tsx`:

```tsx
import type { WorkerRole } from '../../../src/shared/types.js'

type FullRole = WorkerRole | 'orchestrator'

type RoleAvatarProps = {
  role: FullRole
  size?: number
}

const initialsByRole: Record<FullRole, string> = {
  orchestrator: 'Or',
  coder: 'Co',
  reviewer: 'Re',
  tester: 'Te',
  custom: 'Cu',
}

const colorByRole: Record<FullRole, string> = {
  orchestrator: 'var(--accent)',
  coder: 'var(--status-blue)',
  reviewer: 'var(--status-purple)',
  tester: 'var(--status-orange)',
  custom: 'var(--text-secondary)',
}

export const RoleAvatar = ({ role, size = 32 }: RoleAvatarProps) => {
  const color = colorByRole[role]
  const initials = initialsByRole[role]
  return (
    <span
      data-testid="role-avatar"
      data-role={role}
      className="mono inline-flex shrink-0 items-center justify-center rounded-lg font-semibold"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.34)}px`,
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm exec vitest run tests/web/role-avatar.test.tsx
```

Expected: PASS — 全 5 个 case 过（4 个 role + size + default size + data-role）。

- [ ] **Step 5: Commit**

```bash
git add web/src/worker/RoleAvatar.tsx tests/web/role-avatar.test.tsx
git commit -m "feat(ui): RoleAvatar (role-block initials, replaces emoji avatars)"
```

---

## Task 7: 删除 `role-presentation.ts` 的 emoji 字段（破坏性，所有 caller 同步改）

**Files:**
- Modify: `web/src/worker/role-presentation.ts`
- Modify: `web/src/worker/WorkerCard.tsx`（同 task 8 处理细节）

> 这步不能单独 commit 提前——会断 build。实际上跟 Task 8 合并提交。先做 7 的修改，紧接着做 8 的修改后再 commit。

- [ ] **Step 1: 修改 `role-presentation.ts` 删 emoji 字段**

将文件内容替换为：

```ts
import type { WorkerRole } from '../../../src/shared/types.js'

export interface RolePresentation {
  badgeClass: string
  label: string
}

export const getRolePresentation = (role: WorkerRole): RolePresentation => {
  switch (role) {
    case 'coder':
      return { badgeClass: 'role-badge--coder', label: 'Coder' }
    case 'tester':
      return { badgeClass: 'role-badge--tester', label: 'Tester' }
    case 'reviewer':
      return { badgeClass: 'role-badge--reviewer', label: 'Reviewer' }
    case 'custom':
      return { badgeClass: 'role-badge--custom', label: 'Custom' }
    default:
      return { badgeClass: 'role-badge--custom', label: String(role) }
  }
}
```

> 不 commit ——立即接 Task 8。

---

## Task 8: WorkerCard 用 `RoleAvatar` 替换 emoji 头像

**Files:**
- Modify: `web/src/worker/WorkerCard.tsx`
- Modify: `tests/web/worker-flow.test.tsx`（断言更新）

- [ ] **Step 1: 改 WorkerCard**

修改 `web/src/worker/WorkerCard.tsx`，将 import 区改为：

```tsx
import type { TeamListItem } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerQueue, presentWorkerStatus } from './worker-status.js'
```

把 emoji 头像那块（原代码 `<span className="text-3xl leading-none" aria-hidden>{role.emoji}</span>`）替换为：

```tsx
<RoleAvatar role={worker.role} size={40} />
```

整个 WorkerCard 文件变为：

```tsx
import type { TeamListItem } from '../../../src/shared/types.js'
import { RoleAvatar } from './RoleAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { presentWorkerQueue, presentWorkerStatus } from './worker-status.js'

type WorkerCardProps = {
  onClick: (worker: TeamListItem) => void
  worker: TeamListItem
}

export const WorkerCard = ({ onClick, worker }: WorkerCardProps) => {
  const role = getRolePresentation(worker.role)
  const status = presentWorkerStatus(worker)
  const queue = presentWorkerQueue(worker)
  return (
    <button
      type="button"
      onClick={() => onClick(worker)}
      aria-label={`Open ${worker.name}`}
      className="card card--interactive p-4 text-left"
      data-testid={`worker-card-${worker.id}`}
      data-status={status.kind}
    >
      <div className="flex items-start gap-3">
        <RoleAvatar role={worker.role} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-pri">{worker.name}</span>
            <span className={`role-badge ${role.badgeClass}`}>{role.label}</span>
          </div>
          <div className="mono mt-0.5 truncate text-[11px] text-ter">{worker.role}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`status-pill status-pill--${status.kind}`}
            title={status.label}
            role="status"
          >
            <span className={status.dotClass} aria-hidden />
            {status.label}
          </span>
          {queue ? (
            <span
              className="queue-badge"
              title={`${queue.count} pending dispatch(es) — independent of PTY state`}
            >
              <span className="status-dot status-dot--queued" aria-hidden />
              {queue.label}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}
```

> 注意：删掉了原本底部 `<div className="mt-3 flex items-center justify-between text-[11px] text-ter">` 那一行 "queue: N / N pending task(s)" 重复信息。

- [ ] **Step 2: 更新现有 worker-flow 测试**

打开 `tests/web/worker-flow.test.tsx`，搜索任何断言 emoji 字符（如 `🐝`、`expect(...).toContain('🐝')`、`getByText('🐝')`）。删除这些断言；如果某测试只为验证 emoji 渲染，改为验证 `data-testid="role-avatar"` 存在 + `data-role` 正确：

```tsx
const avatar = within(card).getByTestId('role-avatar')
expect(avatar.getAttribute('data-role')).toBe('coder')
```

> 修改具体哪几行依测试当前内容；执行时打开文件 grep `emoji` / 表情字符 后逐处改。

- [ ] **Step 3: 跑全套 web 测试确认通过**

```bash
pnpm exec vitest run tests/web/worker-flow.test.tsx tests/web/role-avatar.test.tsx
```

Expected: PASS。

- [ ] **Step 4: Commit (Task 7 + 8 合并)**

```bash
git add web/src/worker/role-presentation.ts web/src/worker/WorkerCard.tsx tests/web/worker-flow.test.tsx
git commit -m "feat(ui): WorkerCard uses RoleAvatar — drop role.emoji + duplicate queue footer"
```

---

## Task 9: OrchestratorPane — 替换 emoji + `window.confirm`

**Files:**
- Modify: `web/src/worker/OrchestratorPane.tsx`
- Modify: `tests/web/orchestrator-pane.test.tsx`

涉及四处变化：
1. Header 的 `👑` emoji → `<Crown size={16} />`
2. Header actions 的 `⏹` `↻` `▶` → `<Square>` `<RotateCcw>` `<Play>`（小尺寸 12）
3. Stop / Restart 的 `window.confirm` → 受控 `<Confirm>`
4. PlaceholderBody 的 idle 大图 `👑` 与 tutorial → `<EmptyState>` 配 Crown icon + 简化 description

- [ ] **Step 1: 改 OrchestratorPane**

将文件整体替换为：

```tsx
import { Crown, Play, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'

import { Confirm } from '../ui/Confirm.js'
import { EmptyState } from '../ui/EmptyState.js'

export type OrchestratorPaneState =
  | { kind: 'idle' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  agentModel?: string
  state: OrchestratorPaneState
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

const StatusPill = ({ state }: { state: OrchestratorPaneState }) => {
  if (state.kind === 'running')
    return (
      <span className="status-pill status-pill--working" data-testid="orch-status-running">
        <span className="status-dot status-dot--working" aria-hidden />
        running
      </span>
    )
  if (state.kind === 'failed')
    return (
      <span className="status-pill status-pill--stopped" data-testid="orch-status-failed">
        <span className="status-dot status-dot--stopped" aria-hidden />
        failed
      </span>
    )
  return (
    <span className="status-pill status-pill--stopped" data-testid="orch-status-stopped">
      <span className="status-dot status-dot--stopped" aria-hidden />
      stopped
    </span>
  )
}

const HeaderActions = ({
  state,
  onStart,
  onAskStop,
  onAskRestart,
}: {
  state: OrchestratorPaneState
  onStart: () => void
  onAskStop: () => void
  onAskRestart: () => void
}) => {
  if (state.kind === 'running') {
    return (
      <div className="flex gap-1.5" data-testid="orchestrator-running-actions">
        <button
          type="button"
          onClick={onAskStop}
          className="icon-btn"
          data-testid="orchestrator-stop"
        >
          <Square size={12} aria-hidden /> Stop
        </button>
        <button
          type="button"
          onClick={onAskRestart}
          className="icon-btn"
          data-testid="orchestrator-restart"
        >
          <RotateCcw size={12} aria-hidden /> Restart
        </button>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <button
        type="button"
        onClick={onAskRestart}
        className="icon-btn icon-btn--primary"
        data-testid="orchestrator-retry-header"
      >
        <RotateCcw size={12} aria-hidden /> Retry
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="icon-btn icon-btn--primary"
      data-testid="orchestrator-start-header"
    >
      <Play size={12} aria-hidden /> Start
    </button>
  )
}

const PlaceholderBody = ({
  state,
  onStart,
  onRestart,
}: {
  state: OrchestratorPaneState
  onStart: () => void
  onRestart: () => void
}) => {
  if (state.kind === 'failed') {
    return (
      <EmptyState
        icon={<Crown size={28} />}
        title="Queen failed to start"
        description={state.error}
        action={
          <button
            type="button"
            onClick={onRestart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-retry"
          >
            <RotateCcw size={12} aria-hidden /> Retry
          </button>
        }
      />
    )
  }
  return (
    <EmptyState
      icon={<Crown size={28} />}
      title="Queen is offline"
      description="Start the orchestrator PTY to begin dispatching team members."
      action={
        <button
          type="button"
          onClick={onStart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-start"
        >
          <Play size={12} aria-hidden /> Start Queen
        </button>
      }
    />
  )
}

export const OrchestratorPane = ({
  agentModel = 'claude',
  state,
  onStart,
  onStop,
  onRestart,
}: OrchestratorPaneProps) => {
  const [confirmKind, setConfirmKind] = useState<'stop' | 'restart' | null>(null)

  const closeConfirm = () => setConfirmKind(null)
  const onConfirmAction = () => {
    if (confirmKind === 'stop') onStop()
    if (confirmKind === 'restart') onRestart()
  }

  return (
    <div
      className="flex min-w-[480px] flex-col border-r"
      style={{ width: '40%', borderColor: 'var(--border)' }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      >
        <Crown size={16} aria-hidden className="text-pri" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-pri">Queen</div>
          <div className="mono truncate text-[11px] text-ter">Orchestrator · {agentModel}</div>
        </div>
        <StatusPill state={state} />
        <HeaderActions
          state={state}
          onStart={onStart}
          onAskStop={() => setConfirmKind('stop')}
          onAskRestart={() => setConfirmKind('restart')}
        />
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col p-2"
        style={{ background: 'var(--bg-1)' }}
        data-testid="orchestrator-terminal-slot"
      >
        <div
          className="flex min-h-0 flex-1 rounded border"
          style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
        >
          {state.kind === 'running' ? (
            <div
              id={`orch-pty-${state.runId}`}
              className="flex h-full w-full"
              data-pty-slot="orchestrator"
            />
          ) : (
            <PlaceholderBody state={state} onStart={onStart} onRestart={onRestart} />
          )}
        </div>
      </div>

      <Confirm
        open={confirmKind === 'stop'}
        onOpenChange={(open) => !open && closeConfirm()}
        title="Stop Queen?"
        description="The orchestrator PTY will be killed. Worker dispatches stay in their queues."
        confirmLabel="Stop"
        confirmKind="danger"
        onConfirm={onConfirmAction}
      />
      <Confirm
        open={confirmKind === 'restart'}
        onOpenChange={(open) => !open && closeConfirm()}
        title="Restart Queen?"
        description="The current PTY will be killed and a new orchestrator will start (resuming session if supported)."
        confirmLabel="Restart"
        onConfirm={onConfirmAction}
      />
    </div>
  )
}
```

- [ ] **Step 2: 更新 orchestrator-pane.test.tsx 删 `window.confirm` 期望**

打开 `tests/web/orchestrator-pane.test.tsx`，把测试 "running: header exposes ⏹ Stop + ↻ Restart" 与 "running: declining confirm() cancels Stop / Restart" 改写为基于 `<Confirm>` 流程：

```tsx
test('running: clicking Stop opens Confirm dialog; confirming triggers onStop', () => {
  const { onStart, onStop, onRestart } = renderPane({ kind: 'running', runId: 'run-abc' })

  // Header buttons exist (icons rendered as svg, assert by data-testid)
  const stopBtn = screen.getByTestId('orchestrator-stop')
  const restartBtn = screen.getByTestId('orchestrator-restart')
  expect(stopBtn).toBeInTheDocument()
  expect(restartBtn).toBeInTheDocument()

  // PTY slot
  const slot = document.getElementById('orch-pty-run-abc')
  expect(slot).not.toBeNull()
  expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

  fireEvent.click(stopBtn)
  // Confirm opens
  expect(screen.getByTestId('confirm-title')).toHaveTextContent('Stop Queen?')
  expect(onStop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('confirm-action'))
  expect(onStop).toHaveBeenCalledTimes(1)

  // Restart flow
  fireEvent.click(restartBtn)
  expect(screen.getByTestId('confirm-title')).toHaveTextContent('Restart Queen?')
  fireEvent.click(screen.getByTestId('confirm-action'))
  expect(onRestart).toHaveBeenCalledTimes(1)
  expect(onStart).not.toHaveBeenCalled()
})

test('running: clicking Stop then Cancel keeps PTY alive', () => {
  const { onStop } = renderPane({ kind: 'running', runId: 'run-abc' })
  fireEvent.click(screen.getByTestId('orchestrator-stop'))
  fireEvent.click(screen.getByTestId('confirm-cancel'))
  expect(onStop).not.toHaveBeenCalled()
})
```

把原 "declining confirm() cancels" 测试整段替换为上面 cancel 流程测试。删除所有 `vi.spyOn(window, 'confirm')` 语句。

idle test 中 `expect(startBtn).toHaveTextContent('▶ Start Queen')` 改为：

```tsx
expect(startBtn).toHaveTextContent('Start Queen')
```

（`<Play>` 图标在 jsdom 渲染为 svg 不会进 textContent）

failed test 中类似把 `↻` 字符断言去掉，仅断言 testId 存在 + textContent 含 "Retry"。

- [ ] **Step 3: 跑测试**

```bash
pnpm exec vitest run tests/web/orchestrator-pane.test.tsx
```

Expected: PASS（idle / running / running cancel / failed 4 个 case）。

- [ ] **Step 4: Commit**

```bash
git add web/src/worker/OrchestratorPane.tsx tests/web/orchestrator-pane.test.tsx
git commit -m "feat(ui): OrchestratorPane — lucide icons + Confirm dialog (kill window.confirm) + EmptyState"
```

---

## Task 10: WorkersPane — 替换 emoji + 加 UserPlus icon

**Files:**
- Modify: `web/src/worker/WorkersPane.tsx`

- [ ] **Step 1: 改 WorkersPane**

将文件整体替换为：

```tsx
import { UserPlus } from 'lucide-react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { WorkerCard } from './WorkerCard.js'

type WorkersPaneProps = {
  onAddWorkerClick: () => void
  onOpenWorker: (worker: TeamListItem) => void
  workers: TeamListItem[]
}

export const WorkersPane = ({ onAddWorkerClick, onOpenWorker, workers }: WorkersPaneProps) => (
  <div className="flex min-w-0 flex-1 flex-col">
    <div
      className="flex shrink-0 items-center gap-3 border-b px-4 py-2"
      style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
    >
      <span className="font-medium text-pri">Team Members</span>
      <span className="rounded bg-3 px-1.5 py-0.5 mono text-[10px] text-sec">{workers.length}</span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onAddWorkerClick}
        className="icon-btn icon-btn--primary"
        data-testid="add-worker-trigger"
      >
        <UserPlus size={14} aria-hidden /> Add Member
      </button>
    </div>

    <div className="flex-1 scroll-y p-4">
      <ul
        aria-label="Team members"
        className="grid grid-cols-1 gap-3 lg:grid-cols-2"
        data-testid="worker-grid"
      >
        <li>
          <button
            type="button"
            onClick={onAddWorkerClick}
            className="card flex min-h-[112px] w-full flex-col items-center justify-center gap-2 p-4 text-ter hover:text-sec"
            style={{ borderStyle: 'dashed' }}
          >
            <UserPlus size={20} aria-hidden />
            <span className="text-xs">Add Member</span>
            <span className="text-[10px] text-ter">Coder · Reviewer · Tester · Custom</span>
          </button>
        </li>
        {workers.map((worker) => (
          <li key={worker.id}>
            <WorkerCard worker={worker} onClick={onOpenWorker} />
          </li>
        ))}
      </ul>
      {workers.length === 0 ? (
        <p className="mt-6 max-w-[420px] text-[11px] text-ter">
          Team members are CLI agents (Claude, Codex, OpenCode, …) running as PTYs in this
          workspace. The Orchestrator dispatches work to them via{' '}
          <span className="mono">team send</span> and they reply via{' '}
          <span className="mono">team report</span>.
        </p>
      ) : null}
    </div>
  </div>
)
```

- [ ] **Step 2: 跑现有 worker-flow 测试**

```bash
pnpm exec vitest run tests/web/worker-flow.test.tsx
```

如果失败因为 "+ New Member" 文字断言变了（改为 "Add Member"），就把测试相应文字断言更新。

- [ ] **Step 3: Commit**

```bash
git add web/src/worker/WorkersPane.tsx
git commit -m "feat(ui): WorkersPane uses UserPlus icon + 'Add Member' label"
```

---

## Task 11: Topbar — 替换 emoji

**Files:**
- Modify: `web/src/layout/Topbar.tsx`

- [ ] **Step 1: 改 Topbar**

```tsx
import { Hexagon, ListChecks, Settings as SettingsIcon } from 'lucide-react'

type TopbarProps = {
  onToggleTaskGraph: () => void
  taskGraphOpen: boolean
  version?: string
}

export const Topbar = ({ onToggleTaskGraph, taskGraphOpen, version = 'v0.1' }: TopbarProps) => (
  <header
    className="flex h-11 shrink-0 items-center border-b px-4"
    style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
  >
    <div className="flex items-center gap-2">
      <Hexagon size={16} className="text-pri" aria-hidden />
      <span className="font-semibold text-pri">Hive</span>
      <span className="text-ter text-xs">{version}</span>
    </div>
    <div className="flex-1" />
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToggleTaskGraph}
        aria-pressed={taskGraphOpen}
        aria-label="Toggle task graph"
        className="flex items-center gap-1.5 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
        data-testid="topbar-blueprint"
      >
        <ListChecks size={14} aria-hidden />
        <span>Blueprint</span>
      </button>
      <button
        type="button"
        aria-label="Settings"
        className="flex items-center gap-1.5 rounded px-3 py-1 text-xs text-sec hover:bg-3 hover:text-pri"
        data-testid="topbar-settings"
      >
        <SettingsIcon size={14} aria-hidden />
        <span>Settings</span>
      </button>
    </div>
  </header>
)
```

> 注意：Topbar 文字 "Task Graph" 改为 "Blueprint"（spec §11.4 命名）。但 prop 名 `onToggleTaskGraph` 暂时保留（避免连带改 App.tsx 太多），M6-B 时再统一改名。

- [ ] **Step 2: 跑相关测试**

```bash
pnpm exec vitest run tests/web/app-shell.test.tsx
```

如果失败因为 "Task Graph" 文字断言改了，更新测试断言为 "Blueprint"。

- [ ] **Step 3: Commit**

```bash
git add web/src/layout/Topbar.tsx tests/web/app-shell.test.tsx
git commit -m "feat(ui): Topbar lucide icons + 'Blueprint' label (spec §11.4)"
```

---

## Task 12: Footer — `●○` 字符 → div dot

**Files:**
- Modify: `web/src/layout/Footer.tsx`

- [ ] **Step 1: 改 Footer**

```tsx
type FooterProps = {
  connected: boolean
  running: number
  runtimeAddress: string
  stopped: number
  workspaceCount: number
}

const Dot = ({ color }: { color: string }) => (
  <span
    aria-hidden
    className="inline-block h-1.5 w-1.5 rounded-full align-middle"
    style={{ background: color }}
  />
)

export const Footer = ({
  connected,
  running,
  runtimeAddress,
  stopped,
  workspaceCount,
}: FooterProps) => (
  <footer
    className="mono flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[10px] text-ter"
    style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
  >
    <span>Hive runtime · {runtimeAddress}</span>
    <span aria-hidden>·</span>
    <span>
      {workspaceCount} workspace{workspaceCount === 1 ? '' : 's'}
    </span>
    <span aria-hidden>·</span>
    <span data-testid="footer-running" title="PTY running (working + idle)">
      <Dot color="var(--status-green)" /> {running} running
    </span>
    <span aria-hidden>·</span>
    <span data-testid="footer-stopped">
      <Dot color="var(--status-red)" /> {stopped} stopped
    </span>
    <div className="flex-1" />
    <span
      title={connected ? 'connected' : 'disconnected'}
      className="inline-flex items-center gap-1.5"
      style={{ color: connected ? 'var(--status-green)' : 'var(--status-red)' }}
      data-testid="footer-connection"
    >
      <Dot color={connected ? 'var(--status-green)' : 'var(--status-red)'} />
      {connected ? 'connected' : 'disconnected'}
    </span>
  </footer>
)
```

- [ ] **Step 2: 跑测试**

```bash
pnpm exec vitest run tests/web/app-shell.test.tsx
```

如果有断言 `●` `○` 字符内容，改为断言 `data-testid` 存在 + textContent 含 `running` / `stopped` / `connected` 文字。

- [ ] **Step 3: Commit**

```bash
git add web/src/layout/Footer.tsx tests/web/app-shell.test.tsx
git commit -m "feat(ui): Footer dot div replaces unicode bullet chars"
```

---

## Task 13: Sidebar — 空态用 `EmptyState`

**Files:**
- Modify: `web/src/sidebar/Sidebar.tsx`

- [ ] **Step 1: 改 Sidebar 空态**

把 `web/src/sidebar/Sidebar.tsx` 的空态分支：

```tsx
) : workspaces.length === 0 ? (
  <p className="px-3 py-2 text-xs text-ter">No workspaces yet</p>
) : (
```

改为：

```tsx
) : workspaces.length === 0 ? (
  <div className="flex-1 px-2 py-4">
    <EmptyState
      title="No workspaces"
      description="Add one to start. Hive will load tasks.md and start the Orchestrator."
    />
  </div>
) : (
```

并在文件顶部加 import：

```tsx
import { EmptyState } from '../ui/EmptyState.js'
```

- [ ] **Step 2: 跑测试**

```bash
pnpm exec vitest run tests/web/sidebar-workspace-flow.test.tsx tests/web/workspace-flow.test.tsx tests/web/workspace-create-initial-state.test.tsx
```

如果失败（断言 `No workspaces yet` 文字精确匹配），改为 `screen.getByTestId('empty-state-title').textContent` 断言含 "No workspaces"。

- [ ] **Step 3: Commit**

```bash
git add web/src/sidebar/Sidebar.tsx tests/web/sidebar-workspace-flow.test.tsx tests/web/workspace-flow.test.tsx tests/web/workspace-create-initial-state.test.tsx
git commit -m "feat(ui): Sidebar uses EmptyState for no-workspaces"
```

---

## Task 14: WorkspaceDetail — 删 inline error band，改 toast

**Files:**
- Modify: `web/src/WorkspaceDetail.tsx`

- [ ] **Step 1: 改 WorkspaceDetail**

把 `web/src/WorkspaceDetail.tsx` 中两处 `<p role="alert" className="border-t border-status-red/30 bg-status-red/10 ...">{...}</p>` inline 错误条整段删除。

加 import：

```tsx
import { useEffect } from 'react'  // 已有，保留
import { useToast } from './ui/useToast.js'
```

（`useEffect` 已经 import 了，确认一下）

在 `WorkspaceDetail` 组件内顶部加：

```tsx
const toast = useToast()

useEffect(() => {
  if (composer.createWorkerError) {
    toast.show({ kind: 'error', message: composer.createWorkerError })
  }
}, [composer.createWorkerError, toast])

useEffect(() => {
  if (deleteWorkerError) {
    toast.show({ kind: 'error', message: deleteWorkerError })
  }
}, [deleteWorkerError, toast])
```

> 这里有个边界：当 `createWorkerError` 反复变化（同一个错误连续多次），useEffect 会重发 toast。可接受 — toast 系统自身的 max-3 堆叠应对。如果要去重，留给 M6-C。

并删除 JSX 末尾两段 `{composer.createWorkerError ? <p role="alert">...</p> : null}` 和 `{deleteWorkerError ? <p role="alert">...</p> : null}`。

- [ ] **Step 2: 跑测试**

```bash
pnpm exec vitest run tests/web/worker-flow.test.tsx
```

如果有测试断言 `role="alert"` inline band 存在，改为断言 toast 系统：在测试中包 `<ToastProvider>` + `<Toaster>`，断言 `screen.getByTestId('toast')` 出现。

但 worker-flow 当前可能没断言 alert band；如未触发可跳过测试更新。

- [ ] **Step 3: Commit**

```bash
git add web/src/WorkspaceDetail.tsx tests/web/worker-flow.test.tsx
git commit -m "refactor(ui): WorkspaceDetail surface errors via toast (drop inline alert bands)"
```

---

## Task 15: App — 顶层挂载 ToastProvider + Toaster

**Files:**
- Modify: `web/src/app.tsx`

- [ ] **Step 1: 改 App**

把 `web/src/app.tsx` 顶部 import 加：

```tsx
import { Toaster } from './ui/toast.js'
import { ToastProvider } from './ui/useToast.js'
```

把整个 App 返回的 JSX 用 ToastProvider 包起来 + 在末尾追加 `<Toaster />`：

```tsx
  return (
    <ToastProvider>
      <MainLayout
        onToggleTaskGraph={() => setTaskGraphOpen((value) => !value)}
        running={stats.working + stats.idle}
        runtimeAddress={RUNTIME_ADDRESS}
        sidebar={
          <Sidebar
            activeWorkspaceId={activeWorkspaceId}
            onCreateClick={() => setAddDialogTrigger((value) => value + 1)}
            onSelectWorkspace={selectWorkspace}
            workersByWorkspaceId={workersByWorkspaceId}
            workspaces={workspaces}
          />
        }
        stopped={stats.stopped}
        taskGraphOpen={taskGraphOpen}
        workspaceCount={workspaces?.length ?? 0}
      >
        {/* ...existing children... */}
      </MainLayout>
      <Toaster />
    </ToastProvider>
  )
```

> AGENTS.md §10：app.tsx 上限 150 行。当前接近上限，加 ToastProvider 包不会超太多。完成后用 `wc -l web/src/app.tsx` 确认 ≤150。

- [ ] **Step 2: 跑全套 web 测试**

```bash
pnpm exec vitest run tests/web/
```

所有 web 测试应过。

- [ ] **Step 3: 验证 app.tsx 行数**

```bash
wc -l web/src/app.tsx
```

Expected: 行数 ≤ 150。如果超了，提取 toast 包装到一个小组件 `AppShell.tsx`。

- [ ] **Step 4: Commit**

```bash
git add web/src/app.tsx
git commit -m "feat(ui): App mounts ToastProvider + Toaster at root"
```

---

## Task 16: 删除 m5-linear-visual.test.tsx + 全套 sanity check

**Files:**
- Delete: `tests/web/m5-linear-visual.test.tsx`

- [ ] **Step 1: 删除 M5 视觉冻结测试**

```bash
rm tests/web/m5-linear-visual.test.tsx
```

> 该文件断言 M5 时刻的视觉细节（emoji / window.confirm 等），M6-A 已不适用。M6-B 完成结构重做后再写新视觉断言（见 spec §9.3 `m6-redesign-visual.test.tsx`）。

- [ ] **Step 2: 跑完整检查**

```bash
pnpm check && pnpm build && pnpm test
```

Expected: 全过。

- [ ] **Step 3: Commit**

```bash
git add tests/web/m5-linear-visual.test.tsx
git commit -m "test(ui): remove M5 visual freeze test (M6-B will write new structure asserts)"
```

> 注意：删除文件 `git add` 会标记为 deletion，如不行用 `git rm tests/web/m5-linear-visual.test.tsx`。

---

## Self-Review

### Spec coverage（M6-A 范围内逐项）

| Spec §10 M6-A 项 | 对应 Task |
|---|---|
| §4.1–4.6 token 落 globals.css | Task 1 |
| emoji → lucide icon | Task 9 (Orch) / 10 (Workers) / 11 (Topbar) / 12 (Footer) |
| 删除 `card:hover transform` | Task 2 |
| `RoleAvatar` 替换 emoji 头像 | Task 6 (创建) + Task 8 (使用) |
| 自研 `<Confirm>` 替换 `window.confirm` | Task 5 (创建) + Task 9 (使用) |
| `<Toast>` + `useToast` 系统 | Task 4 (创建) + Task 14 (使用) + Task 15 (挂载) |
| `<EmptyState>` 统一组件 | Task 3 (创建) + Task 9 (Orch) + Task 13 (Sidebar) |

所有 M6-A 范围 spec 项已覆盖。

### Placeholder scan

- 无 "TBD" / "TODO" / "implement later"
- 无 "add appropriate validation"
- 无 "similar to Task N"（每个 task 含完整代码）
- 无 trivially-pass 断言

### Type consistency

- `RoleAvatar` props: `role: WorkerRole | 'orchestrator'` + `size?: number`，所有 caller 一致
- `Confirm` props: `open` / `onOpenChange` / `title` / `description` / `confirmLabel` / `confirmKind?` / `cancelLabel?` / `onConfirm`，OrchestratorPane 调用一致
- `useToast()` 返回 `{ show, dismiss, toasts }`，`show` 返回 `string` (id)
- `EmptyState` props: `title` / `description` / `icon?` / `action?`

---

## 完成判据（M6-A 整体）

- [ ] 16 个 task 全部 `- [ ]` 勾完
- [ ] `pnpm check` 通过（biome lint）
- [ ] `pnpm build` 通过（vite build + tsc）
- [ ] `pnpm test` 通过（含新增 EmptyState/Toast/Confirm/RoleAvatar 测试 + 更新后的现有测试）
- [ ] `wc -l web/src/app.tsx` ≤ 150
- [ ] `grep -r "window.confirm" web/src/` 无任何命中
- [ ] `grep -rE "🐝|👑|📋|⚙️|🐛|🦉|🐜" web/src/` 无任何命中（emoji 已清空）
- [ ] `git log --oneline | head -16` 列出 16 条对应 commit（每 task 一条 commit）

---

## M6-B / M6-C / M6-D 后续

M6-A 完成后，再分别为 M6-B（信息架构重做）、M6-C（Inspector & Palette）、M6-D（收口）出独立 plan，按相同 TDD 节奏推进。**不要**在 M6-A 这个 plan 里塞后续 milestone 的代码。
