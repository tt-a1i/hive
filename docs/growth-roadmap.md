# Growth & Positioning Roadmap

Working document distilled from a 2026-05-15 multi-agent evaluation
(competitive landscape / technical differentiation / onboarding audit). This is
**not marketing copy** — it is the internal call on what to sharpen, what to
avoid, and what to push to the README.

## Core diagnosis

- Technical substance is solid; positioning and surfacing are mis-matched.
- Self-description "browser-based multi-CLI-agent workbench" lands Hive in a
  segment that just had a 14.6k-star project (Vibe Kanban) sunset and Cline's
  own Kanban sit at 867. Don't lead with kanban framing.
- The actual differentiator is not surfaced anywhere: **the orchestrator is a
  real CLI agent (Claude Code / Codex / OpenCode / Gemini), not a human PM and
  not a scripted leader.** This is the hive-mind / queen-worker mental model
  from claude-flow (31k stars) materialised in real PTYs.
- Strongest visual selling point — multiple agents working in parallel — is
  invisible on the README, which uses an abstract composite hero image and no
  demo GIF.
- `team send` / `team report` + `.hive/tasks.md` + PATH-prepended `team`
  binary together form a credible "protocol for CLI agents to talk to each
  other". The README does not use the word "protocol" once.

## Competitive landscape snapshot

| Tier | Examples (stars) | Relation to Hive |
| --- | --- | --- |
| Python agent framework | AutoGen 42k, CrewAI 31k, LangGraph 12.8k | No overlap — library, not product |
| Self-driving coding agent | OpenHands 68.6k, Goose 44.7k, Aider 39k | No overlap — own LLM transport |
| CLI-agent parallel wrapper (kanban / tmux) | claude-squad 7.5k, Cline Kanban 867, Vibe Kanban 14.6k (sunset) | **Direct competition** |
| Agent self-orchestration (meta) | claude-flow 31.1k | Mental model overlap, different substrate |

Hive sits at the intersection: kanban-style multi-agent surface, but
queen-worker semantics where the queen itself is a real CLI agent.

## Differentiation candidates (evidence in repo)

1. Orchestrator is a real PTY-resident CLI agent (vs. kanban tools where the
   human is the PM). See `src/server/hive-team-guidance.ts` for the rules
   shipped to the orchestrator at boot.
2. Zero-install posture: `team` is injected via PATH prepend in each PTY env
   (`src/server/agent-run-bootstrap.ts`), never written to the user's shell;
   no Docker, no forced worktree, no global CLI.
3. Explicit `team report` protocol replaces silent activity inference and
   heartbeats. State machine is 3-state (working / idle / stopped); see spec
   §3.6.
4. Task graph is `.hive/tasks.md` — agents edit it with their own Read / Write
   tools; chokidar drives the UI; users can `git diff` it.
5. Two-layer crash recovery: Layer A piggybacks on each CLI's native session
   resume (e.g. `claude --resume <id>`); Layer B falls back to a structured
   summary handover. See spec §3.5 + `src/server/session-capture-claude.ts`.

## Positioning angles (pick one to lead with)

1. **"Browser-native claude-flow with real CLI agents."** Borrows the
   queen-worker mental model already validated at 31k stars; insists Hive's
   queen is not a script but a real `claude` / `codex` / `gemini` process.
   Trade-off: invites direct feature-by-feature comparison with claude-flow.
2. **"Zero-install multi-agent: no Docker, no worktree, no global CLI."**
   Targets the "infra is too heavy" pain point repeatedly seen on r/ChatGPT
   threads about multi-agent platforms. Trade-off: caps the ceiling at the
   "I'll try this in five minutes" audience.
3. **"`team`: a protocol for CLI agents to talk to each other."** Frames the
   `team` CLI + `.hive/tasks.md` as a standard, with Hive's UI as the
   reference implementation. Trade-off: needs an external adopter to make the
   claim land; chicken-and-egg, but the moat is the deepest.

**Recommendation:** lead with (1) for headline attention, anchor week-2 docs
in (3) for the long-term moat, and use (2) as the Quick Start framing.

## Roadmap

### Week 1 — best ROI

