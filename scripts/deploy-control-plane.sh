#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/deploy-control-plane.sh [git-ref]

Creates or reuses a detached Paperclip control-plane release worktree pinned to
an exact commit, then updates ~/.paperclip/control-plane/current and deploy.env.

Environment overrides:
  PAPERCLIP_CONTROL_PLANE_SOURCE_REPO   Source repo (default: current repo)
  PAPERCLIP_CONTROL_PLANE_ROOT          Release root (default: ~/.paperclip/control-plane)
  PAPERCLIP_CONTROL_PLANE_SKIP_INSTALL  Set to 1 to skip pnpm install
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE_REPO="${PAPERCLIP_CONTROL_PLANE_SOURCE_REPO:-$DEFAULT_SOURCE_REPO}"
DEPLOY_ROOT="${PAPERCLIP_CONTROL_PLANE_ROOT:-$HOME/.paperclip/control-plane}"
REF="${1:-origin/master}"

if git -C "$SOURCE_REPO" remote get-url origin >/dev/null 2>&1; then
  git -C "$SOURCE_REPO" fetch origin
fi
SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "${REF}^{commit}")"
RELEASE_DIR="$DEPLOY_ROOT/releases/$SHA"

mkdir -p "$DEPLOY_ROOT/releases"

if [[ ! -e "$RELEASE_DIR/.git" ]]; then
  git -C "$SOURCE_REPO" worktree add --detach "$RELEASE_DIR" "$SHA"
fi

ACTUAL_SHA="$(git -C "$RELEASE_DIR" rev-parse --verify HEAD)"
if [[ "$ACTUAL_SHA" != "$SHA" ]]; then
  echo "deploy-control-plane: release checkout mismatch: expected $SHA, found $ACTUAL_SHA" >&2
  exit 1
fi

printf '%s\n' "$SHA" > "$RELEASE_DIR/.paperclip-control-plane-ref"

if [[ "${PAPERCLIP_CONTROL_PLANE_SKIP_INSTALL:-0}" != "1" ]]; then
  corepack pnpm --dir "$RELEASE_DIR" install --frozen-lockfile
fi

ln -sfn "$RELEASE_DIR" "$DEPLOY_ROOT/current.tmp"
mv -Tf "$DEPLOY_ROOT/current.tmp" "$DEPLOY_ROOT/current"

cat > "$DEPLOY_ROOT/deploy.env" <<ENV
PAPERCLIP_CONTROL_PLANE_REF=$SHA
PAPERCLIP_CONTROL_PLANE_RELEASE_DIR=$DEPLOY_ROOT/current
ENV

cat <<OUT
deployed_ref=$SHA
release_dir=$RELEASE_DIR
current=$DEPLOY_ROOT/current
env_file=$DEPLOY_ROOT/deploy.env
OUT
