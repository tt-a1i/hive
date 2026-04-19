# Browser PTY Terminal Rendering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render and operate Hive agent PTYs in the browser with real WebSocket streaming, xterm.js, backpressure, and multi-tab viewing.

**Architecture:** Add a terminal WebSocket layer on top of the existing `AgentManager`/`LiveAgentRun` runtime. The backend exposes split sockets, `/ws/terminal/:runId/io` for binary stdin/stdout and `/ws/terminal/:runId/control` for JSON control messages, then grows into a `TerminalStateMirror` service keyed by `workspaceId:runId` so multiple browser tabs can watch one PTY. The frontend mounts one xterm terminal per live run, reuses a small client adapter, and sends `output_ack`/resize/input messages over the control channel.

**Tech Stack:** Node.js 22 ESM, `node-pty`, `ws`, React 19, `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/headless`, `@xterm/addon-serialize`, Vitest integration tests with real HTTP server + real SQLite + real `node-pty` + real WebSocket clients.

---

## Chunk 1: Scope And Source Alignment

### Spec 条款对齐

| Spec | Lines | Implementation point |
|---|---:|---|
| Task graph is `tasks.md`, UI live-sync is expected around agent work | `docs/superpowers/specs/2026-04-18-hive-design.md:250-267` | Terminal tab must coexist with the current tasks editor. Do not make terminal rendering depend on tasks watcher work; terminal WS is separate from tasks API. |
| Crash/exit scenarios show stopped/restart behavior | `docs/superpowers/specs/2026-04-18-hive-design.md:268-279` | Terminal control socket sends `exit` and UI degrades to stopped state when `/ws/terminal/:runId/control` cannot attach or when PTY exits. |
| Layer B explicitly excludes PTY transcript persistence | `docs/superpowers/specs/2026-04-18-hive-design.md:344-351` | `TerminalStateMirror` scrollback is in-memory runtime state only, keyed by `workspaceId:runId`. Do not persist terminal transcript to SQLite. |
| State machine source is `node-pty` onData/onExit | `docs/superpowers/specs/2026-04-18-hive-design.md:370-406` | WS output must subscribe to the same PTY output source that updates live run state; on exit, server emits terminal `exit` and keeps stopped run metadata. |
| User must inspect stuck CLI agent by opening PTY | `docs/superpowers/specs/2026-04-18-hive-design.md:408-415` | M3 terminal view is required for users to decide whether a long-running `working` agent is stuck. |
| Architecture diagram requires Browser -> tRPC + WebSocket -> Runtime | `docs/superpowers/specs/2026-04-18-hive-design.md:423-476` | Add terminal WS upgrade handling in runtime HTTP server; do not build a second process. |
| Tech stack specifies tRPC + WebSocket and xterm.js + WebGL | `docs/superpowers/specs/2026-04-18-hive-design.md:775-789` | Use `ws` server-side and xterm/WebGL frontend. Hive does not currently have tRPC; keep M3 terminal WS as explicit WS endpoints until the API layer is refactored. |
| MVP requires PTY browser rendering | `docs/superpowers/specs/2026-04-18-hive-design.md:793-814` | Terminal rendering is not optional; PR-1 must provide one visible browser terminal for one live run. |

### Current Hive touchpoints

- `src/server/agent-manager.ts:68-76` finalizes a run and invokes `onExit`; terminal WS must not introduce a second status machine.
- `src/server/agent-manager.ts:99-107` appends PTY output to `run.output`; terminal WS needs an output listener rather than polling this string.
- `src/server/agent-manager.ts:162-176` already supports stdin writes and stops; terminal WS input should call the same runtime path.
- `src/server/agent-runtime.ts:107-130` exposes `getLiveRun` and `stopAgentRun`; WS attach should resolve run existence through runtime, not bypass it.
- `web/src/app.tsx:51-70` loads workers by workspace; terminal tabs should hang off the active workspace/run selection without bloating `web/src/app.tsx` beyond the existing 150-line limit. PR-1 must split UI components before adding terminal UI.

