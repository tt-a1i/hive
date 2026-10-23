# Hive 测试与 CI 优化：本地候选

工作目录：`/Users/tushaokun/code/hive-test-ci`。
分支：`codex/test-ci-improvements`，基线 `dc20b09`。
用户明确要求改进测试与 CI，本轮仅调整该范围，没有修改产品源码、依赖或数据库 schema。
未提交、推送，也未操作主对话的 PR。

## 实际问题与处理

| 问题 | 修改与保留的保护 |
| --- | --- |
| nightly 39863299815 的 verify 全量测试耗时 591.24 秒，平台检查随后才启动 | 抽出 tests job；全量采用 Vitest 原生三分片，平台和扩展检查只等待验证过的构建。没有自建分片算法。 |
| 同一次 nightly 的 Windows Node 26 在 better-sqlite3 安装阶段失败，未进入测试 | 普通任务 install 使用 ignore-scripts；旧驱动互读交给独立 Node 22/Linux legacy-sqlite 必跑任务。保留真实旧驱动、FTS、迁移、反向读取和权限检查。 |
| 低风险 backend 的测试新目录也需要 dist | tests 与平台消费同一个 verify 生成的 tarball；有测试时也生成该包，未把 native=false 误作“不需要构建产物”。 |
| 旧汇总器把 selected job 意外 skipped 也当成功 | ci-result 根据 plan 逐项要求 success 或 intentional skipped，拒绝失败、取消、缺失及异常计划。普通 backend 和修改/删除 legacy 测试仍保留专用任务。 |
| 测试入口只隔离数据库，Windows 入口还绕过它 | 统一使用 run-tests；隔离 HOME、USERPROFILE、Codex/Claude/XDG 配置与数据目录，结束后清理。 |
| 两组 Codex recorder 没有记录实际原生 startup，部分断言期待已取消的恢复语义 | 从真实 stdin 保存完整 startup JSONL；包含延迟写盘、未知/缺失记录及实际 HTTP/PTY 恢复路径。缺失会话应 fresh launch，不能继续要求恢复坏 ID。 |
| 水位测试要求旧提示；shell exit 测试依赖隐含退出码 | 检查当前“先读完输入再声明水位”的指导；显式发送 exit 0，继续严格验证退出码转发。 |
| Hermes recorder 假定 Enter 单独到达 | 按完整粘贴帧解析，允许 Enter 同 chunk 到达；保留 startup → submit → dispatch → submit 顺序断言。独立单 chunk 反例修前失败、修后通过。 |
| 全仓 typecheck 被两个 unit fault-model 的不完整 manager cast 阻断 | 明确测试边界的 unknown 转换，未给生产接口加 fallback；CI 增加全仓 tsc --noEmit。 |

原来的六种 OS/Node 平台包组合及 nightly 扩展矩阵均保留。
不再在每个 OS/Node 编译旧驱动：跨驱动文件互读集中在 Node 22/Linux；
生产内置 SQLite 和 PTY 的原平台保护仍由原矩阵执行。这是执行位置调整，
不是把旧数据兼容测试删除。任务增加高于历史正常耗时的明确超时预算，避免默认等待六小时。

## 执行与证据

日志、原失败、JSON 收据和本地反例保存在 `/tmp/hive-test-ci-evidence-20261023/`。

- 全新 `pnpm install --offline --frozen-lockfile --ignore-scripts` 后 build 通过。
- `pnpm check`、`pnpm exec tsc --noEmit`、`git diff --check`、`actionlint .github/workflows/ci.yml` 通过。
- 三个真实全量分片覆盖 **403 个文件**，集合无重复、无遗漏；原生 Vitest 按路径 hash 分片，不依赖历史耗时缓存。
- 首轮全量留下 5 个失败；定位到两组 recorder/旧断言及两个环境/分块假设后，相关 **31 项**复跑通过，原失败未覆盖。
- CI 相同的 `CI_FULL=true CI_TEST_SHARD=1/3` 环境中，planner/真实 runner/汇总器 **26 项**通过。曾发现外层 shard 环境污染嵌套测试，修复与失败收据均保留。
- 按最终文件版本合并有效验证结果：**2695 passed、5 skipped**。这不是一次全绿运行；是全量加受影响文件复跑的覆盖汇总，见 `validation-summary.json`。
- 五项跳过为四项 Windows 专属检查及已转移的旧驱动互读。旧驱动独立执行 **4/4** 通过，其中三项基础 SQLite 检查与默认套件重复，不重复计数。
- 新增会话归属的三个单元回归：反序并发候选、未知记录保留但不恢复、多行名称伪字段。临时副本故意取消归属检查后 **3/3 失败**，真实源码均通过。
- 一个只解压相同 tarball、没有再次 build 的独立测试目录通过 **24 项** CLI、runtime 恢复和静态资源检查。
- `src` 与 `web/src` 共 500 个产品路径哈希保持，本轮工具执行会话均已退出。

