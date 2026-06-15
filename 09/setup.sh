#!/usr/bin/env bash
#
# TripWiz — Environment Setup Script (Folder 09)
#
# Prepares a clean machine with everything needed to build and deploy TripWiz:
#   - Node.js / npm           (frontend build)
#   - AWS CLI v2              (account access, stack inspection, Amplify uploads)
#   - AWS SAM CLI             (backend build & deploy)
#   - zip / unzip / jq / curl (used by 09/deploy.sh to package and ship the frontend)
#
# This script ONLY installs/checks local tooling — it does not touch AWS resources.
# Once it finishes, run 09/deploy.sh to build and deploy the backend and frontend.
#
# Usage (from the repo root):
#   chmod +x 09/setup.sh && ./09/setup.sh
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

trap 'error "Setup aborted at line $LINENO — see the message above for the cause."' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect Git Bash / MSYS2 / Cygwin (i.e. Bash running on Windows)
is_windows() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) return 0 ;;
    *) return 1 ;;
  esac
}

# AWS's Windows installers register their install directory on PATH via the
# registry, but a Git Bash session inherits its PATH from its parent process
# tree once at launch — it won't see registry changes until the whole terminal
# app restarts. Proactively add the installers' default locations so a tool
# installed moments ago (in this run, or a previous one) is usable immediately.
refresh_windows_tool_paths() {
  is_windows || return 0

  # Don't hardcode "/c/Program Files" — Windows can be installed on any drive
  # letter. $PROGRAMFILES is a Windows environment variable Git Bash always
  # inherits (e.g. "C:\Program Files" or "D:\Program Files"); cygpath converts
  # it to the matching POSIX path so this works on any machine/drive layout.
  local program_files
  program_files="$(cygpath -u "${PROGRAMFILES:-C:\\Program Files}")"

  local dir
  for dir in "$program_files/Amazon/AWSCLIV2" "$program_files/Amazon/AWSSAMCLI/bin"; do
    # Plain "[[ ... ]] && export ..." would return non-zero (and trip "set -e"
    # / the ERR trap) whenever the directory doesn't exist yet — e.g. SAM CLI's
    # folder, before it's installed. An "if" is exempt from errexit.
    if [[ -d "$dir" && ":$PATH:" != *":$dir:"* ]]; then
      export PATH="$dir:$PATH"
    fi
  done

  # AWS SAM CLI's Windows installer ships "sam.cmd" (plus a bundled
  # "runtime/Scripts/sam.exe" that isn't meant to be called directly). Git
  # Bash's "command -v" auto-resolves plain names to ".exe" but NOT ".cmd",
  # so "sam" stays invisible even with its folder on PATH. Drop a one-line
  # wrapper into 09/.bin (already prepended to PATH by both scripts) that
  # forwards to sam.cmd, so "sam ..." works like on Linux/macOS.
  local sam_cmd="$program_files/Amazon/AWSSAMCLI/bin/sam.cmd"
  if [[ -f "$sam_cmd" ]] && ! command -v sam &>/dev/null; then
    mkdir -p "$SCRIPT_DIR/.bin"
    cat > "$SCRIPT_DIR/.bin/sam" <<EOF
#!/usr/bin/env bash
exec "$sam_cmd" "\$@"
EOF
    chmod +x "$SCRIPT_DIR/.bin/sam"
    if [[ ":$PATH:" != *":$SCRIPT_DIR/.bin:"* ]]; then
      export PATH="$SCRIPT_DIR/.bin:$PATH"
    fi
  fi
  return 0
}

# Launches a downloaded Windows installer (.msi/.exe) via the Windows shell so it
# runs as a normal GUI install (and can request UAC elevation), then waits for it
# to finish and refreshes PATH so the newly-installed tool is usable right away.
run_windows_installer() {
  local installer_path="$1" friendly_name="$2"
  local win_path
  win_path="$(cygpath -w "$installer_path")"
  info "Launching the $friendly_name installer — follow the wizard (it may prompt for administrator rights)."
  # Git Bash/MSYS rewrites POSIX-looking flags such as "/i" into Windows paths
  # before exec'ing native programs, which silently breaks "cmd.exe /c start ...
  # <msi>" (it just opens a bare cmd.exe window instead of the installer).
  # MSYS2_ARG_CONV_EXCL="*" disables that rewriting for this command, and
  # invoking msiexec.exe directly (for .msi) — or the .exe straight — sidesteps
  # the broken "cmd /c start" launch entirely.
  case "$installer_path" in
    *.msi) MSYS2_ARG_CONV_EXCL="*" msiexec.exe /i "$win_path" ;;
    *)     MSYS2_ARG_CONV_EXCL="*" "$installer_path" ;;
  esac
  info "Installer finished — refreshing PATH for this session..."
  refresh_windows_tool_paths
}

# ---------------------------------------------------------------------------
# Step 1 — Node.js / npm
# ---------------------------------------------------------------------------
ensure_node() {
  banner "Step 1/4 — Node.js & npm"

  if ! command -v node &>/dev/null; then
    warn "Node.js not found — attempting automatic install..."
    if command -v brew &>/dev/null; then
      brew install node
    elif command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
    else
      die "Could not auto-install Node.js. Install Node.js 18+ from https://nodejs.org and re-run this script."
    fi
  fi
  success "Node.js $(node --version) / npm $(npm --version)"
}

