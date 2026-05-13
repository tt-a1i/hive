# Hive UI Onboarding Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the empty black main pane on first run, surface the "Add Workspace" CTA inside the sidebar EmptyState, make the Orchestrator usable for new users via a hint overlay, surface initialization errors instead of swallowing them, and make Worker cards stop being black boxes by showing the last terminal line.

**Architecture:**
- Two new components: `WelcomePane` (welcome screen rendered when no workspace is active) and `OrchestratorHintOverlay` (CSS-overlay tip layer above the Orchestrator terminal that fades on first keystroke).
- One server-side protocol addition: `last_output_line: string | null` on `TeamListItem` (snake_case on wire per AGENTS.md §8). Captured by `terminal-state-mirror` from headless xterm scrollback, broadcast through the existing tasks websocket payload.
- One UX refactor: `Sidebar.tsx` EmptyState absorbs the bottom `Add Workspace` button as its `action` prop; the bottom button stays only when the list is non-empty.
- `useInitializeUiSession` distinguishes `runtime-down` from `no-workspaces` via toast.

**Tech Stack:** React 19 · Tailwind v4 · `lucide-react` · `@xterm/headless` · Vitest + `@testing-library/react` + jsdom · `better-sqlite3` (existing) · ws

**Spec basis:**
- [`docs/superpowers/specs/2026-04-18-hive-design.md`](../specs/2026-04-18-hive-design.md) §3.5 recovery + §6 UI
- [`docs/superpowers/specs/2026-04-29-hive-ui-redesign.md`](../specs/2026-04-29-hive-ui-redesign.md) §6.3 empty state
- Three audit reports from 2026-05-13 (in-session, not persisted)

**TDD discipline:** AGENTS.md §三 — every assert must break if product code is fully reversed. No `not.toThrow()` × N. No `expect(readFileSync).toContain('import…')` patterns. Server-side tests hit real PTY / real SQLite (no `vi.mock('node-pty')` inside `tests/server/*` or `tests/integration/*`).

---

## File Structure

**Create:**
- `web/src/worker/WelcomePane.tsx` — welcome screen with 3-step illustration + primary CTA
- `web/src/worker/OrchestratorHintOverlay.tsx` — absolute-positioned hint card above terminal, fades on user input
- `tests/web/welcome-pane.test.tsx`
- `tests/web/orchestrator-hint-overlay.test.tsx`
- `tests/web/worker-card-live-status.test.tsx`
- `tests/server/last-output-line-snapshot.test.ts` — real PTY + state mirror integration

**Modify:**
- `web/src/WorkspaceDetail.tsx:45-95` — render `<WelcomePane>` instead of `null` when `workspace` is undefined
- `web/src/sidebar/Sidebar.tsx:100-171` — EmptyState gets `action` prop; bottom button is conditional on `workspaces && workspaces.length > 0`
- `web/src/worker/OrchestratorPane.tsx` — mount `<OrchestratorHintOverlay>` when run is `running` AND no input has been sent yet
- `web/src/worker/WorkerCard.tsx` — show `lastOutputLine` truncated to 60 chars as subtext beneath status row when status is `working`
- `web/src/useInitializeUiSession.ts:60-72` — replace silent `setWorkspaces([])` with toast "Could not reach Hive runtime — retry?" + retry button; preserve `null` workspaces state so EmptyState does not fire
- `src/server/terminal-state-mirror.ts` — expose `lastOutputLine()` reading the most recent non-empty line from headless xterm
- `src/server/team-list-serializer.ts:21` — serialize `last_output_line: string | null` on `TeamListItemPayload`
- `src/server/team-operations.ts` — wire `lastOutputLine` from terminal-state-mirror into team list responses
- `src/shared/types.ts:18-32` — `TeamListItem.lastOutputLine?: string`; `TeamListItemPayload.last_output_line: string | null`
- `web/src/api.ts` — deserialize `last_output_line` → `lastOutputLine`
- `tests/web/sidebar-workspace-flow.test.tsx` — assert EmptyState action button replaces dashed bottom button on empty list
- `tests/web/orchestrator-pane.test.tsx` — assert hint overlay appears on running + dismisses on input
- `tests/web/worker-flow.test.tsx` — assert `last_output_line` rendered when worker is working