### Reference code alignment

Use `/Users/admin/code/agent-kanban/kanban` as implementation reference, not as code to blindly paste.

| Reference | Lines | Copy/adapt decision |
|---|---:|---|
| `src/terminal/ws-server.ts` imports `ws` and `WebSocketServer` | `1-5` | Copy dependency choice and `noServer` upgrade model. Adapt endpoints to `/ws/terminal/:runId/io` and `/ws/terminal/:runId/control`. |
| Connection context separates workspace/task/client | `12-17` | Adapt to `{ runId, clientId, store/runtime }`. Workspace can be derived from run/agent metadata later; PR-1 only requires runId. |
| Flow-control constants | `75-82` | Copy exact constants for M3 PR-3: 4ms, 256B, 16KB, 100KB, low water marks. |
| `createIoOutputState` tracks websocket buffered amount and unacked bytes | `213-350` | Copy algorithm shape. Rename task to run; wire pause/resume to Hive PTY output pause abstraction introduced in PR-3. |
| Single PTY fanout listener for many viewers | `353-374` | Copy concept. In Hive PR-2, `TerminalStateMirror` and `TerminalStreamHub` own one output subscription per `workspaceId:runId` and fan out to viewers. |
| Split WebSocket servers for IO/control | `144-145`, `419-459`, `461-552` | Copy two `WebSocketServer` instances and handler split: IO carries binary stdin/stdout, control carries JSON resize/stop/output_ack/restore. |
| Upgrade handling with cookie validation | `377-417`, `389-392` | Copy `server.on('upgrade')` + noServer shape and `validateUpgradeSession` 401 rejection. Adapt auth to Hive `hive_ui_token` cookie and current loopback trust boundary. |
| IO socket writes stdin directly | `438-448` | Copy for PR-1: binary/text websocket messages become PTY stdin via `agentRuntime.writeInput`. |
| Control socket supports restore, resize, stop, output_ack, restore_complete | `461-542` | PR-1 may combine IO/control on one socket, but message schema should reserve these types to avoid rewrite in PR-2/3. |
| Close terminates WS clients and active sockets | `555-585` | Copy shutdown discipline for `hive.close()` so tests do not leave sockets open. |
| `terminal-state-mirror.ts` uses `@xterm/headless` + `@xterm/addon-serialize` | `1-7` | Copy dependencies and 10K scrollback. Adapt class name and snapshot type to Hive. |
| `TerminalStateMirror` serializes restore snapshot | `19-78` | Copy nearly as-is in PR-2, with tests around multi-viewer restoration. |
| `session-manager.ts` creates `TerminalStateMirror` on start | `313-322` and `571-580` | Adapt to Hive run start/attach flow; mirror lifecycle is keyed by `workspaceId:runId`, created per `startAgent`, and disposed on PTY exit/runtime cleanup. |
| `pty-session.ts` normalizes output chunks and exposes write/resize/stop | `25-63`, `86-130` | Use as reference for future Hive `PtyRunAdapter`; current Hive `AgentManager` uses string output and will need Buffer output events for accurate terminal data. |
| `pty-session.ts` exposes real pause/resume | `143-149` | PR-3 must call PTY `pause()` / `resume()` for backpressure; do not add a buffering-only fallback path. |
| `api-contract.ts` terminal messages | `1092-1157` | Copy protocol types concept: `resize`, `stop`, `output_ack`, `restore_complete`, `state`, `error`, `exit`, `restore`. |
| `api-validation.ts` validates terminal WS messages | `591-597` | Copy parse/validate boundary in Hive shared protocol module. |
| `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` imports xterm CSS | `1` | Copy frontend CSS import once in terminal component or app entry. |
| `agent-terminal-panel.tsx` layout mounts terminal container ref | `305-310` | Adapt layout only after extracting Hive terminal components; do not expand `web/src/app.tsx`. |
| `persistent-terminal-manager.ts` keys persistent terminal by workspace/task | `137-139` | Adapt key to `workspaceId:runId`, not worker id or agent id. |
| `persistent-terminal-manager.ts` WebGL fallback | `223-231` | Copy try/catch WebGL load and `onContextLoss` cleanup pattern. |
| `persistent-terminal-manager.ts` sends `output_ack` after terminal write | `277-307` | Copy ack-after-write completion pattern for PR-3 client backpressure. |
| Server xterm dependencies | `package.json:102-103` | Server-side mirror deps are `@xterm/addon-serialize` and `@xterm/headless`. |
| Frontend xterm dependencies | `web-ui/package.json:33-38` | Frontend deps include xterm core, fit, webgl and related addons; Hive M3 only needs xterm, fit, webgl initially. |

