# Hive Jev integration

This optional MCP integration gives a Hive controller four TypeSafe Jev-assisted
capabilities without changing Hive members, their selected models, or Hive's
dispatch protocol:

- recommend one existing member and reasoning effort;
- compact a copy of old tool-call history;
- review one pending action and automatically approve only clear low-risk work;
- run a bounded browser task in an owned Chrome tab using Jev Ultrafast.

The browser module uses observed DOM targets. Jev chooses an operation and target,
DeepSeek supplies text only for an observed editable field, and CDP performs the
click, input, selection, or scroll. It never accepts selectors, coordinates,
JavaScript, shell commands, passwords, or uploads from a model.

This integration is kept outside Hive core so credentials are not inherited by
Hive member processes. It is designed and tested alongside the public npm release
`@tt-a1i/hive@2.2.1`; actual Hive dispatch remains a separate controller action.

## Install

```powershell
cd integrations/hive-jev
npm ci
npm run build
uv venv .venv --python 3.12
uv pip install --python .venv "git+https://github.com/browser-use/jev-ultrafast.git@1231850a0bf1a0c0341fe408ef1668dbbfdfac46"
```

Configure these values in the MCP process environment or a local secret manager.
Do not commit them:

```text
TYPESAFE_API_KEY=<TypeSafe Jev key>
TEXT_MODEL_API_KEY=<DeepSeek key>
TEXT_MODEL_BASE_URL=https://api.deepseek.com/v1
TEXT_MODEL=deepseek-flash
HIVE_JEV_PYTHON=<absolute path to .venv/Scripts/python.exe>
```

Start the stdio MCP server with `npm start`. Register it next to Hive's
own `hive mcp` adapter in the external controller. The controller can consult Jev,
then use Hive's normal action to dispatch work to an existing member.

The Node/MCP surface is TypeScript. The small Python runner is an explicit adapter
to the pinned `jev-ultrafast` Python runtime; it owns no credentials or Hive state.
For `hive_jev_route_task`, the controller must pass a current roster obtained from
Hive's authoritative `team list`/API result and set
`roster_source: "hive_authoritative_snapshot"`. The integration never invents or
creates a member and never dispatches the selected member itself.

## Browser execution contract

`hive_jev_browser_run` requires all of the following:

- `allow_execution: true` on the exact call;
- at least one independent expected URL, title, or visible-text outcome;
- an HTTP(S) start URL;
- an allowlist of origins, defaulting to the start origin;
- a maximum of 12 actions.

Low-risk browser operations proceed automatically after the exact tool call opts
in with `allow_execution: true`. Login, credentials, payment,
posting, publishing, deletion, upload, installation, and similar sensitive actions
stop with `needs_confirmation`. A model's `DONE` choice is never sufficient: the
declared expected outcome must also match the final observed page.

The integration controls only the Chrome tab it creates through CDP. It does not
control the operating system's global mouse or keyboard.

For non-browser actions, `hive_jev_review_action` reports `auto_approved: true`
only when the caller both opts in and allowlists that exact tool name. The Jev
review must also be clear, low-risk, and require no user confirmation. The tool
still does not execute the reviewed host action.

## Verification

```powershell
npm run check
npm run build
npm test
<HIVE_JEV_PYTHON> -m unittest test/browser_policy_test.py
```

Paid providers are replaced with local fakes in tests. A real browser smoke test
is optional and must use separately supplied local credentials.
