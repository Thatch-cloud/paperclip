#!/usr/bin/env python3
"""Watch the Paperclip Prometheus Alert Poller routine via Paperclip metadata only."""

import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone


TARGET_ROUTINE_TITLE = os.environ.get("TARGET_ROUTINE_TITLE", "Prometheus Alert Poller")
FAILURE_ISSUE_TITLE = os.environ.get(
    "FAILURE_ISSUE_TITLE", "Prometheus Alert Poller liveness failure"
)
OPEN_STATUSES = ("todo", "in_progress", "in_review", "blocked")


def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def age_seconds(now, value):
    parsed = parse_time(value)
    if parsed is None:
        return None
    return (now - parsed).total_seconds()


def enabled_schedule_triggers(routine):
    return [
        trigger
        for trigger in routine.get("triggers", [])
        if trigger.get("kind") == "schedule" and trigger.get("enabled") is not False
    ]


def open_issue(issue):
    return bool(issue) and issue.get("status") in OPEN_STATUSES


def issue_link(identifier):
    if not identifier or "-" not in identifier:
        return identifier or None
    prefix = identifier.split("-", 1)[0]
    return f"[{identifier}](/{prefix}/issues/{identifier})"


def stale_reasons(routine, now):
    if routine is None:
        return ["target routine is missing"]

    reasons = []
    status = routine.get("status")
    if status != "active":
        reasons.append(f"target routine status is {status or 'missing'}")

    schedules = enabled_schedule_triggers(routine)
    if not schedules:
        reasons.append("target routine has no enabled schedule trigger")

    triggered_age = age_seconds(now, routine.get("lastTriggeredAt"))
    if triggered_age is None:
        reasons.append("target routine has no lastTriggeredAt")
    elif triggered_age > 10 * 60:
        reasons.append(
            f"target lastTriggeredAt is {int(triggered_age)}s old (>600s)"
        )

    for trigger in schedules:
        next_run_age = age_seconds(now, trigger.get("nextRunAt"))
        if next_run_age is not None and next_run_age > 10 * 60:
            label = trigger.get("label") or trigger.get("id") or "schedule"
            reasons.append(
                f"target trigger {label} nextRunAt is {int(next_run_age)}s in the past (>600s)"
            )

    last_run = routine.get("lastRun") or {}
    last_status = last_run.get("status")
    failure_reason = last_run.get("failureReason")
    if last_status == "failed":
        reasons.append("target lastRun.status is failed")
    if failure_reason:
        reasons.append(f"target lastRun.failureReason is {failure_reason}")

    active_issue = routine.get("activeIssue")
    active_issue_age = age_seconds(now, (active_issue or {}).get("updatedAt"))
    if (
        open_issue(active_issue)
        and active_issue_age is not None
        and active_issue_age > 15 * 60
        and last_status
        in {"skipped", "coalesced", "coalesced_into_active", "skipped_active"}
    ):
        identifier = issue_link(active_issue.get("identifier")) or active_issue.get("id")
        reasons.append(
            f"target activeIssue {identifier} is open and stale while runs coalesce/skip into it"
        )

    return reasons


def observation_markdown(routine, reasons):
    if routine is None:
        return "- routine: missing\n"

    trigger_summaries = []
    for trigger in routine.get("triggers", []):
        trigger_summaries.append(
            f"{trigger.get('kind')}:{trigger.get('enabled')}:{trigger.get('nextRunAt')}"
        )

    last_run = routine.get("lastRun") or {}
    active_issue = routine.get("activeIssue") or {}
    active_issue_ref = issue_link(active_issue.get("identifier")) or active_issue.get("id") or None
    lines = [
        f"- routine id: `{routine.get('id')}`",
        f"- status: `{routine.get('status')}`",
        f"- lastTriggeredAt: `{routine.get('lastTriggeredAt')}`",
        f"- lastRun.status: `{last_run.get('status')}`",
        f"- lastRun.failureReason: `{last_run.get('failureReason')}`",
        f"- activeIssue: {active_issue_ref} status `{active_issue.get('status')}` updatedAt `{active_issue.get('updatedAt')}`",
        f"- triggers: `{', '.join(trigger_summaries)}`",
    ]
    if reasons:
        lines.append("- stale reasons: " + "; ".join(reasons))
    return "\n".join(lines) + "\n"