- [ ] Record a 30-second demo GIF / MP4 (start → workspace → orchestrator
      dispatch → worker terminal animates → tasks.md tick) to replace the
      abstract hero in `README.md`. Capability already exists since alpha.1.
- [x] Add `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml` +
      `config.yml` + `CONTRIBUTING.md`. Resolves the GitHub Community
      Standards red marks.
- [x] Add a CI build-status badge to both READMEs. The `Release` workflow
      already runs on macOS / Ubuntu / Windows on every `main` push.
- [x] Surface **Try Demo** in `README.md` — the in-app fully-client-side demo
      shipped in alpha.1 is currently invisible to anyone who hasn't booted
      Hive once.
- [x] Rewrite the first paragraph of `README.md` to put
      "orchestrator-is-a-real-CLI-agent" front and centre.

### Week 2 — positioning and protocol

- [ ] Long-form post / `docs/team-protocol.md`: "The `team` protocol: how
      CLI agents talk to each other." Document `team send` / `team report` /
      `team list` / `team status` as a stable wire format independent of the
      UI.
- [ ] `docs/design-decisions.md` (or FAQ section in README): why no worktree,
      why no heartbeat, why `team` is not globally installed, why runtime
      restart does not auto-resume agents. Each ~150 words.
- [ ] Update `package.json` `description` to match the new lead positioning
      so the npm registry tagline lines up with the README.

### Month 1 — bigger swings

- [ ] Record a Crash + Restart demo video proving Layer A actually resumes
      real sessions (kill a worker mid-dispatch, hit Restart, the agent
      continues the thought instead of re-introducing itself).
- [ ] Decide the npm package name. `@tt-a1i/hive` (user scope) reads as a
      personal toy; spec §10.3 already flags `hivectl` / `hive-cli` as
      candidates.
- [ ] Enable GitHub Discussions; wire it from `.github/ISSUE_TEMPLATE/config.yml`.

## Strategic guardrails

- **Don't** sell Hive as "another kanban for CLI agents." That segment just
  watched a 14.6k-star project sunset.
- **Don't** out-feature claude-flow or AutoGen on orchestration breadth. Their
  abstractions are deliberately wide; Hive's are deliberately thin.
- **Do** lean on the two postures that cannot be cheaply copied:
  orchestrator-as-real-CLI-agent and the `team` protocol surface.

## Round 2 audit (2026-05-15)

Second sweep ran four sub-agent evaluations — internal health (architecture
/ code / tests / security), competitive feature deep-dive, GTM calendar,
brand identity — on top of the original three-angle round above.

### Cross-cutting findings

- **HN launch window is closing.** Anthropic's native Agent Teams (Claude
  Code v2.1.139, `/goal`) hit the HN front page at 396 points two months
  ago. Show HN posts that lead with "multi-agent orchestrator" now get
  "why not Agent Teams?" as the top reply. Lead the HN title with **the
  CLIs by name + zero-install constraints** instead.
- **claude-flow renamed to ruflo, stars ~51k** (the 31k figure in the
  Round 1 snapshot above is stale). Avoid feature-for-feature comparison —
  they ship 314 MCP tools and 26 CLI commands; Hive's surface is
  deliberately thin.
- **Internal substance is OSS-ready.** Architecture B+ / code A- / tests
  B+ / security A-. No launch blockers in the code itself.
- **Brand inconsistency is the hidden debt.** Product UI runs on Twenty's
  blue (`#3358d4`) + charcoal `#171717`; favicon still uses an old indigo
  gradient (`#5e6ad2`); hero is an off-brand green-wireframe desk photo.
  Three visual universes — none reinforces "hive-mind / queen / worker".

### Per-angle verdicts

**Internal health (B+ / A-).** No god module; largest single file is
`web/src/tasks/TaskGraphDrawer.tsx` at 506 LOC. `src/server/` is zero `any`
/ zero `@ts-ignore`. Integration tests really don't mock `node-pty` (grep
zero hits). Security boundary is layered: `local-request-guard.ts` rejects
non-local Host / Origin / remoteAddress (closes DNS rebinding), WebSocket
auth via cookie, SQL fully parameterised, PTY `spawn` not via shell. Three
concrete cleanups land in the priorities table.