---

## Test Style Cheatsheet

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
afterEach(() => cleanup())
```

Server tests use real `startTestServer({ pickFolderPath })` + real `node-pty`. No mocking.

---

## Task 1: Sidebar EmptyState — absorb the Add Workspace CTA

**Files:**
- Modify: `web/src/sidebar/Sidebar.tsx:100-171`
- Test: `tests/web/sidebar-workspace-flow.test.tsx` (update existing)

- [ ] **Step 1: Write the failing test**

In `tests/web/sidebar-workspace-flow.test.tsx`, add:

```tsx
test('empty workspaces shows New workspace CTA inside the EmptyState, not at the bottom', () => {
  render(<Sidebar {...emptyProps} workspaces={[]} />)
  const emptyState = screen.getByTestId('empty-state')
  // CTA must live inside the EmptyState surface so the eye flow is one continuous block.
  expect(within(emptyState).getByRole('button', { name: 'New workspace' })).toBeInTheDocument()
  // The dashed bottom button is hidden when the list is empty (it would compete with the CTA).
  expect(screen.queryByRole('button', { name: /^New workspace$/i, hidden: true })).toBe(
    within(emptyState).getByRole('button', { name: 'New workspace' })
  )
})

test('non-empty workspaces keeps the dashed bottom Add Workspace button', () => {
  render(<Sidebar {...emptyProps} workspaces={[fakeWorkspace]} />)
  const bottomBtn = screen.getByRole('button', { name: 'New workspace' })
  expect(bottomBtn).toHaveClass('ws-add')
})
```

- [ ] **Step 2: Run test to verify it fails**

`pnpm vitest tests/web/sidebar-workspace-flow.test.tsx -t "empty workspaces shows New" --run`

Expected: FAIL — EmptyState has no action button.

- [ ] **Step 3: Modify Sidebar.tsx to pass action prop on EmptyState**

```tsx
{workspaces.length === 0 ? (
  <div className="flex-1 px-2 py-4">
    <EmptyState
      title="No workspaces"
      description="Add one to start. Hive loads .hive/tasks.md and starts the Orchestrator."
      icon={<FolderPlus size={20} />}
      action={
        <button
          type="button"
          onClick={onCreateClick}
          aria-label="New workspace"
          className="hive-cta hive-cta--primary mt-2"
        >
          <Plus size={14} aria-hidden />
          <span>Add Workspace</span>
        </button>
      }
    />
  </div>
) : ( ... existing list ... )}
```

Wrap the existing bottom button with `{workspaces && workspaces.length > 0 ? ( <button ... /> ) : null}`.

Add `.hive-cta` + `.hive-cta--primary` to `globals.css` as a token-driven primary button (background `var(--accent)`, hover lighten via color-mix). Use existing `--accent` / `--bg-2`.

- [ ] **Step 4: Run test to verify it passes**

`pnpm vitest tests/web/sidebar-workspace-flow.test.tsx --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/sidebar/Sidebar.tsx web/src/styles/globals.css tests/web/sidebar-workspace-flow.test.tsx
git commit -m "Sidebar EmptyState absorbs the New workspace CTA"
```

---

## Task 2: WelcomePane component

**Files:**
- Create: `web/src/worker/WelcomePane.tsx`
- Test: `tests/web/welcome-pane.test.tsx`

The component shows: Hive logo + "Welcome to Hive" + one-line tagline + 3 step row (Add workspace · Choose Orchestrator · Dispatch tasks) + primary CTA "Add your first workspace" that calls `onAddWorkspace`. Accepts optional `heroImageSrc` (defaults to `/hero.svg` static asset). Width capped at 540px, centered with `m-auto`.

- [ ] **Step 1: Write failing test**

```tsx
test('WelcomePane renders 3-step guide and fires onAddWorkspace from CTA', () => {
  const onAdd = vi.fn()
  render(<WelcomePane onAddWorkspace={onAdd} />)
  // Three numbered step labels must be present (1/2/3 in any visual form)
  expect(screen.getByText(/add a workspace/i)).toBeInTheDocument()
  expect(screen.getByText(/choose an orchestrator/i)).toBeInTheDocument()
  expect(screen.getByText(/dispatch tasks/i)).toBeInTheDocument()
  // CTA wired
  fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
  expect(onAdd).toHaveBeenCalledOnce()
})

