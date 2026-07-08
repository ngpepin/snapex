#!/usr/bin/env bash
set -euo pipefail

CODE_CLI="${CODE_CLI:-code}"
REPO_REMOTE="${REPO_REMOTE:-origin}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SKIP_PULL="false"
RESET_TO_ORIGIN="false"

usage() {
  cat <<'USAGE'
Usage: bash update-extension.sh [options]

Build and reinstall the latest local SnapEx VSIX from this repository.

Options:
  --skip-pull          Do not fetch or pull before building.
  --reset-to-origin    Replace the local branch with origin/main before building.
                      This discards local commits and working-tree changes.
  -h, --help           Show this help.

Environment:
  CODE_CLI             VS Code CLI to use. Defaults to: code
  REPO_REMOTE          Git remote to pull from. Defaults to: origin
  REPO_BRANCH          Branch to sync. Defaults to: main
USAGE
}

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)
      SKIP_PULL="true"
      ;;
    --reset-to-origin)
      RESET_TO_ORIGIN="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

for command_name in git node npm "$CODE_CLI"; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "This script must be run from inside the snapex git repository."
[[ -f package.json ]] || fail "package.json was not found in $SCRIPT_DIR."

if [[ "$SKIP_PULL" != "true" ]]; then
  log "Fetching latest $REPO_REMOTE/$REPO_BRANCH and tags"
  git fetch "$REPO_REMOTE" --tags

  if [[ "$RESET_TO_ORIGIN" == "true" ]]; then
    log "Resetting local branch to $REPO_REMOTE/$REPO_BRANCH"
    git reset --hard "$REPO_REMOTE/$REPO_BRANCH"
  else
    log "Fast-forwarding local branch"
    git pull --ff-only "$REPO_REMOTE" "$REPO_BRANCH"
  fi
fi

EXTENSION_NAME="$(node -p "require('./package.json').name")"
EXTENSION_VERSION="$(node -p "require('./package.json').version")"
EXTENSION_PUBLISHER="$(node -p "require('./package.json').publisher")"
EXTENSION_ID="${EXTENSION_PUBLISHER}.${EXTENSION_NAME}"
VSIX_FILE="${EXTENSION_NAME}-${EXTENSION_VERSION}.vsix"

log "Preparing SnapEx ${EXTENSION_VERSION}"
printf 'Extension id: %s\n' "$EXTENSION_ID"
printf 'Expected VSIX: %s\n' "$VSIX_FILE"

log "Installing npm dependencies"
npm install

log "Running tests"
npm test

log "Packaging VSIX"
npm run package

[[ -f "$VSIX_FILE" ]] || fail "Expected VSIX not found: $VSIX_FILE"

log "Uninstalling previous local SnapEx extension ids if present"
"$CODE_CLI" --uninstall-extension local-tools.extension-state-backup >/dev/null 2>&1 || true
"$CODE_CLI" --uninstall-extension "$EXTENSION_ID" >/dev/null 2>&1 || true

log "Installing $VSIX_FILE"
"$CODE_CLI" --install-extension "$VSIX_FILE" --force

cat <<EOF

SnapEx ${EXTENSION_VERSION} has been packaged and installed.
Reload VS Code to activate the updated extension.

Final verification step, not run by this script:
  ${CODE_CLI} --list-extensions --show-versions | grep '^${EXTENSION_ID}@'
EOF
