# Commitperclip Review Gate

The `commitperclip PR Review` workflow is fork-owned for this repository. It no longer requires the upstream `paperclipai/commitperclip` GitHub App private key or a `COMMITPERCLIP_KEY` secret.

By default, the workflow uses the repository `GITHUB_TOKEN` with the permissions declared in `.github/workflows/commitperclip-review.yml`:

- `pull-requests: write` to post or update the public quality-gate PR comment
- `checks: write` to publish the security-review check run
- `security-events: write` for security reporting support
- `contents: read` for repository metadata and PR file reads

If this fork needs a stable bot identity instead of `github-actions[bot]`, define an optional repository secret named `COMMITPERCLIP_TOKEN`. Use a fork-owned fine-grained PAT or equivalent fork-owned credential with the same effective repository permissions required by the workflow. Do not store or request the upstream `paperclipai/commitperclip` private key for this fork.
