#!/usr/bin/env bash
set -euo pipefail

RELEASE_DIR="${PAPERCLIP_CONTROL_PLANE_RELEASE_DIR:-$(pwd)}"
EXPECTED_REF="${PAPERCLIP_CONTROL_PLANE_REF:-}"

if [[ -z "$EXPECTED_REF" ]]; then
  echo "start-control-plane: PAPERCLIP_CONTROL_PLANE_REF is required" >&2
  exit 78
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "start-control-plane: release dir does not exist: $RELEASE_DIR" >&2
  exit 78
fi

ACTUAL_REF="$(git -C "$RELEASE_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ -z "$ACTUAL_REF" ]]; then
  echo "start-control-plane: release dir is not a git checkout: $RELEASE_DIR" >&2
  exit 78
fi

if [[ "$ACTUAL_REF" != "$EXPECTED_REF" ]]; then
  echo "start-control-plane: refusing to boot $ACTUAL_REF; expected $EXPECTED_REF" >&2
  exit 78
fi

COMMIT_FILE="$RELEASE_DIR/.paperclip-control-plane-ref"
if [[ ! -f "$COMMIT_FILE" ]]; then
  echo "start-control-plane: missing commit marker: $COMMIT_FILE" >&2
  exit 78
fi

MARKER_REF="$(tr -d '[:space:]' < "$COMMIT_FILE")"
if [[ "$MARKER_REF" != "$EXPECTED_REF" ]]; then
  echo "start-control-plane: marker mismatch: expected $EXPECTED_REF, found $MARKER_REF" >&2
  exit 78
fi

export PAPERCLIP_CONTROL_PLANE_RELEASE_DIR="$RELEASE_DIR"

echo "start-control-plane: booting Paperclip control plane ref $EXPECTED_REF from $RELEASE_DIR" >&2
exec "${PAPERCLIP_NODE_BIN:-node}" cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts "$@"