---

## Chunk 2: Dependencies And File Boundaries

### New npm dependencies

Add these in PR-1/PR-2/PR-3 as needed, not all in the first commit unless tests require them.

| Package | Type | PR | Why |
|---|---|---:|---|
| `ws` | runtime | PR-1 | Node's built-in WebSocket is client-side only; server upgrade support should use the same proven `ws` package as agent-kanban. |
| `@types/ws` | dev | PR-1 | TypeScript server-side WebSocket types. |
| `@xterm/xterm` | runtime | PR-1 | Browser terminal emulator replacing plain text output. |
| `@xterm/addon-fit` | runtime | PR-1 | Fit terminal to panel size and emit resize messages. |
| `@xterm/addon-webgl` | runtime | PR-1 | Hardware accelerated rendering with try/catch fallback and context-loss cleanup, matching agent-kanban `persistent-terminal-manager.ts:223-231`. |
| `@xterm/headless` | runtime | PR-2 | Server-side `TerminalStateMirror` for one PTY/many viewers. |
| `@xterm/addon-serialize` | runtime | PR-2 | Serialize headless xterm state into restore snapshots. |

Do not add `chokidar` in M3 terminal rendering. Tasks watcher is separate M4 work.

### File structure and target sizes

Keep files below AGENTS.md §10 limits and avoid adding to already-sensitive `web/src/app.tsx`.

**Backend files**
- Create `src/server/terminal-ws-server.ts` target <=280 lines: HTTP upgrade handling, cookie validation hook, split `/ws/terminal/:runId/io` and `/ws/terminal/:runId/control` dispatch, with two `WebSocketServer` instances.
- Create `src/server/terminal-protocol.ts` target <=160 lines: message types and parsing helpers for `stdin`, `resize`, `stop`, `output_ack`, `restore_complete` and server `output`, `restore`, `exit`, `error`.
- Create `src/server/terminal-stream-hub.ts` target <=220 lines: per-run viewer registry, output subscription, input fan-in, lifecycle cleanup.
- Create `src/server/terminal-flow-control.ts` target <=180 lines: copy/adapt batching and backpressure constants from agent-kanban `ws-server.ts:75-82` and algorithm from `213-350`.
- Create `src/server/terminal-state-mirror.ts` target <=120 lines: headless xterm mirror based on agent-kanban `terminal-state-mirror.ts:1-78`, keyed by `workspaceId:runId` and disposed on PTY exit/runtime cleanup.
- Modify `src/server/app.ts` target stays <=120 lines: accept optional terminal WS bridge or expose server upgrade hook without route bloat.
- Modify `src/server/agent-manager.ts` target stays reasonable: add output listener subscription API or `onData` event emitter; do not duplicate run state.
- Modify `src/server/runtime-store.ts` target watch line count; expose terminal attach/write/resize through runtime only if needed.

