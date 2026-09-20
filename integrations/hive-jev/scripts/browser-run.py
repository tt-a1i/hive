"""Execute a bounded Jev Ultrafast browser task in one owned Chrome tab."""

from __future__ import annotations

import json
import os
import sys

from browser_policy import action_policy, confirmation_result, final_result, origin, page_policy


repo_path = os.environ.get("HIVE_JEV_ULTRAFAST_PATH")
if repo_path:
    sys.path.insert(0, repo_path)

from jev_ultrafast import Agent  # noqa: E402
from jev_ultrafast.browser import StalePage  # noqa: E402


def main() -> int:
    if os.environ.get("HIVE_JEV_BROWSER_EXECUTION") != "1":
        raise RuntimeError("Browser execution was not explicitly enabled.")
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise RuntimeError("TYPESAFE_API_KEY is required; no browser action was executed.")

    payload = json.load(sys.stdin)
    allowed_origins = set(payload["allowed_origins"])
    max_actions = max(1, min(int(payload.get("max_actions", 12)), 12))
    actions = []

    start_origin = origin(payload["url"])
    if start_origin not in allowed_origins:
        json.dump(
            confirmation_result(
                "origin_not_allowed", actions, pending_origin=start_origin
            ),
            sys.stdout,
            ensure_ascii=True,
        )
        return 0

    with Agent(payload["url"], payload["goal"], screenshots=False) as agent:
        while agent.state["status"] not in {"done", "blocked"} and len(actions) < max_actions:
            page = agent.state["page"]
            if origin(page["url"]) not in allowed_origins:
                result = confirmation_result(
                    "origin_not_allowed", actions, pending_origin=origin(page["url"])
                )
                json.dump(result, sys.stdout, ensure_ascii=True)
                return 0

            page_allowed, page_reason = page_policy(page)
            if not page_allowed:
                json.dump(
                    confirmation_result(
                        page_reason,
                        actions,
                        pending_url=page["url"],
                        pending_title=page["title"],
                    ),
                    sys.stdout,
                    ensure_ascii=True,
                )
                return 0

            try:
                predicted = agent.command("predict")
                decision = predicted["decision"]
                predicted_page = predicted["page"]
                if decision["choice"] in {"DONE", "BLOCKED"}:
                    agent.command("act", {"fingerprint": predicted_page["fingerprint"]})
                    continue

                action = next(item for item in predicted_page["actions"] if item["id"] == decision["choice"])
                allowed, reason = action_policy(action)
                if not allowed:
                    result = confirmation_result(
                        reason,
                        actions,
                        pending_action={
                            "kind": action.get("kind"),
                            "label": action.get("label"),
                            "url": predicted_page["url"],
                        },
                    )
                    json.dump(result, sys.stdout, ensure_ascii=True)
                    return 0

                agent.command("act", {"fingerprint": predicted_page["fingerprint"]})
            except StalePage:
                agent.state["decision"] = None
                agent.state["status"] = "ready"
                agent.state["page"] = agent.browser.observe(screenshot=False)
                continue
            actions.append({
                "kind": action.get("kind"),
                "label": action.get("label"),
                "url": agent.state["page"]["url"],
                "jev_latency_ms": decision.get("latency_ms"),
                "text_model": agent.state["history"][-1].get("text_helper"),
                "auto_approved": True,
            })

        page = agent.state["page"]
        json.dump(
            final_result(page, agent.state["status"], actions, payload, max_actions),
            sys.stdout,
            ensure_ascii=True,
        )
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1) from None
