# Branch protection for `master` (as code)

`master` must be protected. This file is the source of truth for the desired
GitHub branch protection so it is reviewable and reproducible instead of living
only in the GitHub UI.

Apply it with [`apply-branch-protection.sh`](apply-branch-protection.sh), using a
GitHub identity with admin access to `Thatch-cloud/paperclip`.

## Desired state

Applied to `Thatch-cloud/paperclip@master` on 2026-07-16 after merge
`cb3ed739` added the base-branch `review-gate.yml` workflow and agent roster.

| Setting | Value | Why |
| --- | --- | --- |
| Required status checks | `review`, `verify`, `Verify serialized server suites (1/4)`, `Verify serialized server suites (2/4)`, `Verify serialized server suites (3/4)`, `Verify serialized server suites (4/4)`, `Canary Dry Run`, `e2e`, `Recordable non-author review` | Existing PR quality gates plus the Paperclip non-author review gate. |
| `strict` | `true` | PRs must be up to date before merge. |
| Required approving reviews | `1` | Enforces a GitHub-recorded approval. The Paperclip review gate records `github-actions[bot]` approval after a non-author attestation. |
| `dismiss_stale_reviews` | `true` | A new push invalidates prior approvals. |
| `enforce_admins` | `true` | Removes the admin/direct-merge bypass to the extent GitHub permits. |
| `required_conversation_resolution` | `true` | Review threads must be resolved before merge. |
| `allow_force_pushes` / `allow_deletions` | `false` | Protects branch history. |

## Rollout order

Required status check contexts must exist on the base branch before they are
required, otherwise unrelated PRs can be locked behind a check they cannot
produce.

1. Merge the PR that adds `.github/workflows/review-gate.yml` and `.github/paperclip-agents.txt` to `master`.
2. Confirm a PR with a valid `paperclip-review` block produces a `Recordable non-author review` check and a `github-actions[bot]` approval.
3. Run `bash doc/governance/apply-branch-protection.sh`.
4. Verify with `gh api repos/Thatch-cloud/paperclip/branches/master/protection`.

The required review-gate context is the job name, `Recordable non-author review`,
not the workflow name, `review-gate`.
