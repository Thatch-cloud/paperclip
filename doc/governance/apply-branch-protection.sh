#!/usr/bin/env bash
# Apply the desired branch protection for `master`.
#
# Source of truth: doc/governance/branch-protection.md
# Requires: gh authenticated as a repo admin on Thatch-cloud/paperclip.
#
# Usage:
#   doc/governance/apply-branch-protection.sh
#   DRY_RUN=1 doc/governance/apply-branch-protection.sh
set -euo pipefail

REPO="${REPO:-Thatch-cloud/paperclip}"
BRANCH="${BRANCH:-master}"

read -r -d '' PAYLOAD <<'JSON' || true
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "review",
      "verify",
      "Verify serialized server suites (1/4)",
      "Verify serialized server suites (2/4)",
      "Verify serialized server suites (3/4)",
      "Verify serialized server suites (4/4)",
      "Canary Dry Run",
      "e2e",
      "Recordable non-author review"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null
}
JSON

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf 'DRY_RUN: would PUT to repos/%s/branches/%s/protection:\n%s\n' "$REPO" "$BRANCH" "$PAYLOAD"
  exit 0
fi

printf 'Applying branch protection to %s@%s...\n' "$REPO" "$BRANCH"
printf '%s' "$PAYLOAD" | gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" --input -
printf 'Done. Verify with: gh api repos/%s/branches/%s/protection\n' "$REPO" "$BRANCH"
