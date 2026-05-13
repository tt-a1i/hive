# Hive Demo Mode & First-Run Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a first-time user understand Hive without installing a single CLI agent, by (a) running a fully client-side demo workspace with pre-baked terminal output and a pre-filled task graph, and (b) showing a 3-step wizard the first time the app opens.

**Architecture:**
- **Demo mode** is a pure client-side overlay state. No real PTY, no DB writes, no server calls for the demo workspace. The `App` component holds a `demoMode: boolean` flag; when true, `workspaces` is replaced with a fixture list, terminal panels render pre-recorded ANSI from a static fixture, task graph reads from a `const` string. Exit Demo returns to the real `workspaces` from the server.
- **First-run wizard** is a Radix `Dialog` opened automatically when `localStorage.getItem('hive.first-run-seen') === null` AND `workspaces.length === 0`. Three carousel slides + always-visible "Skip" footer. On any close action it persists `'hive.first-run-seen' = '1'`. Re-opening it later happens through the WelcomePane action menu.

**Tech Stack:** React 19 · `@radix-ui/react-dialog` · `lucide-react` · Tailwind v4 · Vitest + jsdom (no server tests needed — demo never touches server)

**Spec basis:**
- Self-authored design (this plan is the spec for batch C; no prior spec covers demo/wizard)
- Audit reports from 2026-05-13 (in-session, not persisted)

**Out-of-scope (explicitly):**
- Animating fake worker output beyond pre-recorded scroll — no streaming simulation
- AI-style fake responses to user input in demo — demo terminals are read-only, marked as such
- Persisting wizard state across browsers / users — localStorage only
- I18n of wizard copy — English-only for v1

**TDD discipline:** AGENTS.md §三. Demo terminals must show "DEMO — read-only" overlay; assert that overlay exists. Wizard tests cover localStorage flag write + skip button + slide-by-slide navigation.

---

## Part 1 — Demo Mode

### File Structure (Demo)

**Create:**
- `web/src/demo/demo-fixture.ts` — typed fixture: workspace, workers, terminal scrollback per worker, task graph markdown
- `web/src/demo/useDemoMode.ts` — hook holding the `demoMode` flag + setters
- `web/src/demo/DemoBanner.tsx` — sticky banner at top of demo workspace with "Exit Demo" button
- `tests/web/demo-mode.test.tsx`

**Modify:**
- `web/src/app.tsx` — wrap `workspaces` / `workersByWorkspaceId` / `tasks` with demo fixture when `demoMode` is true
- `web/src/worker/WelcomePane.tsx` — add secondary CTA "Try Demo" (calls `enableDemoMode`)
- `web/src/WorkspaceTerminalPanels.tsx` — branch: if demo mode, render `DemoTerminalView` with pre-recorded text instead of real `TerminalView`
- `web/src/tasks/useTasksFile.ts` — when demo, return fixture content with no-op save

---

### Task D1: Demo fixture

**Files:**
- Create: `web/src/demo/demo-fixture.ts`

- [ ] **Step 1: Define the fixture types**

```ts
import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: 'demo-workspace',
  name: 'demo-todo-app',
  path: '/Users/you/demo-todo-app',
}

export const DEMO_WORKERS: TeamListItem[] = [
  { id: 'demo-orch', name: 'queen', role: 'orchestrator', status: 'idle', pendingTaskCount: 0 },
  { id: 'demo-coder', name: 'alice', role: 'coder', status: 'working', pendingTaskCount: 1,
    lastOutputLine: 'Editing src/routes/todos.ts (line 42)' },
  { id: 'demo-reviewer', name: 'bob', role: 'reviewer', status: 'idle', pendingTaskCount: 0 },
]

export const DEMO_TASKS_MD = `# Todo app