test('WelcomePane stays within max-width so it does not stretch absurdly on wide monitors', () => {
  const { container } = render(<WelcomePane onAddWorkspace={() => {}} />)
  const card = container.querySelector('[data-testid="welcome-pane"]') as HTMLElement
  expect(card).toHaveStyle({ maxWidth: '540px' })
})
```

- [ ] **Step 2: Run test to verify failure**

`pnpm vitest tests/web/welcome-pane.test.tsx --run`

Expected: FAIL — file not found.

- [ ] **Step 3: Create `web/src/worker/WelcomePane.tsx`**

```tsx
import { ArrowRight, FolderPlus, Send, Users } from 'lucide-react'

type WelcomePaneProps = {
  onAddWorkspace: () => void
  heroImageSrc?: string
}

const steps: Array<{ icon: ReactNode; title: string; description: string }> = [
  { icon: <FolderPlus size={18} />, title: 'Add a workspace', description: 'Pick a project folder.' },
  { icon: <Users size={18} />, title: 'Choose an Orchestrator', description: 'Claude / Codex / Gemini / OpenCode.' },
  { icon: <Send size={18} />, title: 'Dispatch tasks', description: 'The Orchestrator routes work via team send.' },
]

export const WelcomePane = ({ onAddWorkspace, heroImageSrc }: WelcomePaneProps) => (
  <div
    data-testid="welcome-pane"
    className="m-auto flex w-full flex-col items-center gap-6 px-6 py-12 text-center"
    style={{ maxWidth: '540px' }}
  >
    {heroImageSrc ? <img src={heroImageSrc} alt="" className="h-24 w-24" aria-hidden /> : null}
    <div className="space-y-2">
      <div className="text-2xl font-semibold text-pri">Welcome to Hive</div>
      <div className="text-sm text-sec">Coordinate Claude Code, Codex, Gemini, OpenCode — locally.</div>
    </div>
    <ol className="grid w-full grid-cols-3 gap-3 text-left">
      {steps.map((step, idx) => (
        <li
          key={step.title}
          className="rounded-md border bg-1 p-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="mb-1 flex items-center gap-2 text-pri">
            <span className="font-medium text-xs text-ter">{idx + 1}</span>
            {step.icon}
          </div>
          <div className="text-xs font-medium text-pri">{step.title}</div>
          <div className="mt-1 text-[11px] text-ter">{step.description}</div>
        </li>
      ))}
    </ol>
    <button
      type="button"
      onClick={onAddWorkspace}
      className="hive-cta hive-cta--primary inline-flex items-center gap-2"
    >
      <span>Add your first workspace</span>
      <ArrowRight size={14} aria-hidden />
    </button>
  </div>
)
```

- [ ] **Step 4: Run tests to verify they pass**

`pnpm vitest tests/web/welcome-pane.test.tsx --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/worker/WelcomePane.tsx tests/web/welcome-pane.test.tsx
git commit -m "Add WelcomePane for empty main area"
```

---

## Task 3: Render WelcomePane in WorkspaceDetail's empty branch

**Files:**
- Modify: `web/src/WorkspaceDetail.tsx:45-95` (the `if (!workspace) return null` branch lives here, plus the `App.tsx` parent that knows `setAddDialogTrigger`)
- Modify: `web/src/app.tsx` — pass `onAddWorkspace` callback into `WorkspaceDetail`
- Test: `tests/web/app-shell.test.tsx` (update existing)

- [ ] **Step 1: Write failing test (update existing app-shell test)**

```tsx
test('empty state renders WelcomePane in main area and CTA opens add dialog', async () => {
  render(<App />)
  // Wait for initial fetch
  await waitFor(() => expect(screen.getByTestId('welcome-pane')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /add your first workspace/i }))
  expect(await screen.findByTestId('confirm-workspace-dialog')).toBeInTheDocument()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest app-shell --run` → FAIL: welcome-pane testid not found (still null branch).

- [ ] **Step 3: Wire WelcomePane**

In `web/src/WorkspaceDetail.tsx` accept new prop `onRequestAddWorkspace: () => void`, replace `if (!workspace) return null` with:

```tsx
if (!workspace) {
  return <WelcomePane onAddWorkspace={onRequestAddWorkspace} />
}
```

In `web/src/app.tsx`, pass `onRequestAddWorkspace={() => setAddDialogTrigger((v) => v + 1)}` to `<WorkspaceDetail>`.

- [ ] **Step 4: Re-run tests**

`pnpm vitest app-shell --run` → PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/WorkspaceDetail.tsx web/src/app.tsx tests/web/app-shell.test.tsx
git commit -m "Render WelcomePane in empty main area"
```

---

## Task 4: Surface initialization errors instead of swallowing

**Files:**
- Modify: `web/src/useInitializeUiSession.ts:60-72`
- Test: `tests/web/app-shell.test.tsx` (new test case)

Currently `bootstrap` failure does `console.error` + `setWorkspaces([])` which makes "runtime down" indistinguishable from "no workspaces yet."

- [ ] **Step 1: Write failing test**

```tsx
test('init failure shows error toast and keeps workspaces null (does not fall into empty state)', async () => {
  // Force fetch to fail by pointing at a closed port
  vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
  render(<App />)
  await waitFor(() => {
    expect(screen.getByRole('status', { name: /could not reach/i })).toBeInTheDocument()
  })
  // Welcome should not be shown until we know there are truly no workspaces.
  expect(screen.queryByTestId('welcome-pane')).toBeNull()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest -t "init failure" --run` → FAIL: silent swallow.

- [ ] **Step 3: Wire toast inside `useInitializeUiSession`**

Accept `toast` (via `useToast()`) as part of the hook OR call it directly from inside if hook is currently passive. On bootstrap catch:

```ts
toast.show({
  kind: 'error',
  role: 'status',
  message: 'Could not reach Hive runtime — retry?',
  action: { label: 'Retry', onClick: () => void bootstrap() },
})
// Do NOT setWorkspaces([]) on failure — keep null so Welcome does not render.
```

- [ ] **Step 4: Re-run tests**

Verify all existing tests still pass + new test passes.

- [ ] **Step 5: Commit**

```bash
git add web/src/useInitializeUiSession.ts web/src/ui/useToast.tsx tests/web/app-shell.test.tsx
git commit -m "Surface init failures as retryable toast, not silent empty state"
```

---

## Task 5: Server protocol — capture last output line on team list

**Files:**
- Modify: `src/server/terminal-state-mirror.ts` — add `lastOutputLine()` method reading from headless xterm `buffer.active`
- Modify: `src/server/team-list-serializer.ts:21` — emit `last_output_line: string | null`
- Modify: `src/server/team-operations.ts` — populate from terminal-state-mirror lookup
- Modify: `src/shared/types.ts` — `TeamListItem.lastOutputLine?: string`; `TeamListItemPayload.last_output_line: string | null`
- Modify: `web/src/api.ts` — deserialize
- Test: `tests/server/last-output-line-snapshot.test.ts` (new) — real PTY echoing a line, assert team list response has `last_output_line` matching

**Wire format decision (per AGENTS.md §8):** wire is snake_case `last_output_line`, TS internal is camelCase `lastOutputLine`. Serializer converts.

- [ ] **Step 1: Write failing server test**

```ts
test('team list payload includes last_output_line from active worker PTY', async () => {
  const server = await startTestServer({ /* ... */ })
  const ws = await server.createWorkspace('demo')
  const worker = await server.createWorker(ws.id, { command: 'echo "hello world"' })
  await server.startWorker(worker.id)
  await waitForExit(worker.id)
  const team = await server.fetchJson(`/api/workspaces/${ws.id}/team`)
  expect(team.members[0].last_output_line).toBe('hello world')
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest tests/server/last-output-line-snapshot.test.ts --run` → FAIL (field missing).

- [ ] **Step 3: Implement `terminal-state-mirror.lastOutputLine()`**

Read `terminal.buffer.active` from bottom up, find first non-empty line, trim to 60 chars. Strip ANSI escape codes via existing utility or `String.prototype.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')`.

```ts
export class TerminalStateMirror {
  lastOutputLine(maxLen = 60): string | null {
    const buf = this.terminal.buffer.active
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i)?.translateToString(true)
      if (line && line.trim().length > 0) {
        return line.trim().slice(0, maxLen)
      }
    }
    return null
  }
}
```

- [ ] **Step 4: Wire into team-list-serializer and team-operations**

In `team-list-serializer.ts`, change `TeamListItemPayload` to include `last_output_line: string | null` and serialize from `TeamListItem.lastOutputLine ?? null`.

In `team-operations.ts`, when assembling the team list, query `terminalStreamHub.getMirror(agentId)?.lastOutputLine()` and attach.

- [ ] **Step 5: Deserialize on client**

In `web/src/api.ts`:

```ts
const toTeamListItem = (payload: TeamListItemPayload): TeamListItem => ({
  // ... existing
  lastOutputLine: payload.last_output_line ?? undefined,
})
```

- [ ] **Step 6: Re-run server + cli tests**

`pnpm vitest tests/server tests/cli tests/integration --run`

Expected: all pass (existing payload shape backward-compatible — new field is optional on consumer side).

- [ ] **Step 7: Commit**

```bash
git add src/server/terminal-state-mirror.ts src/server/team-list-serializer.ts src/server/team-operations.ts src/shared/types.ts web/src/api.ts tests/server/last-output-line-snapshot.test.ts
git commit -m "Expose last_output_line on team list payload"
```

---

## Task 6: WorkerCard renders last output line in working state

**Files:**
- Modify: `web/src/worker/WorkerCard.tsx`
- Test: `tests/web/worker-card-live-status.test.tsx` (new)

- [ ] **Step 1: Failing test**

```tsx
test('WorkerCard shows last_output_line beneath status row when worker is working', () => {
  render(
    <WorkerCard worker={{ ...baseWorker, status: 'working', lastOutputLine: 'Editing utils.ts' }} />
  )
  expect(screen.getByTestId('worker-card-live')).toHaveTextContent('Editing utils.ts')
})

test('WorkerCard hides live line when idle (last output is stale)', () => {
  render(<WorkerCard worker={{ ...baseWorker, status: 'idle', lastOutputLine: 'should not show' }} />)
  expect(screen.queryByTestId('worker-card-live')).toBeNull()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest worker-card-live-status --run` → FAIL

- [ ] **Step 3: Add the line beneath status row**

```tsx
{worker.status === 'working' && worker.lastOutputLine ? (
  <div
    data-testid="worker-card-live"
    className="mono mt-1 truncate text-[11px] text-ter"
    title={worker.lastOutputLine}
  >
    {worker.lastOutputLine}
  </div>
) : null}
```

- [ ] **Step 4: Re-run tests**

`pnpm vitest worker --run` (covers worker-card-live-status + existing worker-flow).

- [ ] **Step 5: Commit**

```bash
git add web/src/worker/WorkerCard.tsx tests/web/worker-card-live-status.test.tsx
git commit -m "WorkerCard shows live output line while working"
```

---

## Task 7: OrchestratorHintOverlay component

**Files:**
- Create: `web/src/worker/OrchestratorHintOverlay.tsx`
- Test: `tests/web/orchestrator-hint-overlay.test.tsx`

A floating card overlaid on the Orchestrator terminal that disappears on user input. Mounted by `OrchestratorPane` when status is `running` AND `messageCount === 0` (no user input ever).

- [ ] **Step 1: Failing test**

```tsx
test('hint overlay is visible when no input has been sent yet', () => {
  render(<OrchestratorHintOverlay visible onDismiss={() => {}} />)
  expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
  expect(screen.getByText(/try saying/i)).toBeInTheDocument()
})

test('hint overlay unmounts when visible flips false', () => {
  const { rerender } = render(<OrchestratorHintOverlay visible onDismiss={() => {}} />)
  rerender(<OrchestratorHintOverlay visible={false} onDismiss={() => {}} />)
  expect(screen.queryByTestId('orch-hint')).toBeNull()
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest orchestrator-hint-overlay --run` → FAIL: file missing

- [ ] **Step 3: Create the component**

```tsx
type Props = { visible: boolean; onDismiss: () => void }

export const OrchestratorHintOverlay = ({ visible, onDismiss }: Props) => {
  if (!visible) return null
  return (
    <div
      data-testid="orch-hint"
      role="region"
      aria-label="Orchestrator hint"
      className="absolute right-4 bottom-4 max-w-[340px] rounded-md border bg-2 p-3 shadow-lg"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      <div className="text-xs font-medium text-pri">Try saying</div>
      <div className="mono mt-1 text-xs text-sec">
        Help me write a hello world to /tmp/hello.js
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ter">
        <span>Just type below — the terminal is live.</span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto rounded px-1.5 py-0.5 text-ter hover:bg-3 hover:text-pri"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify**

`pnpm vitest orchestrator-hint-overlay --run` → PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/worker/OrchestratorHintOverlay.tsx tests/web/orchestrator-hint-overlay.test.tsx
git commit -m "Add OrchestratorHintOverlay component"
```

---

## Task 8: OrchestratorPane mounts hint overlay on first run

**Files:**
- Modify: `web/src/worker/OrchestratorPane.tsx`
- Modify: `web/src/worker/useOrchestratorPaneState.ts` — track `hasUserInput: boolean`, flip true on first PTY stdin write or first terminal key event
- Test: `tests/web/orchestrator-pane.test.tsx` (update existing)

- [ ] **Step 1: Failing test**

```tsx
test('hint overlay shows when Orchestrator is running and dismisses on key press', async () => {
  render(<OrchestratorPane {...runningPropsWithNoInputYet} />)
  expect(screen.getByTestId('orch-hint')).toBeInTheDocument()
  // Simulate the user typing into the terminal element
  fireEvent.keyDown(screen.getByRole('textbox', { name: /terminal/i }), { key: 'h' })
  await waitFor(() => expect(screen.queryByTestId('orch-hint')).toBeNull())
})
```

- [ ] **Step 2: Verify failure**

`pnpm vitest orchestrator-pane --run` → FAIL: no orch-hint

- [ ] **Step 3: Add `hasUserInput` flag**

In `useOrchestratorPaneState.ts`, add boolean state initialized to false; expose a `markUserInput()` setter. Wire it to terminal's `onData` handler so any key flips the flag.

In `OrchestratorPane.tsx`:

```tsx
const { run, hasUserInput, markUserInput } = useOrchestratorPaneState(...)
// ...
return (
  <div className="relative h-full">
    <TerminalView ... onUserData={markUserInput} />
    <OrchestratorHintOverlay
      visible={run?.status === 'running' && !hasUserInput}
      onDismiss={markUserInput}
    />
  </div>
)
```

- [ ] **Step 4: Verify**

`pnpm vitest orchestrator-pane --run` → PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/worker/OrchestratorPane.tsx web/src/worker/useOrchestratorPaneState.ts tests/web/orchestrator-pane.test.tsx
git commit -m "Mount hint overlay on first Orchestrator run"
```

---

## Self-Review

After all 8 tasks complete:

- [ ] **Spec coverage:** Each high-severity audit finding (main pane empty / Sidebar split CTA / silent init error / black-box workers / no input hint) has at least one task. ✓
- [ ] **Placeholder scan:** Search the plan for "TODO" / "TBD" / "handle errors appropriately" — none present.
- [ ] **Type consistency:** `lastOutputLine` (camelCase TS) ↔ `last_output_line` (snake_case wire) maintained at every boundary: `TeamListItem`, `TeamListItemPayload`, `api.ts` deserializer, `team-list-serializer.ts`. ✓
- [ ] **AGENTS.md §4 — 4 parallel reviews before declaring done.** Dispatch reviewers for architecture / real bugs / test quality / spec alignment after Task 8.

---

## Verification before declaring done

Run all of:

```bash
pnpm check && pnpm build && pnpm test
```

Plus manual chrome verification:
1. `pnpm dev`, open `http://127.0.0.1:5180/`
2. Empty state → WelcomePane visible, CTA opens dialog
3. Add workspace → Orchestrator starts → hint overlay appears
4. Type any key → hint overlay disappears
5. Add a worker that echoes → its card shows last echoed line while working
6. Kill the runtime mid-session → toast appears with retry button

Stop the runtime; restart Hive; verify state is restored (no regression on existing session recovery).