本地三个分片观察约 260 / 218 / 204 秒。历史 591 秒来自 GitHub Linux/Node 22，
本地来自 macOS/Node 24、不同版本和缓存状态，不能计算为同条件加速比。
新 workflow 尚未推送，真实 Actions、Windows 和 Node 22 专用任务仍待运行。
本机旧驱动互读使用 Node 24；不能将其写成 Node 22 CI 已通过。

## Self-Review

本侧对话明确禁止子代理，以下是四角度自查，**没有独立四审评分**。

- A 架构：复用原生分片与构建包；没有新测试框架、分片规则表或生产抽象。旧驱动单独归属必跑任务。
- B 边界：修复非 native 测试缺构建包、外层 shard 污染嵌套测试及意外 skipped 放行；失败/缺失反例均拒绝。
- C 测试价值：不删有意义的慢测试、不增加自动重试或放宽超时；保留真实 SQLite/PTY，并用错误版本验证新断言能失败。
- D 合同：未更改产品协议、状态、权限或发布规则；六组合平台和 legacy 必跑保护保留。

本地实现及上述验证完成；独立四审与真实 CI 尚未完成，不声称已合并、已部署或整体 CI 已变绿。

## 主对话接续：2026-10-23

已将 main `b48a807` 同步进分支（合并提交 `a6fa956`）。两组 Codex recorder 和提示断言复用 main 已通过完整 CI 的版本；保留启动中丢失会话的失败清理用例，启动前丢失另由 preset 用例覆盖。产品源码与 main 无差异。

新的同仓 Actions 基线为 39900563583：plan 开始至 result 完成 1050 秒；verify 703 秒，其中全量测试步骤 662 秒；随后 Windows Node 22 job 325 秒（两次安装合计 255 秒）、Node 26 job 312 秒（安装 222 秒）。分支已把测试三分片与平台检查并行；本轮再把 Windows 两种安装策略分到独立 runner，Linux/macOS 保持原串行双策略。任务由六个增至八个，仍覆盖六个 OS/Node 组合的两种安装策略；Windows 生命周期每个 Node 只在 scriptless job 执行一次。增加两个 runner 的启动成本换取墙钟时间，不能声称减少总计算资源。

接续本地验证：`pnpm check`、`pnpm exec tsc --noEmit`、`actionlint .github/workflows/ci.yml`、`git diff --check` 通过；六个相关文件 54 passed、1 skipped（旧 SQLite 互读转独立任务）。main 已验证的四个重叠文件未再重复本地全跑，新的完整分片/平台/旧驱动由真实 Actions 验证。

本对话按 AGENTS 派出 A/B/C/D 四个独立 reviewer；其结论和最终 Actions 结果在收尾时补充。前述侧对话自查和测量保留为历史，不当作本轮独立审查与远端通过证据。

### 独立复审收尾

四方最终 A-。A/B 发现取消测试留下进程，进一步实测发现直接强杀外层会留下嵌套 runner：已改为先转发原信号，最多两秒后强杀；进程组提前为空即完成。B 在源码 SHA256 `e2efa2e2` 前缀版本实测普通子孙、真实 node-pty 及嵌套 runner，记录 PID 均消失、内外临时目录删除，SIGINT/SIGTERM 退出码 130/143。C 发现三项 CLI 显式路径及 Windows AppData 绕过 HOME：共享入口已清除/隔离，实际子进程哨兵断言通过。D 未发现平台或发布合同降级。严重项均修复，无未处理阻塞；不承诺入口遭 SIGKILL、任意独立 session 或未实测的 Windows 信号清理。

证据目录 `/tmp/hive-ci-b-review-20261023/` 保留原失败和复验；本轮额外 runner/path 41 项通过，取消实现变更后的 planner/runner 26 项通过。远端使用草稿 PR #68 验证，未经用户授权不合并。

## 第二轮：减少启动开销和分片尾部等待

