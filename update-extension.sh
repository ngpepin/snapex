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

Fetch, build, package, reinstall, and verify the latest local SnapEx VSIX from this repository.

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

warn() {
  printf 'Warning: %s\n' "$1" >&2
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

strip_release_prefix() {
  local value="$1"
  value="${value#snapex-}"
  value="${value#v}"
  printf '%s' "$value"
}

latest_release_tag_from_git() {
  git tag --list --sort=-v:refname \
    | grep -E '^(snapex-)?v?[0-9]+\.[0-9]+\.[0-9]+' \
    | head -n 1 \
    || true
}

version_is_less_than() {
  local left="$1"
  local right="$2"

  [[ "$left" == "$right" ]] && return 1
  [[ "$(printf '%s\n%s\n' "$left" "$right" | sort -V | head -n 1)" == "$left" ]]
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

for command_name in git node npm sort grep head "$CODE_CLI"; do
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
else
  warn "Skipping fetch/pull; version and release detection will use the current checkout."
fi

EXTENSION_NAME="$(node -p "require('./package.json').name")"
EXTENSION_VERSION="$(node -p "require('./package.json').version")"
EXTENSION_PUBLISHER="$(node -p "require('./package.json').publisher")"
EXTENSION_ID="${EXTENSION_PUBLISHER}.${EXTENSION_NAME}"
VSIX_FILE="${EXTENSION_NAME}-${EXTENSION_VERSION}.vsix"
LATEST_RELEASE_TAG="$(latest_release_tag_from_git)"
LATEST_RELEASE_VERSION="$(strip_release_prefix "$LATEST_RELEASE_TAG")"

log "Preparing SnapEx ${EXTENSION_VERSION}"
printf 'Extension id: %s\n' "$EXTENSION_ID"
printf 'Expected VSIX: %s\n' "$VSIX_FILE"

if [[ -n "$LATEST_RELEASE_TAG" ]]; then
  printf 'Latest release/tag found locally: %s\n' "$LATEST_RELEASE_TAG"

  if [[ "$LATEST_RELEASE_VERSION" == "$EXTENSION_VERSION" ]]; then
    printf 'package.json version matches the latest release/tag.\n'
  elif version_is_less_than "$EXTENSION_VERSION" "$LATEST_RELEASE_VERSION"; then
    warn "package.json version ${EXTENSION_VERSION} is older than latest release/tag ${LATEST_RELEASE_TAG}."
    warn "Run without --skip-pull, or check whether your branch is behind the released version."
  else
    warn "package.json version ${EXTENSION_VERSION} is newer than latest release/tag ${LATEST_RELEASE_TAG}."
    warn "This is expected when installing unreleased local changes."
  fi
else
  warn "No semver release/tag found; using package.json version ${EXTENSION_VERSION}."
fi

log "Installing npm dependencies"
npm install

log "Running tests"
npm test

log "Packaging VSIX"
rm -f "$VSIX_FILE"
npm run package

[[ -f "$VSIX_FILE" ]] || fail "Expected VSIX not found: $VSIX_FILE"

log "Uninstalling previous local SnapEx extension ids if present"
"$CODE_CLI" --uninstall-extension local-tools.extension-state-backup >/dev/null 2>&1 || true
"$CODE_CLI" --uninstall-extension "$EXTENSION_ID" >/dev/null 2>&1 || true

log "Installing $VSIX_FILE"
"$CODE_CLI" --install-extension "$VSIX_FILE" --force

log "Verifying installed extension"
VERIFY_PATTERN="^${EXTENSION_ID}@"
VERIFY_OUTPUT="$("$CODE_CLI" --list-extensions --show-versions | grep "$VERIFY_PATTERN")" \
  || fail "SnapEx install verification failed. Expected '${EXTENSION_ID}' in VS Code's installed extensions list."
printf '%s\n' "$VERIFY_OUTPUT"

cat <<EOF

SnapEx ${EXTENSION_VERSION} has been packaged, installed, and verified.
Reload VS Code to activate the updated extension.
EOF
