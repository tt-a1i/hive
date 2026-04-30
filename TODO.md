# TODO

## Member Templates

Goal: keep Orchestrator as the only special agent, and treat all other agents as team members with lightweight templates.

Planned behavior:

- Keep one special `orchestrator` role with `team send` permission.
- Keep members as non-dispatching agents that can only receive work and `team report`.
- Provide built-in member templates:
  - `Coder`: implementation and focused code changes.
  - `Reviewer` / `监工`: code review, quality checks, risks, missing tests, acceptance review.
  - `Tester`: reproduction, validation, test running, behavior/spec checks.
  - `Custom`: user-defined role prompt.
- Let users choose a template when creating a member.
- Auto-fill the role prompt from the selected template.
- Let users edit the role prompt before creation.
- Avoid adding overly narrow templates such as researcher/debugger/documenter; those are internal working modes of an agent, not Hive team roles.

Implementation notes:

- Prefer a lightweight refactor first: preserve existing worker role compatibility where possible.
- Consider separating permission identity from template identity over time:
  - `kind`: `orchestrator | member`
  - `template`: `coder | reviewer | tester | custom`
  - `rolePrompt`: editable prompt text
- Update Add Member UI, worker creation payload, role template source, startup prompt injection, and tests together.
- Ensure members still cannot run `team send`.
