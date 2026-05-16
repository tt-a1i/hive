import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'

import { isUiLanguage, UI_LANGUAGE_STORAGE_KEY, type UiLanguage } from './uiLanguage.js'

const enMessages = {
  'addWorker.agentCli': 'Agent CLI',
  'addWorker.agentNotFound': 'not found',
  'addWorker.cancel': 'Cancel',
  'addWorker.create': 'Add Member',
  'addWorker.creating': 'Creating...',
  'addWorker.customPlaceholder':
    'You are a security reviewer focused on auth and input validation. Use team report to hand findings back to the orchestrator.',
  'addWorker.description':
    'Pick a role and a CLI agent. The orchestrator dispatches work via {command}.',
  'addWorker.enterName': 'Enter a name',
  'addWorker.loadingPresets': 'Loading presets...',
  'addWorker.name': 'Name',
  'addWorker.namePlaceholder': 'e.g. Alice',
  'addWorker.modifiedFrom': 'Modified from {role} default',
  'addWorker.pickCliOrStartup': 'Pick a CLI agent or enter a startup command',
  'addWorker.random': 'Random',
  'addWorker.randomAria': 'Generate random member name',
  'addWorker.randomTooltip': 'Roll a random playful name',
  'addWorker.role': 'Role',
  'addWorker.roleInstructions': 'Role instructions',
  'addWorker.roleInstructionsTitle':
    "Injected into the agent's startup prompt and every dispatch. Hive's team protocol stays fixed; this only steers role behavior.",
  'addWorker.reset': 'Reset',
  'addWorker.startupCommand': 'Startup command',
  'addWorker.startupHelp':
    'Optional. Runs through your login shell in this workspace. Use it for custom agents or native resume commands such as {example}.',
  'addWorker.startupOverrides': 'overrides CLI launch',
  'addWorker.title': 'Add team member',
  'addWorker.unavailable': '{name} is not installed',
  'addWorker.emptyInstructions': 'Add role instructions',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.copied': 'Copied',
  'common.copyError': 'Copy error',
  'common.delete': 'Delete',
  'common.idle': 'idle',
  'common.loading': 'Loading...',
  'common.retry': 'Retry',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.start': 'Start',
  'common.starting': 'Starting...',
  'common.stopped': 'stopped',
  'common.working': 'working',
  'demo.banner': 'DEMO MODE — agents are pre-recorded, not running.',
  'demo.exit': 'Exit Demo',
  'firstRun.addWorkspace': 'Add Workspace',
  'firstRun.back': 'Back',
  'firstRun.desc': 'Coordinate multiple CLI coding agents — locally.',
  'firstRun.getStarted': 'Get started',
  'firstRun.howItWorks': 'How it works',
  'firstRun.next': 'Next',
  'firstRun.optionDesc': 'Choose how you want to begin.',
  'firstRun.slide1Desc': 'Pick a project folder on your machine.',
  'firstRun.slide1Title': 'Add a workspace',
  'firstRun.slide2Desc': 'Claude Code, Codex, Gemini, OpenCode — your choice.',
  'firstRun.slide2Title': 'Pick an Orchestrator',
  'firstRun.slide3Desc': 'The Queen runs `team send <worker> <task>` for you in the terminal.',
  'firstRun.slide3Title': 'Dispatch tasks',
  'firstRun.skip': 'Skip',
  'firstRun.skipForNow': 'Skip for now',
  'firstRun.step': 'Step {current} of {total}',
  'firstRun.subtitle':
    'Each workspace runs a Queen (orchestrator) that dispatches tasks to Workers.',
  'firstRun.title': 'Welcome to Hive',
  'firstRun.tryDemo': 'Try Demo',
  'language.aria': 'Switch language',
  'language.en': 'EN',
  'language.tooltip': 'Language',
  'language.zh': '中文',
  'orchestrator.copyErrorAria': 'Copy error message',
  'orchestrator.failed': 'Queen failed to start',
  'orchestrator.removeWorkspace': 'Remove workspace',
  'orchestrator.start': 'Start Queen',
  'orchestrator.startingDesc': 'Preparing the orchestrator terminal.',
  'orchestrator.startingTitle': 'Starting Queen',
  'orchestrator.stoppedDesc': 'Start the Queen to plan tasks and dispatch them to workers.',
  'orchestrator.stoppedTitle': 'Queen is stopped',
  'role.coder': 'Coder',
  'role.custom': 'Custom',
  'role.reviewer': 'Reviewer',
  'role.tester': 'Tester',
  'sidebar.deleteAria': 'Delete workspace {name}',
  'sidebar.deleteConfirm': 'Delete workspace "{name}"?',
  'sidebar.deleteDescription':
    'This stops its agents and removes it from Hive. The folder on disk ({path}) is left untouched. {summary}.',
  'sidebar.deleteFailed': 'Failed to delete: {message}',
  'sidebar.deleteLabel': 'Delete workspace',
  'sidebar.deleting': 'Deleting...',
  'sidebar.noMembers': 'no team members yet',
  'sidebar.newWorkspace': 'New workspace',
  'sidebar.noWorkspaces': 'No workspaces',
  'sidebar.noWorkspacesDesc':
    'Add one to start. Hive will load .hive/tasks.md and start the Orchestrator.',
  'sidebar.oneWorking': 'One team member working',
  'sidebar.removed': 'Removed workspace "{name}".',
  'sidebar.teamMemberCount': '{count} team member{plural}',
  'sidebar.workingCount': '{working} of {total} working',
  'sidebar.workingMembers': '{count} team members working',
  'sidebar.workspaces': 'Workspaces',
  'topbar.hideTodo': 'Hide Todo',
  'topbar.showTodo': 'Show Todo (.hive/tasks.md)',
  'topbar.todo': 'Todo',
  'topbar.todoOpen': 'Todo — {count} open task{plural}',
  'topbar.updateAvailable': 'Update available',
  'welcome.addWorkspace': 'Add your first workspace',
  'welcome.demo': 'or try the demo (no install needed)',
  'welcome.desc': 'Coordinate Claude Code, Codex, Gemini, OpenCode — locally.',
  'welcome.step1Desc': 'Pick a project folder.',
  'welcome.step1Title': 'Add a workspace',
  'welcome.step2Desc': 'Claude / Codex / Gemini / OpenCode.',
  'welcome.step2Title': 'Choose an Orchestrator',
  'welcome.step3Desc': 'The Orchestrator routes work via team send.',
  'welcome.step3Title': 'Dispatch tasks',
  'welcome.title': 'Welcome to Hive',
  'worker.deleteAria': 'Delete {name}',
  'worker.deleteConfirm': 'Delete {name}?',
  'worker.deleteDescription':
    "This stops {name}'s terminal and removes it from the workspace. All queued dispatches are dropped.",
  'worker.deleteMember': 'Delete member',
  'worker.detail': '{name} detail',
  'worker.emptyAdd': 'Add your first member',
  'worker.emptyDesc':
    'Add workers (Claude Code, Codex, Gemini, OpenCode) and the Orchestrator will route tasks to them.',
  'worker.emptyTitle': 'No team members yet',
  'worker.open': 'Open {name}',
  'worker.pendingResume': '{count} pending task(s) will resume after restart.',
  'worker.rename': 'Rename',
  'worker.renameAria': 'Rename {name}',
  'worker.renameDesc': "Pick a new display name. The agent's id and PTY are unchanged.",
  'worker.renameFailed': 'Rename failed: {message}',
  'worker.renameSuccess': 'Renamed to "{name}".',
  'worker.renameTitle': 'Rename team member',
  'worker.startAgent': 'Start the agent to begin receiving dispatches.',
  'worker.startAria': 'Start {name}',
  'worker.teamMembers': 'Team Members',
  'worker.terminalNotStarted': 'PTY not started yet — ',
  'worker.terminalStopped': 'PTY stopped — ',
  'worker.widthResize': 'Resize worker detail width',
  'workerPane.resize': 'Resize Orchestrator and Team Members panes',
} as const

