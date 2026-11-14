# AGENTS.md — 给所有 AI 编码者的硬约束

> 先读 `./CLAUDE.md` 拿项目背景。**本文件是行为约束，违反任何一条都会在 code review 被打回。**

设计 spec：`docs/superpowers/specs/2026-04-18-hive-design.md`（700 行，单一事实来源）。**spec 与本文件冲突时以 spec 为准；spec 模糊时先问，不要臆断**。

## 0.0、真实问题三问（任何新 feature / plan 的准入闸门）

Hive 只解决真实场景里的真实问题。这条不是口号，是否决器：**任何新 feature、新命令、新提示词规则、新 store、新 UI 面板的 issue / plan / PR 描述，必须先逐条回答下面三问；答不出来的，reviewer 直接打回，不进入实现。** 修 bug、删代码、减默认义务、补度量不需要过这道闸门。

1. **具体的人在具体的时刻遇到了什么。** 写出场景，不写叙事。"用户想要多 agent 协作"是叙事；"修 #56 时补一句路径就多开一张单，worker 关单还 409"才是问题。
2. **做完之后那个时刻会变成什么样，如何被看到。** 说清可观察的前后差异（回合数、时长、步骤数、错误率、某个具体界面/命令输出）。看不到的改动不算做完。
3. **不做会怎样。** 如果答案是"也没什么"，就不做。这条否决的往往是最有意思的东西，这正是它存在的原因。

背景与判据来源：Discussion #76（"薄的蜂巢"方向）、Issue #75（协作开销与度量）。多 agent 只在两种情况有净收益——互不冲突的并行分支（wall-clock）、独立于实现者的审查/验证（质量）；其余每多一跳都是纯成本。新增协作能力时默认用这两条校验。

## 0、当前工作重点

优先保障桌面端「薄的蜂巢」核心体验与稳定性。核心协议与运行时改动按 §0.1 选择真实集成测试，桌面交互改动按实际用户流程走查。

## 0.1、风险分层测试 / 发版闸门（当前长期规则）

测试的目标是挡住核心协议、数据、runtime 和发版包回归；**全量测试不再是每次开发或每次发版的默认闸门**。不要用无差别 `pnpm test` 拖慢小改、UI 调整和快速发版。

- **本地开发默认**：跑与改动相关的测试 + 必要的 `pnpm check` / `pnpm build`。改文档、文案、纯 UI 样式时可只跑静态检查或不跑测试，但交付时要说明。
- **核心链路改动必须有定向测试**：team protocol、dispatch ledger、SQLite migration、PTY 生命周期、workflow runner、remote/gateway 加密隧道、release packaging 等，必须跑对应的真集成/回归测试，不允许只靠 build。
- **UI / 布局 / 移动端体验改动**：以 `pnpm check`、`pnpm build`、浏览器/真机走查为主；不为了表面覆盖补脆弱测试。
- **发版默认 fast gate**：`pnpm check && pnpm build && pnpm pack:check && pnpm pack:smoke`，再按本次改动风险补少量核心集成测试。不要默认跑完整 `pnpm test`。
- **全量 `pnpm test` 只在这些情况要求**：大范围共享代码或协议改动、schema/migration 改动、runtime/PTY/workflow/remote 安全边界大改、发稳定大版本、nightly/CI、用户明确要求。
- **跳过全量测试必须明说**：交付/发版报告里列出实际跑过的命令、没跑全量的理由、剩余风险。不要写"应该没问题"代替验证说明。
- 慢测试可以保留，但应进入 nightly、手动 suite 或高风险闸门；不要因为慢就删掉能抓真 bug 的核心测试。

---

## 一、绝对禁止（Hard Bans）

### 1. 不许在生产代码里加"为了测试通过"的 fallback / 分支

反例（已经发生过）：
```ts
// agent-manager.ts —— 这种代码是为了让单测能用 `node` 跑而存在
if (command === 'node') { 走 child_process }
else { try PTY catch fallback child_process }
```

测试隔离用 `vi.mock('node-pty')`，不要让测试便利性渗进生产代码。**生产代码只走真实路径**。

### 2. 不许用 try/catch 字符串匹配吞异常

反例：`if (error.message.includes('readonly database')) return`。这是在掩盖测试清理顺序错乱等根因。**修根因，不写 catch**。

### 3. 不许写"循环验证"测试

反例：
```ts
const fetchMock = vi.stubGlobal('fetch', ...)
expect(fetchMock).toHaveBeenNthCalledWith(...)  // 你在断言自己的 mock 怎么被你自己调用
```

