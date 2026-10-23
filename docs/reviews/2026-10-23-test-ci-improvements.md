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