export type TranslationKey = keyof typeof enMessages

const zhMessages: Record<TranslationKey, string> = {
  'addWorker.agentCli': 'Agent CLI',
  'addWorker.agentNotFound': '未找到',
  'addWorker.cancel': '取消',
  'addWorker.create': '添加成员',
  'addWorker.creating': '创建中...',
  'addWorker.customPlaceholder':
    '你是安全审查成员，重点关注鉴权和输入校验。用 team report 把发现交还给 Orchestrator。',
  'addWorker.description': '选择角色和 CLI agent。Orchestrator 会通过 {command} 分派任务。',
  'addWorker.emptyInstructions': '补充角色说明',
  'addWorker.enterName': '请输入名称',
  'addWorker.loadingPresets': '正在加载预设...',
  'addWorker.name': '名称',
  'addWorker.namePlaceholder': '例如 火锅判官-27',
  'addWorker.modifiedFrom': '已偏离 {role} 默认说明',
  'addWorker.pickCliOrStartup': '请选择 CLI agent，或填写启动命令',
  'addWorker.random': '随机',
  'addWorker.randomAria': '生成随机成员名',
  'addWorker.randomTooltip': '摇一个有趣的随机名字',
  'addWorker.role': '角色',
  'addWorker.roleInstructions': '角色说明',
  'addWorker.roleInstructionsTitle':
    '会注入到 agent 启动提示和每次派单中。Hive 的 team 协议保持不变，这里只影响角色行为。',
  'addWorker.reset': '重置',
  'addWorker.startupCommand': '启动命令',
  'addWorker.startupHelp':
    '可选。会在当前 workspace 里通过登录 shell 运行。适合自定义 agent 或原生命令恢复会话，例如 {example}。',
  'addWorker.startupOverrides': '覆盖 CLI 启动',
  'addWorker.title': '添加团队成员',
  'addWorker.unavailable': '{name} 未安装',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.copied': '已复制',
  'common.copyError': '复制错误',
  'common.delete': '删除',
  'common.idle': '空闲',
  'common.loading': '加载中...',
  'common.retry': '重试',
  'common.save': '保存',
  'common.saving': '保存中...',
  'common.start': '启动',
  'common.starting': '启动中...',
  'common.stopped': '已停止',
  'common.working': '工作中',
  'demo.banner': '演示模式 — agent 是预录数据，没有真实运行。',
  'demo.exit': '退出演示',
  'firstRun.addWorkspace': '添加 Workspace',
  'firstRun.back': '返回',
  'firstRun.desc': '在本地协调多个 CLI 编码 agent。',
  'firstRun.getStarted': '开始使用',
  'firstRun.howItWorks': '工作方式',
  'firstRun.next': '下一步',
  'firstRun.optionDesc': '选择一个开始方式。',
  'firstRun.slide1Desc': '选择本机项目目录。',
  'firstRun.slide1Title': '添加 Workspace',
  'firstRun.slide2Desc': 'Claude Code、Codex、Gemini、OpenCode，任选。',
  'firstRun.slide2Title': '选择 Orchestrator',
  'firstRun.slide3Desc': 'Queen 会在终端中通过 `team send <worker> <task>` 派单。',
  'firstRun.slide3Title': '分派任务',
  'firstRun.skip': '跳过',
  'firstRun.skipForNow': '暂时跳过',
  'firstRun.step': '第 {current} / {total} 步',
  'firstRun.subtitle': '每个 workspace 运行一个 Queen（orchestrator），再把任务派给 Workers。',
  'firstRun.title': '欢迎使用 Hive',
  'firstRun.tryDemo': '试用演示',
  'language.aria': '切换语言',
  'language.en': 'EN',
  'language.tooltip': '语言',
  'language.zh': '中文',
  'orchestrator.copyErrorAria': '复制错误信息',
  'orchestrator.failed': 'Queen 启动失败',
  'orchestrator.removeWorkspace': '移除 workspace',
  'orchestrator.start': '启动 Queen',
  'orchestrator.startingDesc': '正在准备 orchestrator 终端。',
  'orchestrator.startingTitle': 'Queen 启动中',
  'orchestrator.stoppedDesc': '启动 Queen 后才能规划任务并分派给 workers。',
  'orchestrator.stoppedTitle': 'Queen 已停止',
  'role.coder': '实现',
  'role.custom': '自定义',
  'role.reviewer': '审查',
  'role.tester': '验证',
  'sidebar.deleteAria': '删除 workspace {name}',
  'sidebar.deleteConfirm': '删除 workspace "{name}"？',
  'sidebar.deleteDescription':
    '这会停止其中的 agents，并从 Hive 移除它。磁盘目录（{path}）不会被删除。{summary}。',
  'sidebar.deleteFailed': '删除失败：{message}',
  'sidebar.deleteLabel': '删除 workspace',
  'sidebar.deleting': '删除中...',
  'sidebar.noMembers': '还没有团队成员',
  'sidebar.newWorkspace': '新建 workspace',
  'sidebar.noWorkspaces': '还没有 workspace',
  'sidebar.noWorkspacesDesc': '添加一个开始使用。Hive 会加载 .hive/tasks.md 并启动 Orchestrator。',
  'sidebar.oneWorking': '1 个团队成员工作中',
  'sidebar.removed': '已移除 workspace "{name}"。',
  'sidebar.teamMemberCount': '{count} 个团队成员',
  'sidebar.workingCount': '{working} / {total} 工作中',
  'sidebar.workingMembers': '{count} 个团队成员工作中',
  'sidebar.workspaces': 'Workspaces',
  'topbar.hideTodo': '隐藏 Todo',
  'topbar.showTodo': '显示 Todo (.hive/tasks.md)',
  'topbar.todo': 'Todo',
  'topbar.todoOpen': 'Todo — {count} 个未完成任务',
  'topbar.updateAvailable': '有新版本',
  'welcome.addWorkspace': '添加第一个 workspace',
  'welcome.demo': '或试用演示（无需安装 CLI）',
  'welcome.desc': '在本地协调 Claude Code、Codex、Gemini、OpenCode。',
  'welcome.step1Desc': '选择一个项目目录。',
  'welcome.step1Title': '添加 workspace',
  'welcome.step2Desc': 'Claude / Codex / Gemini / OpenCode。',
  'welcome.step2Title': '选择 Orchestrator',
  'welcome.step3Desc': 'Orchestrator 通过 team send 分派任务。',
  'welcome.step3Title': '分派任务',
  'welcome.title': '欢迎使用 Hive',
  'worker.deleteAria': '删除 {name}',
  'worker.deleteConfirm': '删除 {name}？',
  'worker.deleteDescription': '这会停止 {name} 的终端，并从 workspace 中移除它。排队任务会被丢弃。',
  'worker.deleteMember': '删除成员',
  'worker.detail': '{name} 详情',
  'worker.emptyAdd': '添加第一个成员',
  'worker.emptyDesc':
    '添加 workers（Claude Code、Codex、Gemini、OpenCode），Orchestrator 会把任务分派给他们。',
  'worker.emptyTitle': '还没有团队成员',
  'worker.open': '打开 {name}',
  'worker.pendingResume': '重启后会继续 {count} 个排队任务。',
  'worker.rename': '重命名',
  'worker.renameAria': '重命名 {name}',
  'worker.renameDesc': '选择新的显示名称。agent id 和 PTY 不会变化。',
  'worker.renameFailed': '重命名失败：{message}',
  'worker.renameSuccess': '已重命名为 "{name}"。',
  'worker.renameTitle': '重命名团队成员',
  'worker.startAgent': '启动 agent 后即可接收派单。',
  'worker.startAria': '启动 {name}',
  'worker.teamMembers': '团队成员',
  'worker.terminalNotStarted': 'PTY 还未启动 — ',
  'worker.terminalStopped': 'PTY 已停止 — ',
  'worker.widthResize': '调整成员详情宽度',
  'workerPane.resize': '调整 Orchestrator 和团队成员面板宽度',
}

