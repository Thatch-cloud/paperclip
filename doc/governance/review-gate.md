# review-gate.yml — non-author review enforcement

The `review-gate` workflow validates a Paperclip review attestation in the PR
body and records a `github-actions[bot]` approval for branch protection. It
runs on `pull_request_target` so it uses base-branch code and secrets, never
PR-head code.

## How it works

1. The reviewer reviews the PR at the current head commit.
2. The reviewer adds a `<!-- paperclip-review -->` attestation block to the PR body.
3. The workflow parses the block, validates every field, and records a
   `github-actions[bot]` approval.
4. If the PR head changes or the attestation is removed, stale approvals are
   dismissed automatically.

## Attestation block

```md
<!-- paperclip-review:start -->
- Issue: THA-0000
- Author-agent: agent-key
- Reviewer-agent: reviewer-key
- Decision: approved
- Head-sha: full-or-7-plus-character-sha
- Open-findings-reconciled: none
- Paperclip-review: /THA/issues/THA-0000#comment-comment-id
<!-- paperclip-review:end -->
```

## Roster file (`.github/paperclip-agents.txt`)

The roster lists every agent key that may appear in attestation blocks. The
workflow reads it from the **base branch**, not the PR head, so a PR cannot
modify the roster to make its own attestation pass.

### Format

One entry per line. Blank lines and `#`-comment lines are ignored.

```
# bare key — full author + review capability (backward compatible)
ada

# author-only — may author PRs but must never be Reviewer-agent
coo  author-only
```

| Marker        | Effect on Author-agent | Effect on Reviewer-agent            |
| ------------- | ---------------------- | ----------------------------------- |
| *(bare key)*  | Allowed                | Allowed                             |
| `author-only` | Allowed                | **Rejected** — gate fails closed    |

### Roster parser

The parsing logic lives in `.github/scripts/review-gate-roster.mjs` and is
shared between the workflow and the test suite:

```
node --test .github/scripts/tests/review-gate-roster.test.mjs
```

## Validation checks

The gate fails closed (dismisses stale approvals and sets a failing status)
when any of the following are true:

- No `paperclip-review` attestation block in the PR body
- `Author-agent` or `Reviewer-agent` missing
- `Author-agent` or `Reviewer-agent` not in the roster
- `Reviewer-agent` is marked `author-only` in the roster
- `Reviewer-agent` equals `Author-agent`
- `Decision` is not exactly `approved`
- `Head-sha` does not match the current PR head
- `Open-findings-reconciled` is missing or lists open/unresolved findings
- `Paperclip-review` link is missing

## Related

- [Branch protection](branch-protection.md) — required status checks and the
  `Recordable non-author review` context.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — "Recordable Non-Author Review"
  section with the attestation template.
