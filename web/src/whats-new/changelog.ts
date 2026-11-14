/**
 * Bundled, bilingual changelog for the "What's New" dialog.
 *
 * Local-first: shipped with the build, no network. Each release adds ONE entry
 * at the top (newest first) with short, user-facing highlights in both
 * languages — not a raw git log. The top entry's `version` must equal
 * package.json's version; `tests/unit/whats-new-select.test.ts` enforces that,
 * so a version bump that forgets its changelog entry fails the test suite.
 */
export interface ChangelogEntry {
  version: string
  /** ISO date, YYYY-MM-DD. */
  date: string
  en: string[]
  zh: string[]
}

// Newest first.
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '3.0.0',
    date: '2026-11-14',
    en: [
      'Switch an existing Orchestrator or member to another CLI while preserving open work and handing over current task context.',
      'Ask blocking questions with team ask, recover saved questions after timeouts, and start configured stopped members on demand.',
      'Short messages can arrive inline; long, control-bearing or combined reports use private files. Idle native session resumes stay quiet.',
      'Codex App external control, MCP servers, Team Memory and Dream have been removed. Codex CLI and team recall remain available.',
      'Back up your Hive data before upgrading: migration deletes retired controller and memory tables. Terminal reliability and local request validation have also improved.',
    ],
    zh: [
      '已有主控和成员可以切换到其他 CLI，保留未完成责任，并把当前任务上下文交给新进程。',
      'team ask 可等待答复，超时后可续查已保存的问题；已配置但停止的成员可按需启动。',
      '短消息可直接送达，长消息、含控制字符的消息或合并汇报可使用私有文件；空闲原生会话恢复保持安静。',
      '已移除 Codex App 外部主控、MCP 服务、Team Memory 和 Dream，保留 Codex CLI 与 team recall 历史检索。',
      '升级前请备份 Hive 数据：迁移会删除旧主控和记忆表。本版还改善了终端稳定性和本机请求校验。',
    ],
  },
  {
    version: '2.2.1',
    date: '2026-09-08',
    en: [
      'Collaboration guidance now weighs task quality, time and coordination effort while preserving your configured members and models.',
      'Agents can read current workspace guidance when needed, with clearer rules for questions, replies and accepting results.',
      'Custom workflow role descriptions now reach the member startup prompt; fresh npm installs also work with lifecycle scripts disabled.',
    ],
    zh: [
      '协作指引统一考虑任务质量、耗时与协调成本，并沿用你配置的成员和模型。',
      'Agent 可按需读取当前工作区指南，提问、回复和结果验收的规则更清晰。',
      '自定义工作流角色描述现在会传入成员启动提示；新安装也支持禁用 npm 生命周期脚本。',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-09-06',
    en: [
      'Ask questions and add requirements within the original task; keep related reviews, follow-ups and report history connected in Action Center.',
      'Hive Orchestrator and Codex App now share coordination principles: use your existing members and model choices, clarify project scope, and verify evidence before accepting results.',
      'Codex App controller connections now prompt a team check; result notifications identify their receipts so delayed reminders can be recognized.',
      'Task recovery preserves open work and new inputs, with improved npm 12 installation and package verification.',
    ],
    zh: [
      '问题、答复和补充要求保留在原任务中；Action Center 可查看关联审查、后续工作和报告历史。',
      'Hive 内主控与 Codex App 主控共用协作原则：沿用你配置的成员和模型，核对项目范围，依据证据验收结果。',
      'Codex App 确认连接后会收到团队核对提醒；结果通知携带回执标识，便于识别迟到提醒。',
      '任务恢复保留开放工作与新增输入，并改进 npm 12 安装和包验证。',
    ],
  },
  {
    version: '2.1.19',
    date: '2026-07-22',
    en: [
      'Restored terminals now preserve SGR mouse encoding, preventing mouse movement and wheel input from appearing as raw characters after reconnecting or opening a restored terminal, including on Windows remote sessions.',
      '`team report` now keeps delivery status accurate until the Orchestrator terminal write settles, with clearer diagnostics if queued delivery cannot drain.',
      'The bundled English and Chinese agent marketplace now includes a broader and refreshed set of engineering, security, GIS, operations, marketing, and other specialist roles.',
    ],
    zh: [
      '终端恢复时现在会保留 SGR 鼠标编码，避免重连或打开已恢复终端后，鼠标移动和滚轮输入变成原始乱码字符，包括 Windows 远程会话。',
      '`team report` 现在会在 Orchestrator 终端写入真正完成后再更新投递状态；队列无法清空时也会提供更清晰的诊断信息。',
      '内置的中英文 Agent Marketplace 已扩充并刷新，新增更多工程、安全、GIS、运营、营销及其他专业角色。',
    ],
  },
  {
    version: '2.1.18',
    date: '2026-07-12',
    en: [
      'The workspace sidebar, team member cards, task drawer, and Memory drawer have a clearer visual hierarchy with improved compact and mobile layouts.',
      'Generated member names now come from one shared 1,111-name bank across roles, languages, Add Member, and scenario presets.',
      "Scheduled Dream maintenance now uses the workspace Orchestrator's configured Claude or Codex CLI and preset environment instead of assuming Claude.",
      'Scheduled Dream command launching and timeout cleanup are more reliable on Windows, including npm command shims and child process trees.',
    ],
    zh: [
      'Workspace 侧边栏、团队成员卡片、任务抽屉和 Memory 抽屉采用了更清晰的视觉层级，并改善了紧凑布局和移动端体验。',
      '自动生成的成员名称现在统一来自一个包含 1,111 个名字的名称库，并在不同角色、语言、Add Member 和场景预设之间保持一致。',
      '定时 Dream 维护现在会使用当前 workspace Orchestrator 配置的 Claude 或 Codex CLI 及其 preset 环境，不再固定假设使用 Claude。',
      '定时 Dream 在 Windows 上的命令启动和超时清理更可靠，包括对 npm 命令 shim 和子进程树的处理。',
    ],
  },
  {
    version: '2.1.17',
    date: '2026-07-08',
    en: [
      'The retired Sentinel patrol role has been removed from team setup and role settings. Hive now keeps the worker role set focused on Coder, Reviewer, Tester, and Custom.',
      'Existing local databases are cleaned up on upgrade so stale Sentinel templates and workers no longer remain in the roster.',
      'Dispatches are quieter: members no longer send an immediate "accepted dispatch" status for every task, and instead report when the task is done, blocked, failed, or partially complete.',
    ],
    zh: [
      '已移除废弃的 Sentinel 巡检角色，不再出现在组队和角色设置里。Hive 现在只保留 Coder、Reviewer、Tester 和 Custom 这组 worker 角色。',
      '升级时会清理本地数据库里遗留的 Sentinel 模板和成员，避免旧巡检角色继续留在团队列表中。',
      '派单更安静：成员收到任务后不再先发一条“accepted dispatch”状态，而是直接开始工作，并在完成、阻塞、失败或部分完成时汇报。',
    ],
  },
  {
    version: '2.1.16',
    date: '2026-07-08',
    en: [
      'Codex workers are less likely to appear to lose context after a temporary resume failure. Hive now keeps the saved session when the underlying Codex conversation still exists.',
      'If the saved Codex session is truly gone, Hive clears the stale pointer and starts fresh instead of retrying a broken resume.',
      'Session cleanup now uses the same existence check across supported native session stores, keeping resume behavior more consistent across CLI presets.',
    ],
    zh: [
      'Codex 成员在临时 resume 失败后更不容易看起来“丢上下文”。只要底层 Codex 对话还在，Hive 会保留已保存的 session。',
      '如果已保存的 Codex session 确实不存在了，Hive 会清掉陈旧指针并重新启动，而不是反复尝试坏掉的 resume。',
      'Session 清理现在复用同一套原生 session 存在性检查，让不同 CLI preset 的恢复行为更一致。',
    ],
  },
  {
    version: '2.1.15',
    date: '2026-07-02',
    en: [
      'Workers can now have custom avatars. Upload and crop an image from the team UI, and Hive will persist it with the worker.',
      'Worker avatars appear in the browser workspace without bloating CLI `team list` output.',
      'Terminal rendering is more reliable under heavy output and reconnect/restore flows, reducing stale or duplicated frames.',
      '`team report` is clearer when Hive has accepted a report and durable Orchestrator delivery is still in progress, avoiding false failure wording.',
      'Orchestrator guidance now waits more patiently for accepted dispatches to report back before nudging or cancelling members.',
    ],
    zh: [
      '成员现在可以设置自定义头像。你可以在团队界面上传并裁剪图片，Hive 会把头像随成员一起保存。',
      '成员头像会显示在浏览器 workspace 中，但不会塞进 CLI 的 `team list` 输出。',
      '终端在大量输出、重连和恢复场景下的渲染更可靠，减少陈旧或重复的终端画面。',
      '当 Hive 已接收 `team report`、但仍在把报告可靠投递给 Orchestrator 时，命令行提示会更准确，不再误报成失败。',
      'Orchestrator 指引现在会更耐心等待已接收派单的成员回报，减少过早催促或取消。',
    ],
  },
  {
    version: '2.1.14',
    date: '2026-06-25',
    en: [
      'Returning to a Hive browser tab now focuses the active Orchestrator terminal automatically, so you can keep typing without an extra click.',
      'Opening a member panel now focuses that member terminal automatically, while Hive still avoids stealing focus from normal text fields or workspace shell terminals.',
      'Dream memory consolidation is less likely to fail on procedure-reference validation: ordinary workflow advice is now steered toward regular memory unless it points to a real saved workflow, skill, procedure, template, or document.',
    ],
    zh: [
      '从其他浏览器标签页切回 Hive 时，当前 Orchestrator 终端会自动获得焦点，可以直接继续输入，不用再点一次终端。',
      '打开成员面板时，该成员终端也会自动获得焦点；同时 Hive 不会抢普通文本输入框或 workspace shell 终端的焦点。',
      'Dream 记忆整理更不容易因为 procedure_ref 校验失败：普通流程经验会被引导保存为常规记忆，只有真正指向已有 workflow、skill、procedure、template 或文档时才使用 procedure reference。',
    ],
  },
  {
    version: '2.1.12',
    date: '2026-06-25',
    en: [
      'Hive now starts on the less common local port 9483 by default, reducing collisions with other development services. You can still use `hive --port 0` to ask the OS for any free port.',
      'Pi is now a built-in agent preset. Hive can launch `pi --approve`, wait for the Pi prompt before sending startup input, and allow Pi in workflow CLI policy.',
      'The Supervisor MCP adapter and development proxy now follow the same default runtime port, so external supervisors and local development stay aligned.',
    ],
    zh: [
      'Hive 默认启动端口改为较少冲突的本机端口 9483，降低和常见开发服务撞端口的概率；仍可用 `hive --port 0` 让系统自动分配空闲端口。',
      'Pi 现在是内置 agent preset。Hive 可以启动 `pi --approve`，等待 Pi 提示符就绪后再注入启动输入，并允许 workflow CLI policy 使用 Pi。',
      'Supervisor MCP adapter 和开发代理也改为跟随同一个默认 runtime 端口，外部 supervisor 和本地开发配置保持一致。',
    ],
  },
  {
    version: '2.1.11',
    date: '2026-06-25',
    en: [
      'Hive now includes a local Supervisor MCP adapter, so external agents can hand goals to the Hive Orchestrator and wait on durable structured goal events.',
      'Orchestrators can report external goal progress, blocked states, failures, and completion with `team goal report`, while external supervisors still cannot directly spawn members, send member tasks, read raw scrollback, or write PTYs.',
      'OpenCode startup input delivery is more reliable after completed turns and interrupt-status screens, and Codex prompt editing now preserves repaint frames after Backspace/Delete-style input.',
    ],
    zh: [
      'Hive 现在包含本地 Supervisor MCP adapter，外部 agent 可以把目标交给 Hive Orchestrator，并通过持久化结构化 goal events 等待进度和结果。',
      'Orchestrator 可以用 `team goal report` 回报 external goal 的进度、阻塞、失败和完成；外部 supervisor 仍不能直接 spawn 成员、给成员派单、读取原始 scrollback 或写 PTY。',
      'OpenCode 在完成一轮和显示 interrupt 状态后的启动输入投递更可靠；Codex 在 Backspace/Delete 类输入后的提示行重绘也会被保留。',
    ],
  },
  {
    version: '2.1.10',
    date: '2026-06-23',
    en: [
      'One-click scenario teams now start their members immediately, so they are ready for the Orchestrator to assign work instead of appearing as stopped cards.',
      'OpenCode members are more reliable after startup: Hive now recognizes OpenCode completed-turn footers as a safe dispatch point and asks members to acknowledge received dispatches.',
      'Terminal panes now follow real run lifecycle events more closely, and Codex cursor repaint frames keep the final cursor position during editing.',
    ],
    zh: [
      '一键场景组队现在会立即启动创建出的成员，成员不会再以 stopped 卡片停在那里，Orchestrator 可以直接派工。',
      'OpenCode 成员启动后的派发更可靠：Hive 现在能识别 OpenCode 完成一轮后的 footer，并要求成员收到派单后先发出确认状态。',
      '终端面板现在更贴近真实 run 生命周期；Codex 编辑时的光标刷新也会保留最终光标位置。',
    ],
  },
  {
    version: '2.1.9',
    date: '2026-06-23',
    en: [
      'Hive now gives Orchestrators a shorter startup prompt and points them to focused `team guide` topics when they need dispatch, task, memory, workflow, or member details.',
      'Agent-facing language now consistently talks about Hive members, matching the product model you see in the UI.',
      'This release also includes the Codex CJK backspace repaint fix and the cleaner desktop member-window outside-click close behavior.',
    ],
    zh: [
      'Hive 现在给 Orchestrator 注入更短的启动提示，并在需要派单、任务、记忆、workflow 或成员细节时，引导它读取对应的 `team guide`。',
      '面向 agent 的文案统一改为 Hive 成员口径，更贴近界面里的产品模型。',
      '本次也包含 Codex 中文/CJK 删除键刷新修复，以及桌面端成员窗口点击外部关闭的更清爽交互。',
    ],
  },
  {
    version: '2.1.8',
    date: '2026-06-23',
    en: [
      'Codex terminals now repaint CJK input correctly when you press Backspace, so deleted characters disappear immediately instead of lingering on screen.',
      'Desktop member windows no longer show a visible close button over the terminal corner; click outside the window to close it, while mobile keeps its full-screen close button.',
    ],
    zh: [
      'Codex 终端现在能正确刷新中文/CJK 输入：按下删除键后，被删字符会立即从画面消失，不再残留。',
      '桌面端成员窗口不再在终端右上角显示关闭按钮；点击窗口外即可关闭，移动端全屏窗口仍保留关闭按钮。',
    ],
  },
  {
    version: '2.1.7',
    date: '2026-06-23',
    en: [
      'Worker reports are now queued for durable redelivery when the Orchestrator is offline or restarting, so completed work is not silently lost.',
      'Cancels, dismissed workers, and queued dispatch recovery now produce clearer outcomes when work can no longer be delivered.',
      'User input now fails honestly when the Orchestrator terminal is offline instead of being recorded as if it had been sent.',
      'Remote access has a stricter pairing boundary: phones cannot read or approve desktop-only pairing requests through the tunnel.',
    ],
    zh: [
      '当 Orchestrator 离线或重启时，worker report 现在会进入持久化重投递队列，完成的工作不会再静默丢失。',
      '取消任务、删除 worker 和排队派单恢复路径现在会给出更明确的结果，避免无法投递的工作一直悬着。',
      '当 Orchestrator 终端离线时，用户输入现在会真实失败，不再被记录成已经发送。',
      '远程访问的配对边界更严格：手机端不能通过 tunnel 读取或审批只能在桌面完成的新设备配对请求。',
    ],
  },
  {
    version: '2.1.6',
    date: '2026-06-21',
    en: [
      'Hive now shows a global package-update prompt when a newer npm version is available, so upgrade visibility is not limited to the topbar.',
      'Newly started workers send a ready status after receiving Hive startup instructions, giving the Orchestrator a clearer signal that the member actually came online.',
      'The Orchestrator pane no longer exposes a stop button in its chrome, reducing accidental shutdowns of the central coordinator.',
      'Action Center now opens as a dedicated drawer with live workspace health, attention items, recent activity, and worker selection instead of a compact popover.',
    ],
    zh: [
      '检测到新的 npm 版本时，Hive 现在会显示全局更新提示，不再只依赖顶部栏的小提示。',
      '新启动的成员收到 Hive 启动指令后会主动发送 ready 状态，让 Orchestrator 更清楚成员已经真正上线。',
      'Orchestrator 面板不再显示关闭按钮，降低误关中央协调者的风险。',
      'Action Center 改为专用抽屉面板，集中展示 workspace 健康状态、待关注事项、最近动态和成员选择，不再使用紧凑 popover。',
    ],
  },
  {
    version: '2.1.5',
    date: '2026-06-21',
    en: [
      'Team memory is more ambient: the Memory drawer no longer asks you to review candidates, while active memory, archived entries, and Dream history stay available for audit.',
      'Hive can now keep lightweight user preferences separately from workspace project facts, so personal working style does not pollute team knowledge.',
      'Workflow and skill memories can point to structured procedure references instead of copying long instructions into memory text.',
      'Dispatch memory retrieval is stricter about relevance, avoiding unrelated role-only matches when a worker receives a new task.',
      'Dream consolidation can run in the background with transactional apply, source checks, isolated failures, and one-step revert.',
    ],
    zh: [
      '团队记忆更低打扰：Memory 抽屉不再让你处理候选记忆，但 active 记忆、归档项和 Dream 历史仍可审计。',
      'Hive 现在可以把轻量用户偏好与 workspace 项目事实分开保存，个人工作风格不会污染团队知识。',
      '流程和 skill 类记忆可以引用结构化 procedure，不再把长流程说明直接塞进记忆正文。',
      '派单记忆检索更严格，只在任务相关时注入，避免仅因 worker 角色匹配就带入无关记忆。',
      'Dream 整理可在后台完成，带事务 apply、source window 校验、失败隔离和一键回滚。',
    ],
  },
  {
    version: '2.1.4',
    date: '2026-06-21',
    en: [
      'The first workspace screen is quieter: Hive no longer pushes an Orchestrator dispatch prompt before you have a concrete task.',
      'Team activity is easier to scan, with dispatch pulse effects and queue-count badges removed from the visible UI.',
      'The collapsed empty-workspace sidebar no longer shows a stray compact add button.',
      'Maintainer release checks now use a faster package-focused default gate, with the full test gate still available for high-risk releases.',
    ],
    zh: [
      '第一个 workspace 页面更安静：在你还没有明确任务前，Hive 不再主动提示 Orchestrator 派发工作。',
      '团队动态更好扫读：可见 UI 里的派单脉冲和排队数量徽标已移除。',
      '空 workspace 的折叠侧栏不再出现孤立的紧凑添加按钮。',
      '维护者发布检查改为默认使用更快的打包发版闸门；高风险发版仍保留完整测试闸门。',
    ],
  },
  {
    version: '2.1.3',
    date: '2026-06-18',
    en: [
      'Hive now waits when first-run CLI setup screens are visible, so startup instructions no longer collide with trust, login, or confirmation prompts.',
      'User input reports a real delivery failure if the Orchestrator terminal is offline.',
      'Built-in role contracts and scenario/spawn defaults are language-aware, so English workspaces receive English worker prompts by default.',
      'The demo is now a local self-running Hive replay with task progress, worker state changes, and team dispatch flow instead of an external video.',
      'Release checks include a local CLI compatibility report for native modules and Tier-1 agent CLIs.',
      'Settings now shows local-only retention diagnostics, and Memory keeps ambient Dream-maintained workspace knowledge without a candidate review surface.',
    ],
    zh: [
      '首次运行 CLI 出现信任、登录或确认提示时，Hive 现在会等待，不再把启动指令盲注入到 onboarding 屏幕里。',
      '如果 Orchestrator 终端已离线，用户输入会明确返回投递失败，而不是假装成功。',
      '内置角色契约和场景/派生成员默认值已支持语言感知，英文 workspace 默认收到英文 worker prompt。',
      'Demo 改成本地自运行 Hive replay，直接展示任务进度、worker 状态变化和团队派单流，不再依赖外部视频。',
      '发布检查新增本地 CLI 兼容报告，覆盖原生模块和 Tier-1 agent CLI。',
      'Settings 增加本地留存诊断；Memory 保持由 Dream 维护的低打扰工作区知识，不再展示人工复核入口。',
    ],
  },
  {
    version: '2.1.2',
    date: '2026-06-16',
    en: [
      'Newly spawned workers now wake correctly for their first team send instead of leaving the task parked in the stopped queue.',
      'If a spawned worker is later stopped manually, Hive still keeps the normal queued-task behavior until you start that worker again.',
      'Claude Code sessions on Windows are more tolerant of large Hive startup and dispatch injections, reducing premature submit or leftover input.',
    ],
    zh: [
      '新建的 worker 现在会正确接住第一次 team send，不会把任务停在 stopped 队列里。',
      '如果这个 worker 后续被手动停止，Hive 仍会保留正常的排队语义：任务等你再次启动该 worker 后再投递。',
      'Windows 上的 Claude Code 会更稳地处理大段 Hive 启动与派单注入，减少过早回车或输入残留。',
    ],
  },
  {
    version: '2.1.1',
    date: '2026-06-14',
    en: [
      'Codex terminal input is smoother and more reliable when prompts are pasted or injected for an agent.',
      'Action Center layout and interaction details are cleaner on narrow and mobile-sized screens.',
    ],
    zh: [
      'Codex 终端在粘贴或注入 prompt 时输入更顺、更可靠。',
      '活动中心在窄屏和手机尺寸下的布局与交互细节更干净。',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-06-13',
    en: [
      'One-click scenario team assembly — spin up a ready-made team from a preset instead of adding members one by one.',
      'Team memory "Dream" consolidation now runs through your Orchestrator where you can see and review it, instead of a hidden background pass. Workers can be asked to review proposed changes, but only the Orchestrator commits them — and every run can be reverted in one step.',
      'Action Center adds a one-click copyable team recap and a diagnostics bundle, so sharing status and getting support is faster.',
      'Dispatch pulse: a team send now visibly flows from the Orchestrator to the worker, so you can watch work being handed off.',
      'The add-workspace dialog now guides you to install any missing CLI before you start.',
      'More reliable dispatching: queued tasks replay when a worker starts, delivery failures notify the issuer instead of being lost, and team list shows open dispatches.',
      'Remote/mobile fixes: large uploads over the tunnel no longer fail, and terminal scrolling is restored for CLIs launched through wrapper or legacy commands (such as Codex on Windows).',
      'Hardened prompts and workflow runtime against prompt-injection, with clearer protocol errors and onboarding.',
    ],
    zh: [
      '一键场景组队：从预设模板直接拉起一支现成团队，不用逐个添加成员。',
      '团队记忆 Dream 整理改为经由 Orchestrator 执行，你能看到也能复核，不再后台静默处理。可让 worker 协助评审建议，但只有 Orchestrator 能提交，且每次整理都可一键回滚。',
      '活动中心新增一键复制团队战报与诊断信息包，分享状态、寻求支持更快。',
      '派单脉冲：team send 现在会从蜂后可视化地流向工蜂，派单交接一目了然。',
      '添加 workspace 时，若缺少对应 CLI 会引导你先安装。',
      '派单更可靠：worker 启动时重放排队任务、投递失败会通知发起方而不再丢失、team list 会列出未完成派单。',
      '远程/移动端修复：隧道大文件上传不再失败；经包装或旧版命令启动的 CLI（如 Windows 上的 Codex）终端滚动已恢复。',
      '强化了提示词与 workflow 运行时对提示注入的防护，协议报错与新手引导更清晰。',
    ],
  },
  {
    version: '2.0.2',
    date: '2026-06-10',
    en: [
      'Windows Codex terminals now keep the Codex-specific wheel scrolling behavior even when an older saved launch command points through node.exe and @openai/codex/bin/codex.js.',
    ],
    zh: [
      'Windows 上的 Codex 终端滚轮修复：即使旧配置还通过 node.exe 和 @openai/codex/bin/codex.js 启动，Hive 也会继续使用 Codex 专用的滚轮翻页行为。',
    ],
  },
  {
    version: '2.0.1',
    date: '2026-06-09',
    en: [
      'Team memory is now available: Hive can keep useful workspace context and bring back prior decisions, constraints, and project notes when your team needs them.',
      'The Memory and Workflows drawers have cleaner desktop and mobile layouts, clearer tabs, and a search field that stays out of the way on wide screens.',
      'Worker cards are easier to scan, with clearer status styling, higher contrast, cleaner role text, and in-place rename instead of a separate edit dialog.',
      'Pending dispatch status is clearer while the Orchestrator is coordinating queued or waiting worker activity.',
      'The current remote/mobile build is now published under the original official @tt-a1i/hive package name.',
    ],
    zh: [
      '团队记忆上线：Hive 可以保留有用的 workspace 上下文，并在团队需要时重新带回之前的决策、约束和项目笔记。',
      'Memory 和 Workflows 抽屉做了桌面端与移动端布局优化，tab 更清楚，宽屏上的搜索框也更不挡内容。',
      'Worker 卡片更容易扫读：状态样式更清晰、对比度更高、角色文字更干净，并改成卡片内直接重命名。',
      'Orchestrator 协调排队或等待中的 worker 活动时，pending dispatch 状态显示更明确。',
      '当前远程访问和移动端构建已通过原来的官方 @tt-a1i/hive 包名发布。',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-06-07',
    en: [
      'Remote access is here, off by default: open your running Hive from a phone browser over an end-to-end encrypted tunnel, with the same authority as your local desktop browser.',
      'The new gateway handles identity and routing only. It supports GitHub/Google sign-in, version-pinned mobile bundles, and self-hosting; your agents, terminals, workspaces, and project data stay on your computer.',
      'Pairing is desktop-confirmed: create a short-lived pairing code on the computer, enter it on the phone, compare the 6-digit SAS code on both screens, then confirm on the desktop before the device is trusted.',
      'Manage paired devices from Settings or the CLI: list devices, revoke one, drop a live remote session, and review the audit trail for remote requests and denials.',
      'New CLI commands: hive remote login / status / logout / devices / revoke link the machine to a gateway account and manage trusted devices from the host.',
      'The phone UI is the same Hive reflowed for a small screen: sign-in and machine selection, bottom navigation, workspace switching, full-screen Team / Tasks panels, reconnect banners, and update prompts.',
      'Mobile terminals are writable directly in xterm. Worker terminals open full-screen, focus mode hides surrounding chrome while you work, and touch scrolling is smoother for shell output and faster in full-screen TUI agents.',
      'Local-first behavior stays intact: Hive still works on 127.0.0.1 without any gateway, the tunnel is limited to Hive /api/* and /ws/*, and phones cannot approve new devices or turn Remote access back on.',
    ],
    zh: [
      '远程访问上线，默认关闭：用手机浏览器通过端到端加密隧道打开正在本机运行的 Hive，权限与本地桌面浏览器等同。',
      '新网关只做身份和路由：支持 GitHub / Google 登录、按版本固定的手机端 bundle、以及 self-host；Agent、终端、Workspace 和项目数据都留在你的电脑上。',
      '配对必须由桌面确认：电脑生成短时配对码，手机输入后，两边显示同一个 6 位 SAS 短码；只有在电脑上确认后，新设备才会被信任。',
      '可以在 Settings 或 CLI 里管理已配对设备：查看列表、吊销设备、立即断开正在连接的远程会话，并查看远程请求和拒绝记录的审计流水。',
      '新增 CLI：hive remote login / status / logout / devices / revoke，可在本机完成网关联动和受信设备管理。',
      '手机 UI 是同一个 Hive 的小屏重排：登录与机器选择、底部导航、Workspace 切换、全屏 Team / Tasks 面板、重连提示和更新提示。',
      '移动端终端可以直接在 xterm 里输入。成员终端全屏打开，focus mode 会隐藏周边 chrome；shell 输出滚动更顺，全屏 TUI agent 里的触摸滚动也更跟手。',
      '本地优先不变：没有网关时 Hive 仍照常运行在 127.0.0.1；隧道只允许访问 Hive 自己的 /api/* 和 /ws/*；手机不能批准新设备，也不能在关闭远程后自行重新开启。',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-06-05',
    en: [
      'Hermes is now a built-in CLI agent preset alongside Claude Code, Codex, OpenCode, and Gemini — usable as Orchestrator or Worker, via team spawn --cli hermes, and in workflows.',
      'Hermes sessions survive crashes: Hive captures the session id from the CLI startup output and resumes with --resume on restart.',
      'Existing installs get the new preset automatically — just have hermes on your PATH.',
    ],
    zh: [
      'Hermes 成为第五个内置 CLI agent preset，与 Claude Code、Codex、OpenCode、Gemini 并列 —— 可当 Orchestrator 或 Worker，支持 team spawn --cli hermes 和 workflow。',
      'Hermes 会话可在崩溃后恢复：Hive 从 CLI 启动输出捕获 session id，重启时用 --resume 续上。',
      '已有安装会自动获得新 preset —— 只要 PATH 里有 hermes 即可。',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-06-02',
    en: [
      'A Stop button on the running Orchestrator lets you halt a runaway agent straight from the UI.',
      'Worker cards now show queue depth and the latest activity line, and the working badge explains that Hive does not auto-detect stalls — check the terminal.',
      'Worker reports are no longer lost when the Orchestrator is down or restarting; they are queued and redelivered automatically.',
      'Deliberately stopping and restarting the Orchestrator no longer replays a stale crash-recovery handover.',
      'A new completion webhook can POST to a URL you choose (Slack, ntfy, Feishu, …) when a worker reports or a workflow finishes.',
      'Workflow agent() gains opt-in structured output via outputSchema, and the new team next lists tasks unblocked by [needs:] dependencies in tasks.md.',
    ],
    zh: [
      '运行中的 Orchestrator 面板新增 Stop 按钮，可以直接在 UI 里停掉跑飞的 agent。',
      'Worker 卡片现在显示队列数和最近活动行；working 状态会说明 Hive 不会自动检测卡死 —— 以终端为准。',
      'Orchestrator 掉线或重启时，Worker 的汇报不再丢失，会自动排队并补投。',
      '手动停止后再重启 Orchestrator，不会再灌入陈旧的崩溃恢复接管。',
      '新增完成通知 Webhook：Worker 汇报或 Workflow 完成时，向你设置的 URL POST（可接 Slack、ntfy、飞书等）。',
      'Workflow 的 agent() 支持 outputSchema 结构化输出；新增 team next 可列出 tasks.md 里被 [needs:] 解除阻塞、当前可做的任务。',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-05-31',
    en: [
      'Experimental Workflows let the Orchestrator run multi-agent plans across real Hive workers, with run details, logs, stop controls, and schedules in the Workflows drawer.',
      'Workflow-created agents can now follow your selected default CLI and allowed CLI policy instead of always falling back to Claude Code.',
      'Experimental auto-staff can let the Orchestrator size the worker roster to the task and create task-scoped coders, testers, or reviewers.',
      'Codex dispatches stay reliable for long pasted tasks, while short worker reports now submit quickly instead of waiting several seconds in the input box.',
      'Runtime hardening covers malformed WebSocket frames, Windows Codex startup paths, and workflow worker cleanup edge cases.',
    ],
    zh: [
      '实验性的 Workflows 可以让 Orchestrator 用真实 Hive Worker 执行多 Agent 计划，并在 Workflows 抽屉里查看详情、日志、停止控制和定时任务。',
      'Workflow 创建的 Agent 现在会遵守你选择的默认 CLI 和允许列表，不再总是回退到 Claude Code。',
      '实验性的自动组队可以让 Orchestrator 按任务规模创建临时 coder、tester 或 reviewer。',
      'Codex 的长任务粘贴仍保持可靠；短的 Worker 汇报现在会快速提交，不再在输入框里等好几秒。',
      '运行时加固覆盖了异常 WebSocket 帧、Windows Codex 启动路径和 Workflow Worker 清理等边界情况。',
    ],
  },
  {
    version: '1.4.4',
    date: '2026-05-30',
    en: [
      'Windows .cmd and .bat startup commands now launch reliably, including quoted nvm4w and Program Files paths.',
      'Worker shutdown is more robust on Windows, with process-tree cleanup before PTY termination.',
      'Folder picking, filesystem browsing, editor launch, hive update, and port recovery are friendlier on Windows.',
      'Task files keep CRLF line endings, and the watcher handles atomic-save editors more gracefully.',
    ],
    zh: [
      'Windows 上的 .cmd / .bat 启动命令更可靠，包括带引号的 nvm4w 和 Program Files 路径。',
      'Windows 下 Worker 关闭更稳，会先清理进程树再终止 PTY。',
      '文件夹选择、文件浏览、编辑器打开、hive update 和端口占用恢复在 Windows 上更顺手。',
      '任务文件会保留 CRLF 换行，watcher 对原子保存编辑器也更宽容。',
    ],
  },
]

const parseVersion = (version: string) => {
  const [core = '', prerelease = ''] = version.split('-', 2)
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  return { core: [major, minor, patch] as const, prerelease }
}

/** Semver-ish compare: <0 if left<right, 0 if equal, >0 if left>right. */
export const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (delta !== 0) return delta
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

export interface WhatsNewSelection {
  /** Show the dialog with `entries`. */
  show: boolean
  /** Entries in the (lastSeen, current] range, newest first. */
  entries: ChangelogEntry[]
  /**
   * Persist `current` as last-seen WITHOUT showing anything. True for a fresh
   * install (no baseline) or an update with no curated notes in range. Never
   * true when there are entries to show — those persist only on dialog close,
   * so deferring for the first-run wizard can't swallow an upgrade popup.
   */
  seedOnly: boolean
}

/**
 * Decide whether to surface "What's New", given the running version and the
 * last version the user has already seen (null = never recorded).
 */
export const selectWhatsNew = (
  current: string,
  lastSeen: string | null,
  changelog: ChangelogEntry[] = CHANGELOG
): WhatsNewSelection => {
  // Fresh install / first run with this feature: no baseline to diff against.
  // Onboarding belongs to the first-run wizard, not here.
  if (lastSeen === null) return { show: false, entries: [], seedOnly: true }
  // Same version or a downgrade: nothing new; leave last-seen untouched.
  if (compareVersions(current, lastSeen) <= 0) return { show: false, entries: [], seedOnly: false }
  const entries = changelog.filter(
    (entry) =>
      compareVersions(entry.version, lastSeen) > 0 && compareVersions(entry.version, current) <= 0
  )
  // Updated, but no curated notes for this span — don't show an empty dialog.
  if (entries.length === 0) return { show: false, entries: [], seedOnly: true }
  return { show: true, entries, seedOnly: false }
}