这不是测试，是"绿色幻觉"。**前后端 / CLI↔server 契约必须有真集成测试穿透**。

### 4. 不许写空断言或源码字符串断言

- `expect(true).toBe(true)` —— 删
- `expect(readFileSync(x)).toContain("import ...")` —— 删，这是"架构警察伪装成单测"
- "没抛异常就算通过" —— 不是验证

### 5. 不许部分完成 review 反馈

如果 review 给了 N 条，**逐条 verdict**：完成 / 部分 / 跳过 + 证据 / 跳过原因。
**不许**："我修了一些，还有一些下次"。**不许**"挑容易的修，难的装作没看见"。

### 6. 不许用 `Math.random().toString(36)` 生成 ID

百万级会撞。统一用 `crypto.randomUUID()`。

### 7. 不许内存与 DB 写入顺序倒置

错：先 `array.push(x)`，再 `db.insert(x)`，DB 失败就脱节。
对：DB 先成功，内存后改；或包 transaction。

---

## 二、必须做（Hard Requirements）

### 8. 协议层命名必须一字不差对 spec

spec §3.3 line 166 写 `pending_task_count`，就不能输出 `pendingTaskCount`。
HTTP/JSON 层用 snake_case，TS 内部可驼峰，**序列化时要转换**。

### 9. 任何新功能必须有真集成测试穿透（纯 UI 功能除外，见 §三测试范围）

最小标准：起真 HTTP server + 真 store（含 SQLite）+ 真 PTY（如涉及），用 `fetch` 调真端点。
**不许**整条链都是 mock。`vi.stubGlobal('fetch')` 不算集成测试。

### 10. 单文件硬上限

| 文件 | 上限 | 超了的处理 |
|---|---|---|
| `src/server/runtime-store.ts` | 200 行 | 必须拆 store |
| `web/src/app.tsx` | 150 行 | 必须拆组件 / 引入 store |
| 任何 HTTP 路由文件 | ≥ 10 端点 | 必须改 router 表，不许继续 `if + 正则` |

**不许**"再加一两个再拆"。当前超了就先拆再加新功能。

### 11. SQL schema 改动必须走 migration

- 必须有 `schema_version` 表追踪版本
- 不许多个 store 各自运行时 `ALTER TABLE`
- MVP 阶段允许 drop+recreate，但要在 `schema_version` 里记明

### 12. 状态机必须遵守 spec §3.6 三态

`idle / working / stopped` —— 任何代码路径都要能正确转移。
**特别注意**：PTY exit 的 `onExit` 必须同步更新 `AgentSummary.status = 'stopped'`，不能只改 live run。

### 13. 不要绕过 spec 的协议要求

- `team send` 按 worker name 而不是 hash id（spec §3.3 / §5）
- `messages` 表必须支持 `user_input | send | report` 三类（spec §7.1）
- `team list` 输出契约见 spec §3.3 line 162-179

不许"MVP 阶段先不管"自行降级。

---

## 三、TDD 纪律（被反复破坏，单独列）

**测试范围**：UI（`web/` 下的组件 / 布局 / 样式 / 交互）**不写测试**，以 `tsc` + `biome` + `build` + 真机走查为准。测试只覆盖**核心逻辑**：server 端 store / 协议路由 / CLI / 状态机 / 注入与恢复等。下面所有 TDD 要求只针对核心逻辑，纯 UI 改动不触发"必须补测试"。

1. 先 failing test 再实现 ✓ 你做得到
2. **但测试要测真行为，不是测自己的 mock**
3. **测试覆盖必须包含错误路径**：worker 不存在、DB 失败、PTY 启动失败、并发 stop、send 期间 agent 已 exit
4. **测试不能为了通过而修改产品代码语义**——发现要改产品代码才能让测试通过时，先停下来想：是产品代码错了，还是测试预期错了？
5. **删测试也要明确说**：哪些假测试 / 老测试被删 / 改了，列出来
6. **集成测试禁止 mock PTY**：`tests/server/*` 与 `tests/cli/*` 下**不许** `import 'mock-node-pty'`、`vi.mock('node-pty')`、或任何 stub `spawn`/`IPty` 的等价操作。集成测试必须跑真 `node-pty` + 真 HTTP + 真 SQLite。要测单纯逻辑就建 `tests/unit/` 放那里，名字不许叫 integration/hardening/e2e。凡标注"集成"/"穿透"/"hardening"但 import 了 mock 的，按假测试删——不是改名，是删。
7. **每条 assert 必须自问一遍："产品代码完全写反，这断言还能过吗？"** 过得了就是假测试，直接删。典型反例（看见即删）：
   - `expect(recorded).toHaveLength(0)` 而 `recorded` 这辈子没被 push
   - `not.toThrow()` × N 没有其他断言（"没抛就算过"）
   - `not.toContain(uuid)` 但注入模板里本来就没 UUID 字段 —— trivially 过
   - `expect(mockFn).toHaveBeenCalledWith(...)` 断言的是你自己喂进去的 mock 怎么被调用
   - 断言错误 `message` 字符串（用 error class / code 替代）
   - `expect(readFileSync(x)).toContain('import ...')` —— 架构警察伪装成单测

