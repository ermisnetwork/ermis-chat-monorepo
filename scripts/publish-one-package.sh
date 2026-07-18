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
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_PACK=0
YES=0

usage() {
  cat <<'USAGE'
Usage: scripts/publish-one-package.sh <sdk|react> [options]

Publishes one Ermis package at a time. For npm web-based 2FA, do not pass
--otp. npm publish will pause, ask you to press ENTER to open the browser,
and continue after browser verification.

Targets:
  sdk      Publish @ermis-network/ermis-chat-sdk
  react    Publish @ermis-network/ermis-chat-react

Options:
  --tag <tag>      npm dist-tag. This external release requires: external
  --otp <code>     npm 2FA one-time password. Also accepts NPM_OTP
  --registry <url> npm registry. Default: https://registry.npmjs.org
  --dry-run        Run npm publish --dry-run
  --skip-build     Skip yarn build for the selected target
  --skip-pack      Skip npm pack --dry-run check
  --yes            Do not prompt before real publish
  -h, --help       Show this help

Examples:
  scripts/publish-one-package.sh sdk --yes
  scripts/publish-one-package.sh react --yes
  scripts/publish-one-package.sh react --otp 654321 --yes
  scripts/publish-one-package.sh react --dry-run --skip-build --skip-pack
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

TARGET="${1:-}"
case "$TARGET" in
  sdk|react)
    shift
    ;;
  -h|--help|"")
    usage
    exit 0
    ;;
  *)
    usage
    fail "unknown target: $TARGET"
    ;;
esac

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

if [[ "$TARGET" == "sdk" ]]; then
  PACKAGE_DIR="$SDK_DIR"
  PACKAGE_NAME="$SDK_NAME"
  PACKAGE_VERSION="$SDK_VERSION"
  BUILD_CMD="build:sdk"
else
  PACKAGE_DIR="$REACT_DIR"
  PACKAGE_NAME="$REACT_NAME"
  PACKAGE_VERSION="$REACT_VERSION"
  BUILD_CMD="build"
fi

log "Package"
printf '%s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
printf 'dist-tag: %s\n' "$TAG"
printf 'access: %s\n' "$ACCESS"
printf 'registry: %s\n' "$NPM_REGISTRY"

if [[ "$DRY_RUN" != "1" ]]; then
  log "Checking npm authentication"
  npm whoami --registry "$NPM_REGISTRY" >/dev/null || fail "npm authentication failed; run npm login --registry=$NPM_REGISTRY or set NODE_AUTH_TOKEN"

  log "Checking npm versions"
  if version_exists "$PACKAGE_NAME" "$PACKAGE_VERSION"; then
    fail "$PACKAGE_NAME@$PACKAGE_VERSION already exists on npm"
  fi

  if [[ "$TARGET" == "react" ]]; then
    if ! version_exists "$SDK_NAME" "$SDK_VERSION"; then
      fail "$REACT_NAME@$REACT_VERSION depends on $SDK_NAME@$SDK_VERSION; publish SDK first"
    fi
  fi
fi

if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building target"
  (cd "$ROOT_DIR" && yarn "$BUILD_CMD")
fi

if [[ "$SKIP_PACK" != "1" ]]; then
  log "Running npm pack --dry-run check"
  (cd "$PACKAGE_DIR" && npm pack --dry-run --json >/dev/null)
fi

if [[ "$DRY_RUN" != "1" && "$YES" != "1" ]]; then
  printf '\nPublish %s@%s now? [y/N] ' "$PACKAGE_NAME" "$PACKAGE_VERSION"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) fail "publish cancelled" ;;
  esac
fi

publish_args=(--tag "$TAG" --access "$ACCESS")

if [[ "$DRY_RUN" == "1" ]]; then
  publish_args+=(--dry-run)
fi

if [[ -n "$OTP" ]]; then
  publish_args+=(--otp "$OTP")
fi

log "Publishing"
(
  cd "$PACKAGE_DIR"
  npm publish --registry "$NPM_REGISTRY" "${publish_args[@]}"
)

log "Done"
if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Dry run completed for %s@%s.\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
else
  printf 'Published %s@%s with dist-tag %s.\n' "$PACKAGE_NAME" "$PACKAGE_VERSION" "$TAG"
fi