- [x] Set up Express server
- [x] Add /todos GET endpoint
- [ ] Add /todos POST endpoint
- [ ] Write Vitest for both endpoints
- [ ] Wire up SQLite for persistence
`

export const DEMO_TERMINAL_SCROLLBACK: Record<string, string> = {
  'demo-orch':
    '$ team send alice "Implement POST /todos"\n' +
    '> dispatched to alice\n' +
    '$ team list\n' +
    '> alice: working (1 task)\n' +
    '> bob: idle\n',
  'demo-coder':
    'Reading src/routes/todos.ts ...\n' +
    'Drafting POST handler ...\n' +
    'Editing src/routes/todos.ts (line 42)\n',
  'demo-reviewer': 'Idle — waiting for review tasks.\n',
}
```

- [ ] **Step 2: No test for pure data**

Per AGENTS.md §三.7, asserting `expect(DEMO_WORKERS).toHaveLength(3)` is trivially-passing. Skip. The downstream component tests will reference these constants implicitly.

- [ ] **Step 3: Commit**

```bash
git add web/src/demo/demo-fixture.ts
git commit -m "Add demo fixture (workspace, workers, scrollback, tasks)"
```

---

### Task D2: useDemoMode hook + WelcomePane "Try Demo" CTA

**Files:**
- Create: `web/src/demo/useDemoMode.ts`
- Modify: `web/src/worker/WelcomePane.tsx`
- Test: `tests/web/welcome-pane.test.tsx` (update from Plan A)

- [ ] **Step 1: Failing test**

```tsx
test('WelcomePane "Try Demo" button fires onTryDemo', () => {
  const onDemo = vi.fn()
  render(<WelcomePane onAddWorkspace={() => {}} onTryDemo={onDemo} />)
  fireEvent.click(screen.getByRole('button', { name: /try demo/i }))
  expect(onDemo).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest welcome-pane -t "Try Demo" --run` → FAIL

- [ ] **Step 3: Add the prop + button**

In `WelcomePane.tsx`:

```tsx
type WelcomePaneProps = {
  onAddWorkspace: () => void
  onTryDemo?: () => void
  heroImageSrc?: string
}
```

Beneath the primary CTA:

```tsx
{onTryDemo ? (
  <button type="button" onClick={onTryDemo} className="text-xs text-sec underline hover:text-pri">
    or try the demo (no install needed)
  </button>
) : null}
```

- [ ] **Step 4: Create `useDemoMode`**

```ts
import { useState } from 'react'
export const useDemoMode = () => {
  const [demoMode, setDemoMode] = useState(false)
  return {
    demoMode,
    enableDemo: () => setDemoMode(true),
    exitDemo: () => setDemoMode(false),
  }
}
```

- [ ] **Step 5: Verify + commit**

```bash
git add web/src/demo/useDemoMode.ts web/src/worker/WelcomePane.tsx tests/web/welcome-pane.test.tsx
git commit -m "Add Try Demo CTA and useDemoMode hook"
```

---

### Task D3: App.tsx wires demo workspace into existing rendering paths

**Files:**
- Modify: `web/src/app.tsx`
- Test: `tests/web/demo-mode.test.tsx` (new)

Key idea: when `demoMode` is true, swap the data the existing components consume — don't fork the component tree.

- [ ] **Step 1: Failing test**

```tsx
test('clicking Try Demo enters demo mode showing demo workspace and demo workers', async () => {
  render(<App />)
  await screen.findByTestId('welcome-pane')
  fireEvent.click(screen.getByRole('button', { name: /try demo/i }))
  expect(screen.getByText('demo-todo-app')).toBeInTheDocument()
  expect(screen.getByText('alice')).toBeInTheDocument()
  expect(screen.getByText('Editing src/routes/todos.ts (line 42)')).toBeInTheDocument()
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()
})

test('Exit Demo returns to the empty welcome state', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /try demo/i }))
  fireEvent.click(screen.getByRole('button', { name: /exit demo/i }))
  expect(screen.getByTestId('welcome-pane')).toBeInTheDocument()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest demo-mode --run` → FAIL

- [ ] **Step 3: Wire in App.tsx**