---

## 四、强制自评（每个里程碑交付前必做，不许跳过）

任何里程碑任务（M1 / M2 / pre-M2 修订 / refactor 阶段等）声称完成前，**必须并行派出至少 4 个子代理 review**，每个角度一份独立报告。**不许自己写 review 然后说"我觉得没问题"**——你是当事人，没有资格做自己的 reviewer。

### 4.1 派发要求

- 用你所在 CLI 工具支持的子代理 / 独立 review 机制（Claude Code 用 Agent tool；Codex / OpenCode / 其他 CLI 用各自等价的 sub-agent / spawn 机制）。**Hive PTY 例外**：如果你在任何 Hive PTY 里工作，禁止用当前 CLI 内建 subagent/workflow 替代 Hive 协议；Orchestrator 必须用 Hive 自己的 `team spawn --ephemeral` + `team send` 派 reviewer，Worker 需要复核/协作时用 `team report` 把需求报回 Orchestrator。否则 reviewer 不会出现在 Hive UI / `team list`，stop/cancel 也管不到。
- 如果工具支持选模型，**优先选当前最强的可用模型**做 reviewer（不要用更弱的模型 review 自己写的代码）
- **能并行就并行**：同时派 4 个独立 reviewer，不要串行（串行会偷偷漏掉某个维度，也会被中途结论污染）
- 4 个角度都必须派，**不许自己挑 2 个跳 2 个**
- 如果当前工具完全不支持子代理：在交付报告里**明确说明**，并把 4 份 review 改成"独立 prompt 单跑 4 次"的形式产出

### 4.2 必须的 4 个 review 角度

| 角度 | 关注点 | reviewer 要给的输出 |
|---|---|---|
| **A. 架构与可维护性** | 单文件大小是否破上限 / 模块耦合 / 路由表 / 前端组件状态膨胀 / M+1 能否在当前架构上落地 | 严重问题 + 中等问题 + 哪些之前提的已修 + A-F 评分 |
| **B. 真实 bug 与边界** | 内存/DB 一致性 / 异常吞噬 / 资源泄漏（DB close、PTY kill）/ 并发竞态（启动期 stop、onExit 重入）/ ID 碰撞 | 真 bug（带触发条件 + 文件:行号）+ 潜在 bug + hack 清单 |
| **C. 测试质量** | 循环 mock 验证 / 测试感染生产代码（fallback 只为测试存在）/ 错误路径覆盖 / 是否有真集成测试 / 假测试清单 | 测试感染证据 + 假测试列表 + 覆盖盲区 + A-F 评分 |
| **D. spec 对齐** | 协议字段命名（snake_case）/ 状态机三态 / 消息 schema / `team send` 按 name / MVP 范围有没有偷绕的 | 严重偏离 + M+1 阻塞项 + MVP 完成度百分比 |

### 4.3 每个 reviewer prompt 必须包含

1. 项目背景一句话 + 当前阶段（M1 / M2 / 修订）
2. 设计 spec 路径：`docs/superpowers/specs/2026-04-18-hive-design.md`
3. 本任务的目标和原始任务清单
4. **明确要求 reviewer**：
   - 只列问题 + 严重程度 + 文件:行号
   - 不要罗列优点
   - 必须验证"哪些之前提的问题已修了"（不只是找新问题）
   - 输出长度上限（≤ 400 字）

### 4.4 拿到 4 份 review 后必须做的事

1. **每条严重项必须明确处理**：
   - 修了 → 给出文件:行号 + 验证步骤
   - 不修 → 明确写**为什么**（spec 没要求 / 当前 MVP 范围外 / 风险可接受 + 风险描述）
   - **不许**："下次再处理" / 装作没看见 / "已知问题"
2. **不许只挑容易的修**——如果 4 个 reviewer 一致指出某条但你跳了，必须有 explicit 理由
3. **reviewer 结论冲突时**（A 说该拆 B 说不该拆）：交付报告里写出冲突 + 你的裁决理由
4. **任一维度评分 ≤ C+ 时不许交付**——回去修到 B- 以上再 review 一轮