**Frontend files**
- Create `web/src/terminal/TerminalView.tsx` target <=180 lines: xterm mount/unmount, input, output, resize, WebGL fallback.
- Create `web/src/terminal/terminal-client.ts` target <=180 lines: WebSocket connection, protocol parsing, reconnect/close behavior.
- Create `web/src/terminal/useTerminalRun.ts` target <=160 lines: React hook for one run's terminal lifecycle.
- Create `web/src/TerminalTabs.tsx` target <=160 lines: one tab per live run, active tab state, stopped/404 fallback.
- Modify `web/src/WorkspaceDetail.tsx` target remains small: render terminal tabs next to existing worker/tasks UI.
- Modify `web/src/app.tsx` only to pass state/callbacks; if it exceeds 150 lines, split before adding terminal code.

**Tests**
- Create `tests/server/terminal-ws.test.ts` with real HTTP server + real `node-pty` + real `ws` client.
- Create `tests/server/terminal-mirror.test.ts` with real run output and headless xterm restore snapshot.
- Create `tests/server/terminal-flow-control.test.ts` with real WS clients and deterministic large-output scripts.
- Create `tests/web/terminal-view.test.tsx` for frontend component behavior; this may mock browser WebSocket only for UI rendering, but server/CLI/integration tests must remain real WS.

---

## Chunk 3: PR Split And TDD Plan

### PR-1: WS 管道 + 单路观看（最小可跑）

**Scope:** A single browser tab can connect to `/ws/terminal/:runId/io` and `/ws/terminal/:runId/control`, receive raw PTY output over IO, send stdin over IO, send JSON resize/stop over control, and receive exit over control. No mirror, no multi-viewer guarantees, no full flow-control beyond basic socket cleanup.

**Files:**
- Create: `src/server/terminal-protocol.ts`
- Create: `src/server/terminal-ws-server.ts`
- Create: `src/server/terminal-stream-hub.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/agent-manager.ts`
- Modify: `src/server/runtime-store.ts`
- Create: `web/src/terminal/terminal-client.ts`
- Create: `web/src/terminal/useTerminalRun.ts`
- Create: `web/src/terminal/TerminalView.tsx`
- Modify: `web/src/WorkspaceDetail.tsx`
- Test: `tests/server/terminal-ws.test.ts`
- Test: `tests/web/terminal-view.test.tsx`

**TDD entry tests:**
- [ ] `tests/server/terminal-ws.test.ts`: connecting to `/ws/terminal/:runId/io` for a real running Node PTY receives `ready\n` output. Run `pnpm test -- tests/server/terminal-ws.test.ts`; expected initial fail: WS endpoint missing or 404.
- [ ] `tests/server/terminal-ws.test.ts`: sending `hello\n` over IO WS writes to PTY stdin and the PTY echoes `hello`. Expected initial fail: input channel not implemented.
- [ ] `tests/server/terminal-ws.test.ts`: connecting to a missing or stopped `runId` closes with a useful error/close code and does not crash server. Expected initial fail: no terminal attach validation.
- [ ] `tests/server/terminal-ws.test.ts`: resizing over `/ws/terminal/:runId/control` sends a `resize` message and server calls PTY resize without throwing for live run. Expected initial fail: no resize protocol.
- [ ] `tests/server/terminal-ws.test.ts`: control socket receives `{ type: 'exit', code }` when the real PTY exits. Expected initial fail: exit is not forwarded to control viewers.
- [ ] `tests/web/terminal-view.test.tsx`: rendering a live run creates a terminal container and opens a WS URL containing the run id. Expected initial fail: `TerminalView` missing.

**Implementation steps:**
- [ ] Add `ws` and `@types/ws` dependencies.
- [ ] Define terminal protocol types in `src/server/terminal-protocol.ts`; mirror agent-kanban message names from `api-contract.ts:1092-1157`.
- [ ] Add `AgentManager` output subscription API that returns an unsubscribe function. Keep existing `output` string for current tests.
- [ ] Add `createTerminalWebSocketServer` with `server.on('upgrade')`, matching agent-kanban noServer pattern from `ws-server.ts:127-145` and `377-417`.
- [ ] Authenticate upgrade with `hive_ui_token` cookie. Reuse existing UI cookie validation; do not invent a second token.
- [ ] Implement split WS per run from the start: IO socket handles binary PTY chunks server->client and client text/binary -> stdin; control socket handles JSON resize/stop/output_ack/restore/exit messages.
- [ ] Add frontend `TerminalView` using `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-webgl`; wrap WebGL load in try/catch and dispose on context loss.
- [ ] Wire terminal tab into workspace detail for selected run only.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