```tsx
const { demoMode, enableDemo, exitDemo } = useDemoMode()
const effectiveWorkspaces = demoMode ? [DEMO_WORKSPACE] : workspaces
const effectiveWorkers = demoMode
  ? { [DEMO_WORKSPACE.id]: DEMO_WORKERS }
  : workersByWorkspaceId
const effectiveActiveId = demoMode ? DEMO_WORKSPACE.id : activeWorkspaceId
```

Pass these to `<Sidebar>` and `<WorkspaceDetail>`. Pass `onTryDemo={enableDemo}` and `onRequestAddWorkspace` to `WelcomePane`. In `WorkspaceDetail`, when `demoMode`, render `<DemoBanner onExit={exitDemo}>` at top.

- [ ] **Step 4: Pass + commit**

```bash
git add web/src/app.tsx web/src/demo/DemoBanner.tsx web/src/WorkspaceDetail.tsx tests/web/demo-mode.test.tsx
git commit -m "Wire demo mode end-to-end in App"
```

---

### Task D4: DemoBanner + read-only badge on terminals

**Files:**
- Create: `web/src/demo/DemoBanner.tsx`
- Modify: `web/src/WorkspaceTerminalPanels.tsx` — pre-recorded scrollback rendering when demo
- Modify: `web/src/terminal/TerminalView.tsx` — accept `readOnly` prop that shows DEMO badge overlay; disables stdin send

DemoBanner is a yellow strip above the terminal area: "DEMO MODE — agents are not running. [Exit Demo]".

- [ ] **Step 1: Failing test (banner)**

```tsx
test('DemoBanner exposes Exit Demo button and matches role=region', () => {
  const onExit = vi.fn()
  render(<DemoBanner onExit={onExit} />)
  expect(screen.getByRole('region', { name: /demo mode/i })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /exit demo/i }))
  expect(onExit).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Failing test (terminal read-only badge)**

```tsx
test('TerminalView shows DEMO read-only badge when readOnly=true and ignores typed input', () => {
  const onUserData = vi.fn()
  render(<TerminalView readOnly initialScrollback="$ echo hi\nhi" onUserData={onUserData} />)
  expect(screen.getByTestId('terminal-readonly-badge')).toBeInTheDocument()
  // Simulate keystroke; verify onUserData not called
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'h' })
  expect(onUserData).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Implementations**

DemoBanner:

```tsx
export const DemoBanner = ({ onExit }: { onExit: () => void }) => (
  <div
    role="region"
    aria-label="Demo mode"
    data-testid="demo-banner"
    className="flex items-center justify-between border-b px-4 py-2 text-xs"
    style={{ background: 'var(--status-yellow-bg, #3a2c1c)', borderColor: 'var(--border)' }}
  >
    <div className="flex items-center gap-2 text-pri">
      <Sparkles size={13} aria-hidden />
      <span><strong>DEMO MODE</strong> — agents are pre-recorded, not running.</span>
    </div>
    <button
      type="button"
      onClick={onExit}
      className="hive-cta hive-cta--ghost"
    >
      Exit Demo
    </button>
  </div>
)
```

TerminalView: add `readOnly: boolean` + `initialScrollback?: string` props; when readOnly, render a `<div data-testid="terminal-readonly-badge">DEMO read-only</div>` over the terminal corner and short-circuit `onData` callback.

In WorkspaceTerminalPanels, when in demo, render `<TerminalView readOnly initialScrollback={DEMO_TERMINAL_SCROLLBACK[workerId]} />` per worker pane.

- [ ] **Step 4: Verify + commit**

```bash
git add web/src/demo/DemoBanner.tsx web/src/WorkspaceTerminalPanels.tsx web/src/terminal/TerminalView.tsx tests/web/demo-mode.test.tsx tests/web/terminal-view.test.tsx
git commit -m "Demo banner and read-only terminal scrollback rendering"
```

---

### Task D5: useTasksFile honors demo mode

**Files:**
- Modify: `web/src/tasks/useTasksFile.ts`
- Modify: `web/src/app.tsx` — pass demo flag down

