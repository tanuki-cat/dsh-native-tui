#!/usr/bin/env bash
# Install dsh-native-tui into a DSH profile. The profile is initialized by
# dsh on first use; the default profile is "tui".
set -euo pipefail

profile='tui'
mode='link'
build=1

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

Install dsh-native-tui into a DSH profile.

Options:
  -p, --profile <name>  DSH profile to install into (default: tui)
      --pack            install a packed tarball from .tmp instead of linking
                        this checkout; a previous installation is removed first
                        so an unchanged version still picks up the rebuilt tgz
      --no-build        skip pnpm install/build (requires an existing dist/)
  -h, --help            show this help

Environment:
  DSH_HOME              DSH home used by dsh (dsh's own default when unset)

Examples:
  scripts/install.sh
  scripts/install.sh --profile work
  scripts/install.sh --pack
EOF
}

die() {
  echo "install: $*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    -p|--profile)
      (($# >= 2)) || die "missing value for $1"
      profile="$2"
      shift 2
      ;;
    --pack)
      mode='pack'
      shift
      ;;
    --no-build)
      build=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$profile" ]] || die "profile must not be empty"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required (https://pnpm.io)"
command -v dsh >/dev/null 2>&1 || die "dsh is required but was not found on PATH"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ((build)); then
  echo "==> pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
  echo "==> pnpm build"
  pnpm build
else
  [[ -f dist/index.js ]] || die "dist/index.js is missing; run without --no-build"
fi

if [[ "$mode" == 'pack' ]]; then
  mkdir -p .tmp
  echo "==> pnpm pack"
  pack_json="$(pnpm pack --pack-destination .tmp --json)"
  target="$(printf '%s' "$pack_json" | node -e 'let s = ""; process.stdin.on("data", d => { s += d }); process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(s).filename ?? "") } catch {} })')"
  [[ -n "$target" ]] || die "could not read the packed tarball path from pnpm pack"
  # pnpm skips resolution when the profile lockfile already pins the same
  # tarball path and version, so a rebuilt tarball would otherwise stay stale.
  if dsh plugin --profile "$profile" remove dsh-native-tui >/dev/null 2>&1; then
    echo "==> removed the previous installation"
  fi
  echo "==> dsh plugin --profile $profile add $target"
  dsh plugin --profile "$profile" add "$target"
else
  echo "==> dsh plugin --profile $profile add $repo_root"
  dsh plugin --profile "$profile" add "$repo_root"
fi

echo
echo "Installed dsh-native-tui into profile \"$profile\"."
echo "Start it with:"
echo "  dsh --profile $profile"