**PR-1 done when:** one live run can be watched and typed into from browser through split IO/control sockets, with real WS integration tests passing.

### PR-2: TerminalStateMirror + 多路镜像（一 PTY 多 tab）

**Scope:** Multiple browser tabs can watch the same PTY. A late viewer gets a restore snapshot built from an in-memory server mirror with 10K scrollback. Mirrors are keyed by `workspaceId:runId`, created for each new `startAgent` run, disposed on PTY exit/runtime cleanup, and PTY output still is not persisted to SQLite.

**Files:**
- Create: `src/server/terminal-state-mirror.ts`
- Create/Modify: `src/server/terminal-stream-hub.ts`
- Modify: `src/server/terminal-protocol.ts`
- Modify: `src/server/terminal-ws-server.ts`
- Modify: `web/src/terminal/terminal-client.ts`
- Modify: `web/src/terminal/TerminalView.tsx`
- Test: `tests/server/terminal-mirror.test.ts`

**TDD entry tests:**
- [ ] `tests/server/terminal-mirror.test.ts`: a second WS client connecting after initial output receives a `restore` snapshot containing prior output. Expected initial fail: no mirror/snapshot.
- [ ] `tests/server/terminal-mirror.test.ts`: two clients connected to one run both receive future PTY output exactly once. Expected initial fail: per-client attach duplicates or second viewer unsupported.
- [ ] `tests/server/terminal-mirror.test.ts`: closing one viewer does not detach the shared PTY listener while another viewer remains. Expected initial fail: listener lifecycle wrong.
- [ ] `tests/server/terminal-mirror.test.ts`: PTY transcript is not written to SQLite recovery sources. Expected initial fail only if implementation accidentally persists transcript.

**Implementation steps:**
- [ ] Add `@xterm/headless` and `@xterm/addon-serialize` dependencies.
- [ ] Copy/adapt `TerminalStateMirror` from agent-kanban `terminal-state-mirror.ts:1-78`, keep `TERMINAL_SCROLLBACK = 10_000`.
- [ ] Add per-run `TerminalStreamState` keyed by `workspaceId:runId` with `viewers`, `detachOutputListener`, and mirror lifecycle; follow agent-kanban concepts from `ws-server.ts:48-73` and `147-210`.
- [ ] Attach PTY output once per run and fan out to viewers, following `ws-server.ts:353-374`.
- [ ] Add `restore` and `restore_complete` handshake; follow `ws-server.ts:494-511` and `538-541`.
- [ ] Frontend loads restore snapshot before replaying pending live chunks.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

**PR-2 done when:** two browser tabs can watch the same run, late attach receives scrollback, and no PTY output transcript is stored in DB.

### PR-3: 流控 + backpressure + output_ack（抗大输出洪峰）

**Scope:** Large output does not overwhelm browser, Node memory, or a slow tab. Use 4ms batching, <256B low-latency direct send, 16KB websocket buffered high-water pause, 100KB unacked output pause, and client `output_ack`.

**Files:**
- Create: `src/server/terminal-flow-control.ts`
- Modify: `src/server/terminal-stream-hub.ts`
- Modify: `src/server/terminal-ws-server.ts`
- Modify: `src/server/agent-manager.ts` or runtime adapter to expose pause/resume output if needed
- Modify: `web/src/terminal/terminal-client.ts`
- Modify: `web/src/terminal/TerminalView.tsx`
- Test: `tests/server/terminal-flow-control.test.ts`