# ---------------------------------------------------------------------------
# Step 2 — AWS CLI v2
# ---------------------------------------------------------------------------
ensure_aws_cli() {
  banner "Step 2/4 — AWS CLI v2"

  refresh_windows_tool_paths
  if ! command -v aws &>/dev/null; then
    warn "AWS CLI not found — attempting automatic install..."
    if [[ "${OSTYPE:-}" == darwin* ]]; then
      curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
      sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
    elif [[ "${OSTYPE:-}" == linux* ]]; then
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
      unzip -q -o /tmp/awscliv2.zip -d /tmp
      sudo /tmp/aws/install --update
    elif is_windows; then
      info "Windows detected — downloading the official AWS CLI v2 installer (MSI)..."
      curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.msi" -o /tmp/AWSCLIV2.msi
      run_windows_installer "/tmp/AWSCLIV2.msi" "AWS CLI v2"
      command -v aws &>/dev/null \
        || die "AWS CLI was installed, but this terminal still can't see it on PATH. Close this Git Bash window completely (not just the tab), reopen it fresh, and re-run ./09/setup.sh."
    else
      die "Could not auto-install AWS CLI. Install it from https://aws.amazon.com/cli/ and re-run this script."
    fi
  fi
  success "$(aws --version 2>&1)"
}

# ---------------------------------------------------------------------------
# Step 3 — AWS SAM CLI
# ---------------------------------------------------------------------------
ensure_sam_cli() {
  banner "Step 3/4 — AWS SAM CLI"

  refresh_windows_tool_paths
  if ! command -v sam &>/dev/null; then
    warn "AWS SAM CLI not found — attempting automatic install..."
    if is_windows; then
      info "Windows detected — downloading the official AWS SAM CLI installer (MSI)..."
      curl -fsSL "https://github.com/aws/aws-sam-cli/releases/latest/download/AWS_SAM_CLI_64_PY3.msi" -o /tmp/AWS_SAM_CLI_64_PY3.msi
      run_windows_installer "/tmp/AWS_SAM_CLI_64_PY3.msi" "AWS SAM CLI"
      command -v sam &>/dev/null \
        || die "AWS SAM CLI was installed, but this terminal still can't see it on PATH. Close this Git Bash window completely (not just the tab), reopen it fresh, and re-run ./09/setup.sh."
    elif command -v pip3 &>/dev/null; then
      pip3 install --user aws-sam-cli
    else
      die "Could not auto-install SAM CLI. Install it from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html and re-run this script."
    fi
  fi
  success "$(sam --version 2>&1)"
}

# ---------------------------------------------------------------------------
# Step 4 — Supporting CLI tools (zip / unzip / jq / curl)
# ---------------------------------------------------------------------------
ensure_supporting_tools() {
  banner "Step 4/4 — Supporting tools"

  # Local bin directory for portable Windows binaries (added to PATH for this run)
  local local_bin="$SCRIPT_DIR/.bin"

  # "zip" packages the frontend build for Amplify uploads, and "unzip" is used
  # by the Linux AWS-CLI install path above. Neither has an official Windows
  # binary or a Git-Bash package manager to fetch one from — but neither is
  # actually needed there either: deploy.sh falls back to PowerShell's
  # Compress-Archive (always present on Windows 10/11) instead of "zip", and
  # the AWS/SAM installers on Windows are MSIs, not zips, so "unzip" is unused.
  local tools=(jq curl)
  if is_windows; then
    info "'zip'/'unzip' aren't required on Windows — deploy.sh uses PowerShell's Compress-Archive instead, and the Windows installers don't need unzip."
  else
    tools=(zip unzip "${tools[@]}")
  fi

  for tool in "${tools[@]}"; do
    if ! command -v "$tool" &>/dev/null; then
      warn "'$tool' not found — attempting automatic install..."

      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y "$tool"
      elif command -v brew &>/dev/null; then
        brew install "$tool"
      fi

      if ! command -v "$tool" &>/dev/null && is_windows && [[ "$tool" == "jq" ]]; then
        mkdir -p "$local_bin"
        info "Downloading a portable jq.exe into 09/.bin ..."
        curl -fsSL "https://github.com/jqlang/jq/releases/latest/download/jq-windows-amd64.exe" -o "$local_bin/jq.exe"
        chmod +x "$local_bin/jq.exe"
      fi

      command -v "$tool" &>/dev/null || [[ -x "$local_bin/$tool.exe" ]] \
        || die "'$tool' is required but could not be auto-installed. Install it manually and re-run this script."
    fi
  done

  if [[ -d "$local_bin" ]]; then
    export PATH="$local_bin:$PATH"
    info "Added 09/.bin to PATH for this session (portable tools downloaded there)."
  fi

  success "Required supporting tools present"
}

# ---------------------------------------------------------------------------
main() {
  banner "TripWiz — Environment Setup"
  ensure_node
  ensure_aws_cli
  ensure_sam_cli
  ensure_supporting_tools
  banner "Environment ready!"
  echo
  echo "  Next step: run ./09/deploy.sh to build and deploy the backend and frontend."
  echo
}

main "$@"
