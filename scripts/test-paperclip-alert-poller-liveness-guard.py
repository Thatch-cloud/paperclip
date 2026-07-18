#!/usr/bin/env python3
import importlib.util
import os
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("paperclip-alert-poller-liveness-guard.py")
spec = importlib.util.spec_from_file_location("guard", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def healthy_routine():
    return {
        "id": "routine-1",
        "projectId": "project-1",
        "title": "Prometheus Alert Poller",
        "status": "active",
        "lastTriggeredAt": "2026-07-16T12:30:00Z",
        "triggers": [
            {
                "kind": "schedule",
                "enabled": True,
                "label": "every-5-min-prometheus-poll",
                "nextRunAt": "2026-07-16T12:35:00Z",
            }
        ],
        "lastRun": {"status": "issue_created", "failureReason": None},
        "activeIssue": {
            "id": "issue-1",
            "identifier": "THA-1735",
            "status": "todo",
            "updatedAt": "2026-07-16T12:30:30Z",
        },
    }


class FakeClient:
    def __init__(self, routines, failure_issue=None):
        self._routines = routines
        self.failure_issue = failure_issue
        self.created_failure_issue = None
        self.updated_issues = []
        self.requested_paths = []

    def request(self, method, path, payload=None):
        self.requested_paths.append((method, path, payload))
        if method == "GET" and path == "/api/issues/watcher-1":
            return {"issue": {"projectId": "project-from-watcher"}}
        raise AssertionError(f"unexpected request: {method} {path}")

    def routines(self):
        return self._routines

    def find_open_failure_issue(self):
        return self.failure_issue

    def create_failure_issue(self, project_id, assignee_agent_id, comment):
        self.created_failure_issue = {
            "project_id": project_id,
            "assignee_agent_id": assignee_agent_id,
            "comment": comment,
        }
        return {"id": "failure-created", "identifier": "THA-9999"}

    def update_issue(self, issue_id, payload):
        self.updated_issues.append((issue_id, payload))
        return {"id": issue_id}


class RecordingClient:
    company_id = "company-1"

    def __init__(self, response):
        self.response = response
        self.requests = []

    def request(self, method, path, payload=None):
        self.requests.append((method, path, payload))
        return self.response


class AlertPollerLivenessGuardTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 7, 16, 12, 34, tzinfo=timezone.utc)

    def test_healthy_recent_active_routine_has_no_reasons(self):
        self.assertEqual(guard.stale_reasons(healthy_routine(), self.now), [])

    def test_missing_or_paused_schedule_is_stale(self):
        self.assertIn("target routine is missing", guard.stale_reasons(None, self.now))

        routine = healthy_routine()
        routine["status"] = "paused"
        routine["triggers"][0]["enabled"] = False

        reasons = guard.stale_reasons(routine, self.now)

        self.assertIn("target routine status is paused", reasons)
        self.assertIn("target routine has no enabled schedule trigger", reasons)

    def test_late_trigger_and_failed_run_are_stale(self):
        routine = healthy_routine()
        routine["lastTriggeredAt"] = "2026-07-16T12:10:00Z"
        routine["triggers"][0]["nextRunAt"] = "2026-07-16T12:20:00Z"
        routine["lastRun"] = {"status": "failed", "failureReason": "boom"}

        reasons = guard.stale_reasons(routine, self.now)

        self.assertTrue(any("lastTriggeredAt" in reason for reason in reasons))
        self.assertTrue(any("nextRunAt" in reason for reason in reasons))
        self.assertIn("target lastRun.status is failed", reasons)
        self.assertIn("target lastRun.failureReason is boom", reasons)

    def test_open_active_issue_is_stale_only_when_coalescing_or_skipping(self):
        routine = healthy_routine()
        routine["activeIssue"]["updatedAt"] = "2026-07-16T12:00:00Z"
        routine["lastRun"]["status"] = "coalesced"

        reasons = guard.stale_reasons(routine, self.now)

        self.assertTrue(
            any(
                "activeIssue [THA-1735](/THA/issues/THA-1735)" in reason
                for reason in reasons
            )
        )

        routine["lastRun"]["status"] = "issue_created"

        reasons = guard.stale_reasons(routine, self.now)

        self.assertFalse(any("THA-1735" in reason for reason in reasons))

    def test_missing_routine_uses_watcher_issue_project_and_creates_failure_issue(self):
        client = FakeClient([])

        with patch.dict(
            os.environ,
            {"PAPERCLIP_TASK_ID": "watcher-1", "PAPERCLIP_AGENT_ID": "agent-1"},
            clear=True,
        ):
            exit_code = guard.main(client=client, now=self.now)

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            client.requested_paths,
            [("GET", "/api/issues/watcher-1", None)],
        )
        self.assertEqual(client.created_failure_issue["project_id"], "project-from-watcher")
        self.assertEqual(client.created_failure_issue["assignee_agent_id"], "agent-1")
        self.assertEqual(
            client.updated_issues[-1][1]["status"],
            "done",
        )

    def test_existing_failure_issue_is_updated_idempotently(self):
        routine = healthy_routine()
        routine["lastRun"] = {"status": "failed", "failureReason": "boom"}
        client = FakeClient([routine], {"id": "failure-1", "identifier": "THA-9998"})

        with patch.dict(
            os.environ,
            {"PAPERCLIP_TASK_ID": "watcher-1", "PAPERCLIP_AGENT_ID": "agent-1"},
            clear=True,
        ):
            exit_code = guard.main(client=client, now=self.now)

        self.assertEqual(exit_code, 0)
        self.assertIsNone(client.created_failure_issue)
        failure_updates = [
            payload for issue_id, payload in client.updated_issues if issue_id == "failure-1"
        ]
        self.assertEqual(len(failure_updates), 1)
        self.assertEqual(failure_updates[0]["priority"], "critical")
        self.assertEqual(failure_updates[0]["assigneeAgentId"], "agent-1")
        self.assertIn("description", failure_updates[0])
        self.assertIn("lastRun.status is failed", failure_updates[0]["comment"])

    def test_failure_issue_client_search_and_create_payloads(self):
        client = RecordingClient(
            [
                {"id": "other", "title": "unrelated"},
                {"id": "failure-1", "title": guard.FAILURE_ISSUE_TITLE},
            ]
        )

        issue = guard.PaperclipClient.find_open_failure_issue(client)

        self.assertEqual(issue["id"], "failure-1")
        self.assertEqual(client.requests[0][0], "GET")
        self.assertIn("q=Prometheus+Alert+Poller+liveness+failure", client.requests[0][1])
        self.assertIn("status=todo%2Cin_progress%2Cin_review%2Cblocked", client.requests[0][1])

        client = RecordingClient({"id": "created"})

        guard.PaperclipClient.create_failure_issue(
            client, "project-1", "agent-1", "failure body"
        )

        self.assertEqual(
            client.requests[0],
            (
                "POST",
                "/api/companies/company-1/issues",
                {
                    "title": guard.FAILURE_ISSUE_TITLE,
                    "description": "failure body",
                    "status": "todo",
                    "priority": "critical",
                    "projectId": "project-1",
                    "assigneeAgentId": "agent-1",
                },
            ),
        )

    def test_guard_does_not_call_prometheus_poller_script(self):
        source = SCRIPT.read_text()
        self.assertNotIn("prometheus-alert-poll.sh", source)


if __name__ == "__main__":
    unittest.main()