const messages = {
  en: enMessages,
  zh: zhMessages,
} satisfies Record<UiLanguage, Record<TranslationKey, string>>

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string

interface I18nValue {
  language: UiLanguage
  setLanguage: (language: UiLanguage) => void
  t: Translate
}

const getInitialLanguage = (): UiLanguage => {
  if (typeof window === 'undefined') return 'en'
  const stored = readStoredLanguage()
  if (stored) return stored
  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const readStoredLanguage = (): UiLanguage | null => {
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    return isUiLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

const writeStoredLanguage = (language: UiLanguage) => {
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Language switching should still work for this session when storage is unavailable.
  }
}

const createTranslator =
  (language: UiLanguage): Translate =>
  (key, values = {}) =>
    messages[language][key].replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = values[name]
      return value === undefined ? match : String(value)
    })

const fallbackValue: I18nValue = {
  language: 'en',
  setLanguage: () => {},
  t: createTranslator('en'),
}

const I18nContext = createContext<I18nValue>(fallbackValue)

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<UiLanguage>(getInitialLanguage)

  const value = useMemo<I18nValue>(() => {
    const setLanguage = (nextLanguage: UiLanguage) => {
      setLanguageState(nextLanguage)
      writeStoredLanguage(nextLanguage)
    }
    return {
      language,
      setLanguage,
      t: createTranslator(language),
    }
  }, [language])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = (): I18nValue => useContext(I18nContext)