第一轮最终 head `ca9ae7c` 的 Actions 39903580331：首次反馈 331 秒（基线 1050 秒），但 Windows Node 22 scriptless 的真实 EOF 检查失败，输出 done 而退出状态未到。仅对同 SHA 失败 job 手动重跑一次通过，含诊断和重跑总计 605 秒。首次各 job 墙钟之和 1663 秒，基线 1542 秒；提速不等于节约计算资源。原失败保留于 `/tmp/hive-ci-optimization-20261023/windows-failure.log`。

本轮仅改执行配置和现有测试，不改产品源码：

- 完整测试改为四个原生 Vitest 分片，workflow 分母直接取矩阵 job-total。实际 BaseSequencer 分区为 101/101/101/100 文件，并集 403、无重复；未新增自定义分片框架。
- 仅 DOM 环境加载 jest-dom matcher，纯 Node 测试不加载该依赖图。同一组 40 文件/317 项按旧、新、旧、新顺序运行，全部通过。Vitest 报告墙钟为 11.454/7.650/9.352/7.506 秒；第二对外部进程墙钟 10.595/7.820 秒。小样本重复改善成立，不能外推整个 CI 的同比。
- EOF 检查失败时记录最后实际 HTTP 响应、PID 存活探测和迭代上下文；12 次真实 PTY、4 秒截止及所有断言不变。不声明 Windows 根因已修。临时副本故意要求 exit_code=99，真实退出为 0：原 AssertionError 与上下文均保留，退出 1；副本已删除。

证据 `/tmp/hive-ci-round2/`：setup-*.json/log、native-shards.json、diagnostic-negative.log、targeted.log、dom-eof.log。相关四文件 36 项通过；修后 EOF 和明确使用 DOM matcher 的 welcome-pane 两文件 5 项通过。pnpm check、pnpm exec tsc --noEmit、actionlint、git diff --check 通过。完整执行和平台矩阵交给本轮 Actions；不在本地再次重复全量。

### Self-Review

A 架构 A-；B 边界 A-；C 测试价值 A-；D 合同 A-。A/B/C 指出原诊断调用 getLiveRun 可能遮盖原异常，已改成读取现有 HTTP 轮询快照，不新增 DB 访问，故障注入确认仍抛原错误；全部 reviewer 复核关闭。旧隔离、取消清理和平台保护保持。未处理阻塞：无。未知项：Windows 偶发 EOF 根因、四分片实际耗时与总资源成本仍需远端收据。

### 第二轮远端暴露的测试竞态

Actions 39910074360 在 e4da7b6 上完成：403 文件全部执行，其中 terminal-flow-control 的 T1 就绪断言失败；其余三个分片、八个平台、legacy 通过。首次反馈 321 秒，各任务墙钟之和 1793 秒；四个测试步骤 174/156/169/155 秒。相对上一轮331秒仅减少10秒，尽管最慢测试步骤从252秒降到174秒；Windows已成为关键路径。保留失败，不把这次写成全绿或稳定提速保证。

根因是测试只监听IO启动标记，而真实协议把连接前输出放在control restore快照。临时副本先等PTY实际输出READY_END再连viewer：旧测试稳定失败；修后同反例通过。现有helper独立收集真实restore，仅启动就绪合并快照和IO；300ms IN:tiny仍严格从实时IO断言，批处理计数不混入快照。完整流控5项通过，biome/typecheck/diff检查通过。反例副本已删除，前后日志保存在flow-race-before/after.log及flow-fixed.log。

A/B/C/D再次独立复核均A-，无阻塞；修复测试错误的通道假设，不修改产品、不延长超时、不自动重试。完整远端复测待本次提交触发。

## Windows 安装下载缓存校准

最终6a6afff完整CI 39910808114一次通过，plan到result为298秒，2695pass/5skip；八个平台和legacy通过。Windows Node26 scriptless job 219秒，其中npm安装179个依赖约116秒，安装后的真实功能检查约5秒。证据 `/tmp/hive-ci-windows-cache/baseline-node26-scriptless.log`。

本轮仅为Windows缓存npm下载目录；仍mkdtemp新prefix并执行正常/scriptless两种全新安装，不缓存node_modules、不删验收。B审查发现setup-node按镜像全局配置缓存C:\npm\cache，而pack-smoke空配置实际走用户LocalAppData目录；已改为actions/cache直接缓存~/AppData/Local/npm-cache，key含架构与锁文件哈希。A/B复核关闭路径问题，C/D核门禁保持；实际冷暖命中和收益需Actions验证，不预先声称提速。actionlint与diff检查通过。