**TDD entry tests:**
- [ ] `tests/server/terminal-flow-control.test.ts`: small output chunks under 256B are sent without waiting for the 4ms batch when idle. Expected initial fail: no low-latency path.
- [ ] `tests/server/terminal-flow-control.test.ts`: burst output is batched into fewer WS sends with a 4ms flush interval. Expected initial fail: direct send per chunk.
- [ ] `tests/server/terminal-flow-control.test.ts`: when a client stops sending `output_ack`, server marks that viewer backpressured and pauses output at 100KB unacked. Expected initial fail: no ack tracking.
- [ ] `tests/server/terminal-flow-control.test.ts`: with two viewers, one slow viewer pauses shared PTY and resume occurs only after all slow viewers catch up or disconnect. Expected initial fail: per-viewer pause not tracked.
- [ ] `tests/server/terminal-flow-control.test.ts`: websocket `bufferedAmount >= 16KB` pauses and `drain`/timer resumes below low-water mark. Expected initial fail: no socket bufferedAmount tracking.

**Implementation steps:**
- [ ] Copy constants from agent-kanban `ws-server.ts:75-82` exactly.
- [ ] Copy/adapt `createIoOutputState` from `ws-server.ts:213-350` into `src/server/terminal-flow-control.ts`.
- [ ] Add client-side ack accounting: frontend sends `{ type: 'output_ack', bytes }` after xterm write callback commits bytes.
- [ ] Add `pauseOutput(runId)` / `resumeOutput(runId)` runtime adapter that calls PTY `pause()` / `resume()` directly, matching agent-kanban `pty-session.ts:143-149`.
- [ ] Use agent-kanban `ws-server.ts:229-291` bufferedAmount + unacknowledged-bytes model as the trigger for PTY pause/resume.
- [ ] Ensure `restore_complete` gates pending output exactly as agent-kanban does at `ws-server.ts:538-541`.
- [ ] Run stress test with real PTY script writing >1MB output.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

**PR-3 done when:** a large-output PTY can be watched without unbounded memory growth, slow viewers apply backpressure, and fast viewers do not incorrectly resume a paused PTY while another viewer is still behind.

---

## Chunk 4: Decisions And Risks

All previously open questions are decided for M3 unless explicitly marked as deferred. Deferred items must name the later milestone and reason.

1. **Decided: input reverse-channel auth uses `hive_ui_token`.** `/ws/terminal/:runId/io` stdin writes and `/ws/terminal/:runId/control` messages trust the browser UI `hive_ui_token` cookie. The upgrade handler follows agent-kanban `src/terminal/ws-server.ts:389-392`: if `validateUpgradeSession(request.headers.cookie)` fails, write `HTTP/1.1 401 Unauthorized` and destroy the socket.
2. **Decided: runtime restart while viewing.** When the WS closes, the frontend terminal card marks the current run as `stopped`. On reconnect, if the same `runId` still exists, restore from the `workspaceId:runId` mirror. If the run no longer exists, keep the tab's already-rendered historical text client-side and label it `已断开，点 Restart 起新 run`; Restart creates a new runId because Hive does not auto-restart agents. The 10K server scrollback is lost when the runtime process exits; this is accepted because spec lines `344-351` forbid using PTY transcript as persisted recovery input.
3. **Decided: scrollback lifetime.** `TerminalStateMirror` is keyed by `workspaceId:runId`, created for each `startAgent`, kept while the run/mirror is in memory, and disposed on PTY exit/runtime cleanup. Stopped runs may still have a frontend tab showing already-rendered local history, but server mirror is not persisted.
4. **Decided: WebGL fallback.** Load `@xterm/addon-webgl` in try/catch and fall back to the default renderer if unavailable. On WebGL context loss, dispose the addon and continue with default rendering, matching agent-kanban `persistent-terminal-manager.ts:223-231`.
5. **Decided: split IO/control WebSockets.** Implement `/ws/terminal/:runId/io` for binary stdin/stdout and `/ws/terminal/:runId/control` for JSON resize/stop/output_ack/restore/exit. This follows agent-kanban `ws-server.ts:144-145` for two `WebSocketServer` instances, `419-459` for IO, and `461-552` for control.
6. **Decided: resize protocol.** `cols` and `rows` are required; `pixelWidth` and `pixelHeight` are optional, matching agent-kanban `api-contract.ts:1092-1098`.
7. **Decided: backpressure pause semantics.** `node-pty` supports real `pause()` / `resume()`; implement PR-3 using those APIs as shown in agent-kanban `pty-session.ts:143-149`. Trigger pause/resume with the bufferedAmount + unacknowledged-bytes model from `ws-server.ts:229-291`. Do not add a buffering-only fallback path for PR-3.
8. **Decided: viewer privacy.** Viewers in the same local UI session can restore the 10K-line in-memory mirror. MVP accepts this under spec §8 loopback + same-machine trust assumptions. Per-run "disable mirror for sensitive session" is deferred to M+1 because M3 needs multi-tab PTY visibility first.
9. **Decided: tab model.** One terminal tab maps to one run, key `workspaceId:runId`, adapting agent-kanban's `workspaceId:taskId` key from `persistent-terminal-manager.ts:137-139`. A stopped run can keep a tab showing historical client-side text and server mirror while available; a restarted agent creates a new tab/runId.
10. **Decided: dependency grouping.** Server adds `ws`, `@types/ws`, `@xterm/headless`, and `@xterm/addon-serialize` when the matching PR needs them; agent-kanban server dependencies are `@xterm/addon-serialize` and `@xterm/headless` at `package.json:102-103`. Frontend adds `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-webgl`, matching agent-kanban web deps at `web-ui/package.json:33-38`. Do not add unrelated xterm addons in M3 unless tests require them.