### 4.5 自评报告必须包含

最终交付报告里必须有 "## Self-Review" 段，包含：
1. 4 份 review 的关键摘要（问题列表，每条不超过 1 行）
2. 每条严重项的处理 verdict（修/不修/为什么）
3. 综合评分 + 一句话总结
4. 如果做了第 2 轮 review，附上"前后对比"

少任何一条都不算完成。**不许声称"代码质量 OK 就不用 review"**——质量好不好不是你说了算。

---

## 五、"完成"的定义

任何任务交付前必须满足全部条件：

1. 按 §0.1 给出风险匹配的验证清单并通过：默认是相关测试 + 必要的 `pnpm check` / `pnpm build`；只有 §0.1 指定的高风险情况才要求完整 `pnpm test`
2. 至少 1 条**真集成测试**穿透了新功能（不是 mock 链；纯 UI 功能除外，见 §三测试范围）
3. 对照原始任务清单**逐条 verdict**：完成 / 部分 / 跳过 + 证据
4. 列出**自己改 / 删 / 跳过**的现有代码或测试 + 原因
5. 列出"知道有但没做"的事项（不许悄悄漏掉）
6. 文件大小没超 §10 的上限（超了就先拆）
7. **完成 §4 强制自评**，所有维度评分 ≥ B-

少任何一条都不算完成，**不许"基本完成"这种说法**。

---

## 六、做事方式

- **遇到 spec 模糊先问**，不要自己脑补然后写错协议导致大返工
- **修复阶段优先于 feature 阶段**——code review 反馈没消化完不许推新 feature
- **每次开工先 grep 一下有没有违反本文件的存量代码**，先修再加
- **测试别每次跑全量**：迭代 / 改单点时只跑相关测试（`pnpm exec vitest run <file>`）+ 必要的 `pnpm check` / `pnpm build`，秒级反馈就够。全量 `pnpm test` 留给 §0.1 指定的高风险闸口；小改和快速发版反复全量是浪费时间。
- **不许"我下次注意"**——下次也是你，约束写在这里就是为了不依赖记忆

---

## 七、参考资料优先级

1. 本文件（行为约束）
2. `docs/superpowers/specs/2026-04-18-hive-design.md`（设计 spec）
3. `./CLAUDE.md`（项目背景）
4. 已通过 review 的现有代码

冲突时按以上优先级裁决。

## 八、第一性原理与懒惰高级工程师纪律

懒惰是高效，不是马虎。最好的代码是不用写的代码。找问题时先从第一性原理追真实链路和根因，不许用表面现象、固定等待、局部兜底或只修 ticket 命中的单一路径糊弄过去。

写代码前，先理解任务和相关代码，端到端 trace 真实流程，然后按下面梯子停在第一个能站住的层级：

1. 这个东西真的需要做吗？先判断 YAGNI。
2. 代码库里是否已经有 helper、util、模式或同类实现？优先复用，不重写。
3. 标准库是否已经解决？用标准库。
4. 原生平台能力是否已经覆盖？用平台能力。
5. 已安装依赖是否已经解决？用现有依赖。
6. 能不能一行解决？能就一行。
7. 最后才写最少、能工作的代码。

Bug fix 必须修根因，不修症状。用户报告的是 symptom；动某个函数前，grep 它的所有 caller，找共享入口，尽量在共享函数修一次。一个正确的 guard 通常比每个 caller 各补一刀更小、更稳；只修 ticket 点名路径会留下 sibling caller 继续坏。

规则：

- 不新增用户没明确要求的抽象。
- 能避免就不加新依赖。
- 不写没人要求的 boilerplate。
- 删除优于新增，朴素优于 clever，文件越少越好。
- 最短可工作 diff 胜出，但前提是理解了问题；不理解时的小 diff 是第二个 bug。
- 复杂请求要反问：你真的需要 X，还是 Y 已覆盖？
- 两个标准库方案一样短时，选 edge-case-correct 的；懒惰是少代码，不是弱算法。

不能懒的地方：

- 理解问题：读完整任务，追真实流程，再选梯子层级。
- trust boundary 的输入校验。
- 防止数据丢失的错误处理。
- 安全、可访问性。
- 真实硬件/平台校准：平台从来不是理想 spec，时钟会漂、传感器会偏、移动网络会抖。
- 用户明确要求的事项。

非平凡逻辑必须留下一个最小可运行检查：一个断言式 demo/self-check 或一个小测试文件即可，少框架、少 fixture。简单一行改动不需要测试。