**Competitive deep-dive.** Hive's three independents: bidirectional `team`
protocol (claude-squad and Cline Kanban both lack agent-to-agent
communication), multi-workspace daemon model, relational SQLite message
log. Hive's five gaps vs Cline Kanban / claude-squad (sorted by pain ×
effort): no diff/checkpoint review, no worktree isolation, static three-
state card with no live summary, no auto-commit/open-PR, no
task-dependency auto-trigger. Top-three "should steal": hook-driven worker
card summary (doesn't break the 3-state machine), diff drawer wired into
`team report`, optional worktree mode (spec §12 already considers it).

**GTM (30-day calendar).** Build ammunition Day 1-7 (no HN). Day 10 (Wed)
08:30 ET, post `Show HN: Hive – browser hive-mind for Claude Code, Codex,
Gemini, OpenCode`. Day 8-21 push (blog, r/LocalLLaMA, r/ClaudeAI,
newsletter pitch to Latent Space / TLDR-AI / AINews / Bytes). Day 22-30
consolidate. Estimated first-100 source split: HN front page 40-50,
Reddit 20-25, X 10-15, newsletter pickup 8-12, Discord drops 5-10, GitHub
trending tail 5.

**Brand / visual.** Replace the 1.4 MB stock-photo hero with an on-brand
SVG (4-6h). Build one geometric hex-cluster mark and reuse it across
favicon / topbar / hero / GitHub social-preview / npm avatar (3-5h). Add
favicon.png + apple-touch-icon + og:image + twitter:card + meta description
+ GitHub social-preview (1h, biggest cheap win). Animated terminal demo
(asciinema cast, ≤500 KB SVG) for the README (3-4h). Rebrand `RoleAvatar`
from two-letter mono initials to hex + role glyph (2-3h) so every worker
card becomes a tiny brand moment.

### Updated priorities (cross-cuts the original Week 1 / 2 / Month 1)

| Rank | Action | Effort | Source | Status |
| --- | --- | --- | --- | --- |
| 1 | Record demo GIF / asciinema cast (subsumes Round 1 #1) | 3-4h | D + R1 | open |
| 2 | favicon.png + apple-touch + og:image + meta tags + GitHub social-preview | 1h | D | open |
| 3 | Replace `assets/hive-hero.png` with on-brand SVG | 4-6h | D | open |
| 4 | Build logomark + roll out across favicon / topbar / hero / social | 3-5h | D | open |
| 5 | Drop `!db` fallback across all `*-store.ts` (AGENTS.md §1) | 2-3h | A | done (10 stores) |
| 6 | Split `web/src/tasks/TaskGraphDrawer.tsx` (506 LOC, 5 inner components) | 1-2h | A | open |
| 7 | Standardise `team` CLI token transport on `x-hive-agent-token` header | 30min | A | open |
| 8 | Draft `docs/team-protocol.md` + Substack post for Day-10 HN launch | 4-6h | C + R1 | open |
| 9 | Hook-driven worker card summary (port from Cline Kanban) | 6-10h | B | open |
| 10 | `RoleAvatar` hex + role-glyph rebrand | 2-3h | D | open |
| 11 | Diff drawer + auto `git diff` on `team report` | 12-20h | B | open |
| 12 | Open GitHub Discussions (single click; pin "Roadmap & feedback") | 10min | C | open |

Rows 1-4 = launch assets (≤ 1-2 days). Rows 5-7 = internal hygiene (≤ half
a day). Row 8+ = medium-term content / feature investment.

### Strategic update

- HN title must avoid "multi-agent orchestrator" — that phrase belongs to
  Anthropic's native Agent Teams product now.
- Don't try to out-feature ruflo (51k); their surface area is the trap.
- Don't post to HN or r/programming until the demo GIF is in the README — a
  bare README gets "looks like another wrapper" as the top comment.

## Source notes

Two rounds of sub-agent evaluations ran inline on 2026-05-15 and are not
archived as standalone reports — the conclusions live here.

- Round 1 (3 agents): lead positioning, codebase highlights, onboarding
  audit.
- Round 2 (4 agents): internal health (architecture / code / tests /
  security), competitive deep-dive, GTM 30-day calendar, brand identity.

If a fresh audit is needed, the agent prompts are reproducible from the
session log.