---

## Chunk 5: Execution Checklist

### PR-1 checklist

- [ ] Write failing real WS integration tests for output, input, missing run, and resize.
- [ ] Add `ws` and xterm core dependencies.
- [ ] Implement `terminal-protocol.ts` parser.
- [ ] Add backend upgrade handling for `/ws/terminal/:runId/io` and `/ws/terminal/:runId/control` with UI cookie validation.
- [ ] Add `AgentManager` output listener API without breaking current `run.output` behavior.
- [ ] Add frontend `TerminalView`, `terminal-client`, and `useTerminalRun`.
- [ ] Keep `web/src/app.tsx` below 150 by extracting components if needed.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

### PR-2 checklist

- [ ] Write failing mirror/multi-viewer tests.
- [ ] Add headless xterm and serialize dependencies.
- [ ] Implement `TerminalStateMirror` with 10K scrollback.
- [ ] Add restore/restore_complete handshake.
- [ ] Ensure one PTY output listener per run and many viewers.
- [ ] Confirm PTY output is not persisted into SQLite/messages.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

### PR-3 checklist

- [ ] Write failing large-output/backpressure tests.
- [ ] Implement `terminal-flow-control.ts` with exact constants.
- [ ] Add `output_ack` from frontend after xterm write completion.
- [ ] Add server unacked byte accounting and socket bufferedAmount checks.
- [ ] Add shared pause/resume semantics across many viewers.
- [ ] Run stress test with >1MB PTY output.
- [ ] Run `pnpm check && pnpm build && pnpm test`.

### Verification commands

Use targeted tests while developing each PR, then full verification before review.

```bash
pnpm test -- tests/server/terminal-ws.test.ts
pnpm test -- tests/server/terminal-mirror.test.ts
pnpm test -- tests/server/terminal-flow-control.test.ts
pnpm test -- tests/web/terminal-view.test.tsx
pnpm check && pnpm build && pnpm test
```

### Non-goals for M3 terminal rendering

- Do not implement `tasks.md` watcher here.
- Do not add role template UI here.
- Do not implement command presets beyond what terminal launch already needs.
- Do not persist PTY transcript to DB.
- Do not introduce remote auth beyond existing local UI cookie boundary unless spec changes.
