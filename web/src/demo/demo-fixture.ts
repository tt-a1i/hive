import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: 'demo-workspace',
  name: 'demo-todo-app',
  path: '/Users/you/demo-todo-app',
}

export const DEMO_WORKERS: TeamListItem[] = [
  { id: 'demo-orch', name: 'queen', role: 'coder', status: 'idle', pendingTaskCount: 0 },
  {
    id: 'demo-coder',
    name: 'alice',
    role: 'coder',
    status: 'working',
    pendingTaskCount: 1,
    lastOutputLine: 'Editing src/routes/todos.ts (line 42)',
  },
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
    '$ team send alice "Implement POST /todos"\r\n' +
    '> dispatched to alice\r\n' +
    '$ team list\r\n' +
    '> alice: working (1 task)\r\n' +
    '> bob: idle\r\n',
  'demo-coder':
    'Reading src/routes/todos.ts ...\r\n' +
    'Drafting POST handler ...\r\n' +
    'Editing src/routes/todos.ts (line 42)\r\n',
  'demo-reviewer': 'Idle — waiting for review tasks.\r\n',
}