class PaperclipClient:
    def __init__(self):
        self.api_url = os.environ["PAPERCLIP_API_URL"].rstrip("/")
        self.company_id = os.environ["PAPERCLIP_COMPANY_ID"]
        self.api_key = os.environ["PAPERCLIP_API_KEY"]
        self.run_id = os.environ.get("PAPERCLIP_RUN_ID")

    def request(self, method, path, payload=None):
        data = None
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if method != "GET" and self.run_id:
            headers["X-Paperclip-Run-Id"] = self.run_id
        req = urllib.request.Request(
            f"{self.api_url}{path}", data=data, headers=headers, method=method
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
        if not body:
            return None
        return json.loads(body)

    def routines(self):
        return self.request("GET", f"/api/companies/{self.company_id}/routines")

    def find_open_failure_issue(self):
        query = urllib.parse.urlencode(
            {"q": FAILURE_ISSUE_TITLE, "status": ",".join(OPEN_STATUSES)}
        )
        issues = self.request("GET", f"/api/companies/{self.company_id}/issues?{query}")
        for issue in issues:
            if issue.get("title") == FAILURE_ISSUE_TITLE:
                return issue
        return None

    def create_failure_issue(self, project_id, assignee_agent_id, comment):
        return self.request(
            "POST",
            f"/api/companies/{self.company_id}/issues",
            {
                "title": FAILURE_ISSUE_TITLE,
                "description": comment,
                "status": "todo",
                "priority": "critical",
                "projectId": project_id,
                "assigneeAgentId": assignee_agent_id,
            },
        )

    def update_issue(self, issue_id, payload):
        return self.request("PATCH", f"/api/issues/{issue_id}", payload)


def find_target_routine(routines):
    for routine in routines:
        if routine.get("title") == TARGET_ROUTINE_TITLE:
            return routine
    return None


def issue_project_id(client, issue_id):
    if not issue_id:
        return None
    response = client.request("GET", f"/api/issues/{issue_id}")
    issue = (response or {}).get("issue") or response or {}
    return issue.get("projectId")


def main(client=None, now=None):
    now = now or datetime.now(timezone.utc)
    client = client or PaperclipClient()
    routines = client.routines()
    target = find_target_routine(routines)
    reasons = stale_reasons(target, now)
    observation = observation_markdown(target, reasons)
    watcher_issue_id = os.environ.get("PAPERCLIP_TASK_ID")

    if reasons:
        if target is None:
            project_id = issue_project_id(client, watcher_issue_id)
        else:
            project_id = target.get("projectId")
        assignee_agent_id = os.environ.get("PAPERCLIP_AGENT_ID")
        if not project_id or not assignee_agent_id:
            raise RuntimeError(
                "project id and assignee agent id are required for failure issue upsert"
            )

        comment = "## Stale\n\nPrometheus Alert Poller liveness guard detected stale routine metadata.\n\n"
        comment += observation
        comment += "\nUnblock action: inspect the Paperclip routine/active issue and restore a successful 5-minute poller cadence."
        failure_issue = client.find_open_failure_issue()
        if failure_issue:
            client.update_issue(
                failure_issue["id"],
                {
                    "priority": "critical",
                    "assigneeAgentId": assignee_agent_id,
                    "description": comment,
                    "comment": comment,
                },
            )
            action = f"updated failure issue {failure_issue.get('identifier') or failure_issue['id']}"
        else:
            created = client.create_failure_issue(project_id, assignee_agent_id, comment)
            action = f"created failure issue {created.get('identifier') or created['id']}"
        print(f"STALE: {action}")
        if watcher_issue_id:
            client.update_issue(
                watcher_issue_id,
                {"status": "done", "comment": f"## Watcher run complete\n\n{action}.\n\n{observation}"},
            )
        return 0

    print("HEALTHY: target routine metadata is fresh")
    if watcher_issue_id:
        client.update_issue(
            watcher_issue_id,
            {"status": "done", "comment": f"## Healthy\n\nPrometheus Alert Poller routine is fresh.\n\n{observation}"},
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