- [ ] **Step 1: Failing test**

```tsx
test('TaskGraphDrawer renders DEMO_TASKS_MD when demoMode is on', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /try demo/i }))
  fireEvent.click(screen.getByRole('button', { name: /blueprint/i }))
  expect(screen.getByText('Add /todos POST endpoint')).toBeInTheDocument()
})
```

- [ ] **Step 2: Wire**

In `useTasksFile.ts`, accept optional `demoContent?: string`. When provided, short-circuit fetch + return `{ content: demoContent, hasConflict: false, ...noOpSavers }`.

In `app.tsx`:

```tsx
const activeTasksFile = useTasksFile(activeWorkspaceId, demoMode ? DEMO_TASKS_MD : undefined)
```

- [ ] **Step 3: Verify + commit**

```bash
git add web/src/tasks/useTasksFile.ts web/src/app.tsx tests/web/demo-mode.test.tsx
git commit -m "useTasksFile renders demo fixture in demo mode"
```

---

## Part 2 — First-Run Wizard

### File Structure (Wizard)

**Create:**
- `web/src/wizard/useFirstRunFlag.ts` — localStorage-backed flag with `seen: boolean` + `markSeen()`
- `web/src/wizard/FirstRunWizard.tsx` — Radix Dialog with 3 slides
- `tests/web/first-run-wizard.test.tsx`

**Modify:**
- `web/src/app.tsx` — mount `<FirstRunWizard>` and auto-open when `!seen && workspaces?.length === 0`

---

### Task W1: localStorage flag hook

**Files:**
- Create: `web/src/wizard/useFirstRunFlag.ts`
- Test: `tests/web/first-run-wizard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
test('useFirstRunFlag returns seen=false initially and seen=true after markSeen', () => {
  window.localStorage.clear()
  const { result } = renderHook(() => useFirstRunFlag())
  expect(result.current.seen).toBe(false)
  act(() => result.current.markSeen())
  expect(result.current.seen).toBe(true)
  expect(window.localStorage.getItem('hive.first-run-seen')).toBe('1')
})

test('useFirstRunFlag honors existing localStorage value', () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  const { result } = renderHook(() => useFirstRunFlag())
  expect(result.current.seen).toBe(true)
})
```

- [ ] **Step 2: Implement**

```ts
const KEY = 'hive.first-run-seen'

export const useFirstRunFlag = () => {
  const [seen, setSeen] = useState(() => {
    try { return window.localStorage.getItem(KEY) === '1' } catch { return true }
  })
  const markSeen = useCallback(() => {
    try { window.localStorage.setItem(KEY, '1') } catch {}
    setSeen(true)
  }, [])
  return { seen, markSeen }
}
```

- [ ] **Step 3: Verify + commit**

```bash
git add web/src/wizard/useFirstRunFlag.ts tests/web/first-run-wizard.test.tsx
git commit -m "Add first-run flag hook backed by localStorage"
```

---

### Task W2: FirstRunWizard component with 3-slide carousel

**Files:**
- Create: `web/src/wizard/FirstRunWizard.tsx`
- Test: `tests/web/first-run-wizard.test.tsx` (extend)

3 slides:
1. **Welcome** — Hive logo, headline, tagline
2. **How it works** — quick 3-step diagram (Add → Orchestrate → Dispatch)
3. **Get started** — three buttons: Add Workspace · Try Demo · Skip

Footer always shows: "Step N of 3 · Skip" link.

- [ ] **Step 1: Failing tests**

