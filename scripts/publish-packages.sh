#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT_DIR/packages/ermis-chat-sdk"
REACT_DIR="$ROOT_DIR/packages/ermis-chat-react"
SDK_NAME="@ermis-network/ermis-chat-sdk"
REACT_NAME="@ermis-network/ermis-chat-react"

TAG="${NPM_TAG:-external}"
ACCESS="public"
OTP="${NPM_OTP:-}"
SDK_OTP="${NPM_SDK_OTP:-}"
REACT_OTP="${NPM_REACT_OTP:-}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
WAIT_TIMEOUT="${NPM_PUBLISH_WAIT_TIMEOUT:-120}"
WAIT_INTERVAL="${NPM_PUBLISH_WAIT_INTERVAL:-5}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_PACK=0
YES=0

if [[ -n "$OTP" ]]; then
  SDK_OTP="${SDK_OTP:-$OTP}"
  REACT_OTP="${REACT_OTP:-$OTP}"
fi

usage() {
  cat <<'USAGE'
Usage: scripts/publish-packages.sh [options]

Publishes both Ermis packages sequentially:
  1. @ermis-network/ermis-chat-sdk
  2. @ermis-network/ermis-chat-react

This script is resumable. If the SDK version already exists but React does not,
it skips SDK and continues with React. After SDK publish, it waits until npm
registry can resolve that SDK version before publishing React.

For npm web-based 2FA, do not pass --otp. npm publish will pause, ask you to
press ENTER to open the browser, and continue after browser verification.

Options:
  --tag <tag>          npm dist-tag. This external release requires: external
  --otp <code>         npm 2FA one-time password for both packages. Also accepts NPM_OTP
  --otp-sdk <code>     npm 2FA one-time password for SDK. Also accepts NPM_SDK_OTP
  --otp-react <code>   npm 2FA one-time password for React. Also accepts NPM_REACT_OTP
  --registry <url>     npm registry. Default: https://registry.npmjs.org
  --wait-timeout <sec> seconds to wait for SDK registry propagation. Default: 120
  --wait-interval <s>  seconds between registry checks. Default: 5
  --dry-run            Run npm publish --dry-run for both packages
  --skip-build         Skip yarn build
  --skip-pack          Skip npm pack --dry-run checks
  --yes                Do not prompt before real publish
  -h, --help           Show this help

Examples:
  scripts/publish-packages.sh --dry-run
  scripts/publish-packages.sh --yes
  scripts/publish-packages.sh --tag external --yes
  scripts/publish-packages.sh --otp-sdk 111111 --otp-react 222222 --yes
  scripts/publish-packages.sh --registry https://registry.npmjs.org --yes
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

pkg_publish_access() {
  node -e "console.log(require(process.argv[1]).publishConfig?.access || '')" "$1/package.json"
}

pkg_publish_tag() {
  node -e "console.log(require(process.argv[1]).publishConfig?.tag || '')" "$1/package.json"
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

wait_for_version() {
  local package_name="$1"
  local version="$2"
  local waited=0

  log "Waiting for npm registry"
  while true; do
    if version_exists "$package_name" "$version"; then
      printf '%s@%s is visible on npm.\n' "$package_name" "$version"
      return 0
    fi

    if (( waited >= WAIT_TIMEOUT )); then
      fail "$package_name@$version is still not visible on npm after ${WAIT_TIMEOUT}s"
    fi

    printf 'Waiting for %s@%s... %ss/%ss\n' "$package_name" "$version" "$waited" "$WAIT_TIMEOUT"
    sleep "$WAIT_INTERVAL"
    waited=$((waited + WAIT_INTERVAL))
  done
}

publish_one() {
  local package_dir="$1"
  local package_name="$2"
  local otp_code="$3"
  local publish_args=(--tag "$TAG" --access "$ACCESS")

  if [[ "$DRY_RUN" == "1" ]]; then
    publish_args+=(--dry-run)
  fi

  if [[ -n "$otp_code" ]]; then
    publish_args+=(--otp "$otp_code")
  fi

  log "Publishing $package_name"
  (
    cd "$package_dir"
    npm publish --registry "$NPM_REGISTRY" "${publish_args[@]}"
  )
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
      SDK_OTP="${SDK_OTP:-$OTP}"
      REACT_OTP="${REACT_OTP:-$OTP}"
      shift 2
      ;;
    --otp-sdk)
      [[ $# -ge 2 ]] || fail "--otp-sdk requires a value"
      SDK_OTP="$2"
      shift 2
      ;;
    --otp-react)
      [[ $# -ge 2 ]] || fail "--otp-react requires a value"
      REACT_OTP="$2"
      shift 2
      ;;
    --registry)
      [[ $# -ge 2 ]] || fail "--registry requires a value"
      NPM_REGISTRY="$2"
      shift 2
      ;;
    --wait-timeout)
      [[ $# -ge 2 ]] || fail "--wait-timeout requires a value"
      WAIT_TIMEOUT="$2"
      shift 2
      ;;
    --wait-interval)
      [[ $# -ge 2 ]] || fail "--wait-interval requires a value"
      WAIT_INTERVAL="$2"
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
SDK_PUBLISH_ACCESS="$(pkg_publish_access "$SDK_DIR")"
REACT_PUBLISH_ACCESS="$(pkg_publish_access "$REACT_DIR")"
SDK_PUBLISH_TAG="$(pkg_publish_tag "$SDK_DIR")"
REACT_PUBLISH_TAG="$(pkg_publish_tag "$REACT_DIR")"

[[ "$SDK_PKG_NAME" == "$SDK_NAME" ]] || fail "SDK package name is $SDK_PKG_NAME, expected $SDK_NAME"
[[ "$REACT_PKG_NAME" == "$REACT_NAME" ]] || fail "React package name is $REACT_PKG_NAME, expected $REACT_NAME"
[[ "$SDK_VERSION" == "$REACT_VERSION" ]] || fail "version mismatch: $SDK_NAME@$SDK_VERSION vs $REACT_NAME@$REACT_VERSION"
[[ "$REACT_SDK_DEP" == "$SDK_VERSION" ]] || fail "$REACT_NAME dependency on $SDK_NAME is $REACT_SDK_DEP, expected $SDK_VERSION"
[[ "$TAG" == "external" ]] || fail "external packages must use npm dist-tag external, got $TAG"
[[ "$SDK_PUBLISH_ACCESS" == "$ACCESS" ]] || fail "$SDK_NAME publishConfig.access is $SDK_PUBLISH_ACCESS, expected $ACCESS"
[[ "$REACT_PUBLISH_ACCESS" == "$ACCESS" ]] || fail "$REACT_NAME publishConfig.access is $REACT_PUBLISH_ACCESS, expected $ACCESS"
[[ "$SDK_PUBLISH_TAG" == "$TAG" ]] || fail "$SDK_NAME publishConfig.tag is $SDK_PUBLISH_TAG, expected $TAG"
[[ "$REACT_PUBLISH_TAG" == "$TAG" ]] || fail "$REACT_NAME publishConfig.tag is $REACT_PUBLISH_TAG, expected $TAG"

log "Packages"
printf '%s@%s\n' "$SDK_NAME" "$SDK_VERSION"
printf '%s@%s\n' "$REACT_NAME" "$REACT_VERSION"
printf 'dist-tag: %s\n' "$TAG"
printf 'access: %s\n' "$ACCESS"
printf 'registry: %s\n' "$NPM_REGISTRY"

SDK_EXISTS=0
REACT_EXISTS=0

if [[ "$DRY_RUN" != "1" ]]; then
  log "Checking npm authentication"
  npm whoami --registry "$NPM_REGISTRY" >/dev/null || fail "npm authentication failed; run npm login --registry=$NPM_REGISTRY or set NODE_AUTH_TOKEN"

  log "Checking npm versions"
  if version_exists "$SDK_NAME" "$SDK_VERSION"; then
    SDK_EXISTS=1
  fi
  if version_exists "$REACT_NAME" "$REACT_VERSION"; then
    REACT_EXISTS=1
  fi

  if [[ "$SDK_EXISTS" == "1" && "$REACT_EXISTS" == "1" ]]; then
    fail "$SDK_NAME@$SDK_VERSION and $REACT_NAME@$REACT_VERSION already exist on npm"
  fi
  if [[ "$SDK_EXISTS" != "1" && "$REACT_EXISTS" == "1" ]]; then
    fail "$REACT_NAME@$REACT_VERSION exists but $SDK_NAME@$SDK_VERSION does not; check package versions"
  fi
  if [[ "$SDK_EXISTS" == "1" && "$REACT_EXISTS" != "1" ]]; then
    printf '%s@%s already exists; resuming with React publish.\n' "$SDK_NAME" "$SDK_VERSION"
  fi
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building SDK and React packages"
  (cd "$ROOT_DIR" && yarn build)
fi

if [[ "$SKIP_PACK" != "1" ]]; then
  log "Running npm pack --dry-run checks"
  if [[ "$DRY_RUN" == "1" || "$SDK_EXISTS" != "1" ]]; then
    (cd "$SDK_DIR" && npm pack --dry-run --json >/dev/null)
  fi
  if [[ "$DRY_RUN" == "1" || "$REACT_EXISTS" != "1" ]]; then
    (cd "$REACT_DIR" && npm pack --dry-run --json >/dev/null)
  fi
fi

if [[ "$DRY_RUN" != "1" && "$YES" != "1" ]]; then
  printf '\nPublish missing packages sequentially now? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) fail "publish cancelled" ;;
  esac
fi

if [[ "$DRY_RUN" == "1" ]]; then
  publish_one "$SDK_DIR" "$SDK_NAME" "$SDK_OTP"
  publish_one "$REACT_DIR" "$REACT_NAME" "$REACT_OTP"
else
  if [[ "$SDK_EXISTS" != "1" ]]; then
    publish_one "$SDK_DIR" "$SDK_NAME" "$SDK_OTP"
    wait_for_version "$SDK_NAME" "$SDK_VERSION"
  else
    log "Skipping $SDK_NAME"
    printf '%s@%s already exists on npm.\n' "$SDK_NAME" "$SDK_VERSION"
  fi

  if [[ "$REACT_EXISTS" != "1" ]]; then
    wait_for_version "$SDK_NAME" "$SDK_VERSION"
    publish_one "$REACT_DIR" "$REACT_NAME" "$REACT_OTP"
  else
    log "Skipping $REACT_NAME"
    printf '%s@%s already exists on npm.\n' "$REACT_NAME" "$REACT_VERSION"
  fi
fi

log "Done"
if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Dry run completed for %s@%s and %s@%s.\n' "$SDK_NAME" "$SDK_VERSION" "$REACT_NAME" "$REACT_VERSION"
else
  printf 'Publish flow completed for %s@%s and %s@%s with dist-tag %s.\n' "$SDK_NAME" "$SDK_VERSION" "$REACT_NAME" "$REACT_VERSION" "$TAG"
fi
