#!/usr/bin/env bash
#
# TripWiz — Source Extraction Script (Folder 09)
#
# If you received this project as the 12 numbered deliverable folders (01-12)
# plus 09/TripWiz-source.zip — rather than as a full "git clone" — run this
# FIRST. It extracts TripWiz-source.zip into the repo root (the directory that
# holds 01/ .. 12/), recreating README.md, frontend/, backend/, and tools/ as
# siblings of 09/. Both 09/setup.sh and 09/deploy.sh assume that layout —
# deploy.sh resolves backend/frontend paths relative to its own location.
#
# Safe to run on a full git clone too: it's a no-op if backend/ and frontend/
# already exist at the repo root.
#
# Usage (from the repo root):
#   chmod +x 09/extract-source.sh && ./09/extract-source.sh
#
# Requires a Bash environment (Linux, macOS, WSL, or Git Bash on Windows).
# See 09/INSTALL.md for the full walkthrough.

set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[FAIL]${NC}  $*" >&2; }
die()     { error "$*"; exit 1; }
banner()  { echo; echo "============================================================"; echo "  $*"; echo "============================================================"; }

trap 'error "Extraction aborted at line $LINENO — see the message above for the cause."' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZIP_PATH="$SCRIPT_DIR/TripWiz-source.zip"

# Detect Git Bash / MSYS2 / Cygwin (i.e. Bash running on Windows)
is_windows() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Extracts a zip file into a destination directory.
# Mirrors deploy.sh's zip_directory(): prefers the native "unzip" tool, and on
# Windows (no package manager, no official "unzip" binary) falls back to the
# "tar.exe" (bsdtar) bundled with every Windows 10 1803+ / 11 install in
# System32 — bsdtar extracts zip archives with "-xf" just as it creates them.
# ---------------------------------------------------------------------------
extract_zip() {
  local zip_path="$1" dest_dir="$2"
  if command -v unzip &>/dev/null; then
    unzip -q -o "$zip_path" -d "$dest_dir"
  elif is_windows; then
    info "'unzip' isn't available — extracting with the bundled Windows tar (bsdtar) instead."
    local system_root bsdtar win_zip win_dest
    system_root="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")"
    bsdtar="$system_root/System32/tar.exe"
    [[ -x "$bsdtar" ]] || die "Could not find tar.exe at $bsdtar (expected on Windows 10 1803+ / Windows 11). Install 'unzip' instead and re-run."
    win_zip="$(cygpath -w "$zip_path")"
    win_dest="$(cygpath -w "$dest_dir")"
    "$bsdtar" -xf "$win_zip" -C "$win_dest"
  else
    die "'unzip' is required to extract $zip_path. Install it (e.g. apt-get install unzip / brew install unzip) and re-run ./09/extract-source.sh."
  fi
}

# ---------------------------------------------------------------------------
main() {
  banner "TripWiz — Source Extraction"

  if [[ -d "$REPO_ROOT/backend" && -d "$REPO_ROOT/frontend" ]]; then
    success "backend/ and frontend/ already exist at the repo root — nothing to extract (this looks like a full git clone)."
    echo
    echo "  Next step: run ./09/setup.sh, then ./09/deploy.sh."
    echo
    exit 0
  fi

  [[ -f "$ZIP_PATH" ]] \
    || die "Neither backend/+frontend/ nor $ZIP_PATH were found. Re-download the project — either as a full git clone, or as the 12 numbered folders plus 09/TripWiz-source.zip."

  info "Extracting $(basename "$ZIP_PATH") into $REPO_ROOT ..."
  extract_zip "$ZIP_PATH" "$REPO_ROOT"

  [[ -f "$REPO_ROOT/backend/infra/template.yaml" ]] \
    || die "Extraction finished but backend/infra/template.yaml is missing — the zip may be corrupt. Re-download it and try again."
  [[ -f "$REPO_ROOT/frontend/package.json" ]] \
    || die "Extraction finished but frontend/package.json is missing — the zip may be corrupt. Re-download it and try again."

  success "Source code extracted to $REPO_ROOT (README.md, frontend/, backend/, tools/)."
  echo
  echo "  Next step: run ./09/setup.sh, then ./09/deploy.sh."
  echo
}

main "$@"
