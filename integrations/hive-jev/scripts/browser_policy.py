"""Pure safety and acceptance policy for the executable browser runner."""

from __future__ import annotations

import os
from urllib.parse import unquote, urlparse


SENSITIVE_COMMON_TERMS = (
    "authorize", "checkout", "delete", "download", "install", "login", "password",
    "publish", "purchase", "register", "transfer", "upload", "付款", "付费", "下单",
    "删除", "发布", "注册", "登录", "密码", "授权", "上传", "购买", "预订",
)

SENSITIVE_TERMS = SENSITIVE_COMMON_TERMS + (
    "account", "add extension", "appointment", "attach", "book", "buy", "choose file",
    "confirm", "enable", "export", "go live", "log in", "order", "pay", "post", "remove",
    "reserve", "save", "schedule", "send", "sign in", "sign up", "submit", "传送",
    "保存", "启用", "安装扩展", "导出", "确认", "提交", "添加附件", "立即发布", "预约",
)

SENSITIVE_FLOW_TERMS = SENSITIVE_COMMON_TERMS + (
    "billing", "booking", "consent", "log-in", "oauth", "payment", "remove", "reservation",
    "setup", "sign-in", "sign-up", "signin", "signup",
)

SENSITIVE_FIELD_TERMS = (
    "account number", "amount", "card", "content", "cvc", "cvv", "destination", "email",
    "date", "e-mail", "expiry", "guest", "iban", "name", "phone", "recipient",
    "routing number", "time",
    "security code", "title", "username", "银行卡", "卡号", "姓名", "手机号", "收款人",
    "账户", "转账金额", "邮箱", "金额", "验证码",
)

FLOW_PROGRESS_TERMS = (
    "add extension", "book", "confirm", "continue", "create", "export", "go live", "next",
    "pay", "register", "reserve", "save", "schedule", "send", "sign", "submit",
    "subscribe", "transfer", "verify", "下一步", "继续", "创建", "发送", "注册",
    "保存", "安装扩展", "导出", "确认", "提交", "支付", "订阅", "立即发布", "验证", "预订",
)

AMBIGUOUS_WIZARD_TERMS = (
    "complete", "continue", "finish", "next", "proceed", "完成", "继续", "下一步",
)


def origin(url: str) -> str:
    parsed = urlparse(url)
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def action_policy(action: dict) -> tuple[bool, str]:
    text = " ".join(str(action.get(key, "")) for key in ("label", "role", "kind", "type")).lower()
    if action.get("type") in {"password", "file"} or action.get("role") == "password":
        return False, "credential_or_upload"
    if any(term in text for term in SENSITIVE_TERMS):
        return False, "sensitive_browser_action"
    return action.get("kind") in {"click", "fill", "select", "scroll", "wait"}, "low_risk_browser_action"


def page_policy(page: dict) -> tuple[bool, str]:
    parsed = urlparse(page.get("url", ""))
    context = unquote(" ".join((parsed.path, parsed.query, page.get("title", "")))).casefold()
    if any(term in context for term in SENSITIVE_FLOW_TERMS):
        return False, "sensitive_browser_flow"
    actions = page.get("actions", [])
    for action in actions:
        if action.get("type") in {"password", "file"} or action.get("role") == "password":
            return False, "credential_or_upload_flow"
    field_labels = " ".join(
        str(action.get("label", ""))
        for action in actions
        if action.get("kind") in {"fill", "select"}
    ).casefold()
    progress_labels = " ".join(
        str(action.get("label", ""))
        for action in actions
        if action.get("kind") in {"click", "select"}
    ).casefold()
    has_sensitive_field = any(term in field_labels for term in SENSITIVE_FIELD_TERMS)
    has_progress_control = any(term in progress_labels for term in FLOW_PROGRESS_TERMS)
    has_sensitive_control = any(term in progress_labels for term in SENSITIVE_TERMS)
    if has_sensitive_control:
        return False, "sensitive_browser_flow"
    if has_sensitive_field and has_progress_control:
        return False, "sensitive_form_flow"

    visible_text = str(page.get("text", ""))[:1500].casefold()
    has_sensitive_heading = any(term in visible_text for term in SENSITIVE_FLOW_TERMS)
    if has_sensitive_heading and len(actions) <= 20:
        return False, "sensitive_form_flow"
    has_ambiguous_progress = any(term in progress_labels for term in AMBIGUOUS_WIZARD_TERMS)
    if has_ambiguous_progress and len(actions) <= 20:
        return False, "sensitive_form_flow"
    return True, "low_risk_browser_flow"


def contains(value: str, expected: str | None) -> bool:
    return expected is None or expected.casefold() in value.casefold()


def confirmation_result(reason: str, actions: list, **details) -> dict:
    return {
        "accepted": False,
        "status": "needs_confirmation",
        "reason": reason,
        **details,
        "actions": actions,
    }


def final_result(page: dict, run_status: str, actions: list, payload: dict, max_actions: int) -> dict:
    allowed_origins = set(payload["allowed_origins"])
    final_origin = origin(page["url"])
    if final_origin not in allowed_origins:
        return confirmation_result(
            "origin_not_allowed", actions, pending_origin=final_origin
        )
    page_allowed, page_reason = page_policy(page)
    if not page_allowed:
        return confirmation_result(
            page_reason,
            actions,
            pending_url=page["url"],
            pending_title=page["title"],
        )
    checks = {
        "url": contains(page["url"], payload.get("expect_url_contains")),
        "title": contains(page["title"], payload.get("expect_title_contains")),
        "text": contains(page["text"], payload.get("expect_text_contains")),
    }
    accepted = run_status == "done" and all(checks.values())
    if accepted:
        status = "done"
    elif len(actions) >= max_actions and run_status not in {"done", "blocked"}:
        status = "action_budget_exhausted"
    elif run_status == "done":
        status = "outcome_not_verified"
    else:
        status = run_status
    return {
        "accepted": accepted,
        "status": status,
        "final_url": page["url"],
        "final_title": page["title"],
        "expectations": checks,
        "actions": actions,
        "text_model": os.environ.get("TEXT_MODEL", "deepseek-flash"),
    }