```tsx
test('FirstRunWizard renders slide 1 with Next button', () => {
  render(<FirstRunWizard open onClose={() => {}} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  expect(screen.getByText(/welcome to hive/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
})

test('clicking Next advances to slide 2', () => {
  render(<FirstRunWizard open onClose={() => {}} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  expect(screen.getByText(/how it works/i)).toBeInTheDocument()
})

test('Skip closes the wizard from any slide', () => {
  const onClose = vi.fn()
  render(<FirstRunWizard open onClose={onClose} onAddWorkspace={() => {}} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /skip/i }))
  expect(onClose).toHaveBeenCalledOnce()
})

test('Slide 3 Add Workspace button fires onAddWorkspace and closes', () => {
  const onAdd = vi.fn()
  const onClose = vi.fn()
  render(<FirstRunWizard open onClose={onClose} onAddWorkspace={onAdd} onTryDemo={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  fireEvent.click(screen.getByRole('button', { name: /add workspace/i }))
  expect(onAdd).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Implement using `@radix-ui/react-dialog`**

Use the same Dialog primitive used by `Confirm.tsx`. Hold `slideIdx` state 0..2.

- [ ] **Step 3: Verify + commit**

```bash
git add web/src/wizard/FirstRunWizard.tsx tests/web/first-run-wizard.test.tsx
git commit -m "Add FirstRunWizard 3-slide carousel"
```

---

### Task W3: App auto-opens wizard on first run

**Files:**
- Modify: `web/src/app.tsx`
- Test: `tests/web/first-run-wizard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
test('wizard opens automatically when flag unset and workspaces empty', async () => {
  window.localStorage.clear()
  render(<App />)
  expect(await screen.findByRole('dialog', { name: /welcome/i })).toBeInTheDocument()
})

test('wizard does not open when flag is set', () => {
  window.localStorage.setItem('hive.first-run-seen', '1')
  render(<App />)
  expect(screen.queryByRole('dialog', { name: /welcome/i })).toBeNull()
})

test('wizard does not open when there are existing workspaces', async () => {
  // Mock fetch to return 1 workspace before render
  // ...
  render(<App />)
  expect(screen.queryByRole('dialog', { name: /welcome/i })).toBeNull()
})
```

- [ ] **Step 2: Wire in App.tsx**

```tsx
const { seen, markSeen } = useFirstRunFlag()
const [wizardOpen, setWizardOpen] = useState(false)
useEffect(() => {
  if (!seen && workspaces !== null && workspaces.length === 0) {
    setWizardOpen(true)
  }
}, [seen, workspaces])

const closeWizard = () => {
  markSeen()
  setWizardOpen(false)
}
```

Mount `<FirstRunWizard open={wizardOpen} onClose={closeWizard} onAddWorkspace={...} onTryDemo={enableDemo} />`.

- [ ] **Step 3: Verify + commit**

```bash
git add web/src/app.tsx tests/web/first-run-wizard.test.tsx
git commit -m "Auto-open FirstRunWizard for first-time empty users"
```

---

## Self-Review

- [ ] **Spec coverage:** demo workspace + wizard each have at least one task per documented behavior. ✓
- [ ] **Placeholder scan:** No "TODO" / "TBD" / "appropriate" in plan. ✓
- [ ] **Type consistency:** `useDemoMode().demoMode` (boolean) ↔ `WelcomePane.onTryDemo` (function) — types stay simple. ✓
- [ ] **Demo isolation:** demo never writes to server (verify in App.tsx — every server-call path must skip when `demoMode === true`). Manually check `fetch` is not called during demo session.
- [ ] **AGENTS.md §4 — 4 parallel reviews.** Dispatch reviewers after Task W3 — focus on demo mode leaking state into real workspaces and wizard flag persistence edge cases (private browsing, cleared storage).

---

## Verification before declaring done

```bash
pnpm check && pnpm build && pnpm test
```

Manual chrome path:
1. `window.localStorage.clear()` → reload → wizard opens
2. Click Try Demo → demo workspace renders with banner, fake worker scrollback, blueprint shows DEMO_TASKS_MD
3. Click Exit Demo → returns to empty state (no leftover state in `workspaces`)
4. Add a real workspace → wizard does not pop up again
5. Refresh → wizard still does not pop (flag persisted)
6. `localStorage.clear()` again → wizard pops on next reload

Stop runtime mid-demo: demo should keep running (no server calls).
