"""Pure policy tests for the executable browser runner."""

import importlib.util
import pathlib
import unittest


POLICY = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "browser_policy.py"
SPEC = importlib.util.spec_from_file_location("hive_jev_browser_policy", POLICY)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrowserPolicyTest(unittest.TestCase):
    def test_allows_search(self):
        self.assertEqual(MODULE.action_policy({"kind": "click", "label": "Search"}), (True, "low_risk_browser_action"))

    def test_blocks_sensitive_click(self):
        self.assertEqual(MODULE.action_policy({"kind": "click", "label": "Delete account"}), (False, "sensitive_browser_action"))

    def test_blocks_password_and_upload(self):
        self.assertEqual(MODULE.action_policy({"kind": "fill", "role": "password"}), (False, "credential_or_upload"))
        self.assertEqual(MODULE.action_policy({"kind": "fill", "type": "file"}), (False, "credential_or_upload"))

    def test_blocks_sensitive_flow_before_a_neutral_action(self):
        page = {
            "url": "https://example.com/login",
            "title": "Welcome",
            "actions": [{"kind": "fill", "label": "Email"}],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_browser_flow"))

    def test_blocks_page_with_a_password_field_before_any_action(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "actions": [{"kind": "fill", "label": "Secret", "type": "password"}],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "credential_or_upload_flow"))

    def test_blocks_neutral_login_form_before_email_fill(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Access your workspace",
            "actions": [
                {"kind": "fill", "label": "Email"},
                {"kind": "click", "label": "Continue"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_form_flow"))

    def test_blocks_neutral_payment_form_before_card_fill(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Complete the details",
            "actions": [
                {"kind": "fill", "label": "Card number"},
                {"kind": "click", "label": "Next"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_form_flow"))

    def test_blocks_neutral_registration_form_before_name_fill(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Tell us about yourself",
            "actions": [
                {"kind": "fill", "label": "Full name"},
                {"kind": "click", "label": "Create profile"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_form_flow"))

    def test_blocks_neutral_booking_form_before_guest_fill(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Choose the details",
            "actions": [
                {"kind": "select", "label": "Guests"},
                {"kind": "click", "label": "Continue"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_form_flow"))

    def test_blocks_neutral_transfer_form_before_recipient_fill(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Enter the details",
            "actions": [
                {"kind": "fill", "label": "Recipient"},
                {"kind": "fill", "label": "Amount"},
                {"kind": "click", "label": "Continue"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_form_flow"))

    def test_blocks_neutral_sensitive_controls_before_execution(self):
        for purpose, label in {
            "install": "Add extension",
            "download": "Export",
            "publish": "Go live",
            "delete": "Remove item",
        }.items():
            with self.subTest(purpose=purpose, label=label):
                page = {
                    "url": "https://example.com/session",
                    "title": "Welcome",
                    "text": "Choose an option",
                    "actions": [{"kind": "click", "label": label}],
                }
                self.assertEqual(MODULE.page_policy(page), (False, "sensitive_browser_flow"))

    def test_blocks_neutral_booking_form_with_schedule_control(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Choose a slot",
            "actions": [
                {"kind": "fill", "label": "Date"},
                {"kind": "fill", "label": "Time"},
                {"kind": "click", "label": "Schedule"},
            ],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "sensitive_browser_flow"))

    def test_blocks_neutral_upload_page_before_file_selection(self):
        page = {
            "url": "https://example.com/session",
            "title": "Welcome",
            "text": "Choose an item",
            "actions": [{"kind": "fill", "label": "Attachment", "type": "file"}],
        }
        self.assertEqual(MODULE.page_policy(page), (False, "credential_or_upload_flow"))

    def test_final_result_rejects_an_unexpected_origin(self):
        page = {
            "url": "https://evil.example/OpenAI",
            "title": "OpenAI",
            "text": "OpenAI",
            "actions": [],
        }
        payload = {
            "allowed_origins": ["https://safe.example"],
            "expect_url_contains": "OpenAI",
        }
        result = MODULE.final_result(page, "done", [], payload, 12)
        self.assertFalse(result["accepted"])
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["reason"], "origin_not_allowed")

    def test_final_result_requires_independent_expectation(self):
        page = {
            "url": "https://safe.example/result",
            "title": "Wrong article",
            "text": "Nothing relevant",
            "actions": [],
        }
        payload = {
            "allowed_origins": ["https://safe.example"],
            "expect_title_contains": "OpenAI",
        }
        result = MODULE.final_result(page, "done", [], payload, 12)
        self.assertFalse(result["accepted"])
        self.assertEqual(result["status"], "outcome_not_verified")


if __name__ == "__main__":
    unittest.main()
