#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT_DIR/packages/ermis-chat-sdk"
REACT_DIR="$ROOT_DIR/packages/ermis-chat-react"
SDK_NAME="@ermis-network/ermis-chat-sdk"
REACT_NAME="@ermis-network/ermis-chat-react"

TAG="${NPM_TAG:-latest}"
OTP="${NPM_OTP:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_PACK=0
YES=0

usage() {
  cat <<'USAGE'
Usage: scripts/publish-packages.sh [options]

Publishes both Ermis packages in parallel:
  - @ermis-network/ermis-chat-sdk
  - @ermis-network/ermis-chat-react

Options:
  --tag <tag>      npm dist-tag to publish with. Default: latest
  --otp <code>     npm 2FA one-time password. Also accepts NPM_OTP
  --registry <url> npm registry. Default: https://registry.npmjs.org
  --dry-run        Run npm publish --dry-run for both packages
  --skip-build     Skip yarn build
  --skip-pack      Skip npm pack --dry-run checks
  --yes            Do not prompt before real publish
  -h, --help       Show this help

Examples:
  scripts/publish-packages.sh --dry-run
  scripts/publish-packages.sh --yes
  scripts/publish-packages.sh --registry https://registry.npmjs.org --yes
  scripts/publish-packages.sh --tag beta --otp 123456 --yes
USAGE
}

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

pkg_name() {
  node -e "console.log(require(process.argv[1]).name)" "$1/package.json"
}

pkg_version() {
  node -e "console.log(require(process.argv[1]).version)" "$1/package.json"
}

react_sdk_dependency() {
  node -e "console.log(require(process.argv[1]).dependencies['$SDK_NAME'] || '')" "$REACT_DIR/package.json"
}

version_exists() {
  local package_name="$1"
  local version="$2"
  local err_file
  err_file="$(mktemp)"

  if npm view "$package_name@$version" version --registry "$NPM_REGISTRY" >/dev/null 2>"$err_file"; then
    rm -f "$err_file"
    return 0
  fi

  if grep -Eq 'E404|404 Not Found|No match found' "$err_file"; then
    rm -f "$err_file"
    return 1
  fi

  printf 'Could not verify whether %s@%s already exists on npm:\n' "$package_name" "$version" >&2
  cat "$err_file" >&2
  rm -f "$err_file"
  exit 1
}

publish_one() {
  local package_dir="$1"
  local package_name="$2"
  local log_file="$3"
  local publish_args=(--tag "$TAG" --access public)

  if [[ "$DRY_RUN" == "1" ]]; then
    publish_args+=(--dry-run)
  fi

  if [[ -n "$OTP" ]]; then
    publish_args+=(--otp "$OTP")
  fi

  (
    cd "$package_dir"
    npm publish --registry "$NPM_REGISTRY" "${publish_args[@]}"
  ) >"$log_file" 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || fail "--tag requires a value"
      TAG="$2"
      shift 2
      ;;
    --otp)
      [[ $# -ge 2 ]] || fail "--otp requires a value"
      OTP="$2"
      shift 2
      ;;
    --registry)
      [[ $# -ge 2 ]] || fail "--registry requires a value"
      NPM_REGISTRY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-pack)
      SKIP_PACK=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      fail "unknown option: $1"
      ;;
  esac
done

need_command node
need_command npm
need_command yarn

SDK_PKG_NAME="$(pkg_name "$SDK_DIR")"
REACT_PKG_NAME="$(pkg_name "$REACT_DIR")"
SDK_VERSION="$(pkg_version "$SDK_DIR")"
REACT_VERSION="$(pkg_version "$REACT_DIR")"
REACT_SDK_DEP="$(react_sdk_dependency)"

[[ "$SDK_PKG_NAME" == "$SDK_NAME" ]] || fail "SDK package name is $SDK_PKG_NAME, expected $SDK_NAME"
[[ "$REACT_PKG_NAME" == "$REACT_NAME" ]] || fail "React package name is $REACT_PKG_NAME, expected $REACT_NAME"
[[ "$SDK_VERSION" == "$REACT_VERSION" ]] || fail "version mismatch: $SDK_NAME@$SDK_VERSION vs $REACT_NAME@$REACT_VERSION"
[[ "$REACT_SDK_DEP" == "$SDK_VERSION" ]] || fail "$REACT_NAME dependency on $SDK_NAME is $REACT_SDK_DEP, expected $SDK_VERSION"

log "Packages"
printf '%s@%s\n' "$SDK_NAME" "$SDK_VERSION"
printf '%s@%s\n' "$REACT_NAME" "$REACT_VERSION"
printf 'dist-tag: %s\n' "$TAG"
printf 'registry: %s\n' "$NPM_REGISTRY"

if [[ "$DRY_RUN" != "1" ]]; then
  log "Checking npm authentication"
  npm whoami --registry "$NPM_REGISTRY" >/dev/null || fail "npm authentication failed; run npm login --registry=$NPM_REGISTRY or set NODE_AUTH_TOKEN"

  log "Checking npm versions"
  if version_exists "$SDK_NAME" "$SDK_VERSION"; then
    fail "$SDK_NAME@$SDK_VERSION already exists on npm"
  fi
  if version_exists "$REACT_NAME" "$REACT_VERSION"; then
    fail "$REACT_NAME@$REACT_VERSION already exists on npm"
  fi
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building SDK and React packages"
  (cd "$ROOT_DIR" && yarn build)
fi

if [[ "$SKIP_PACK" != "1" ]]; then
  log "Running npm pack --dry-run checks"
  (cd "$SDK_DIR" && npm pack --dry-run --json >/dev/null)
  (cd "$REACT_DIR" && npm pack --dry-run --json >/dev/null)
fi

if [[ "$DRY_RUN" != "1" && "$YES" != "1" ]]; then
  printf '\nPublish both packages in parallel now? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) fail "publish cancelled" ;;
  esac
fi

SDK_LOG="$(mktemp "${TMPDIR:-/tmp}/ermis-chat-sdk-publish.XXXXXX.log")"
REACT_LOG="$(mktemp "${TMPDIR:-/tmp}/ermis-chat-react-publish.XXXXXX.log")"

log "Publishing both packages in parallel"
publish_one "$SDK_DIR" "$SDK_NAME" "$SDK_LOG" &
SDK_PID=$!
publish_one "$REACT_DIR" "$REACT_NAME" "$REACT_LOG" &
REACT_PID=$!

SDK_STATUS=0
REACT_STATUS=0
wait "$SDK_PID" || SDK_STATUS=$?
wait "$REACT_PID" || REACT_STATUS=$?

printf '\n--- %s publish log ---\n' "$SDK_NAME"
cat "$SDK_LOG"
printf '\n--- %s publish log ---\n' "$REACT_NAME"
cat "$REACT_LOG"

rm -f "$SDK_LOG" "$REACT_LOG"

if [[ "$SDK_STATUS" != "0" || "$REACT_STATUS" != "0" ]]; then
  fail "publish failed: $SDK_NAME=$SDK_STATUS, $REACT_NAME=$REACT_STATUS"
fi

log "Done"
if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Dry run completed for %s@%s and %s@%s.\n' "$SDK_NAME" "$SDK_VERSION" "$REACT_NAME" "$REACT_VERSION"
else
  printf 'Published %s@%s and %s@%s with dist-tag %s.\n' "$SDK_NAME" "$SDK_VERSION" "$REACT_NAME" "$REACT_VERSION" "$TAG"
fi
