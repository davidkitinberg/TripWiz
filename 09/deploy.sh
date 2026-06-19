#!/usr/bin/env bash
#
# TripWiz — Backend & Frontend Deployment Script (Folder 09)
#
# Builds and deploys TripWiz to AWS once the environment is ready (run 09/setup.sh
# first if you haven't already). This script:
#   1. Verifies/configures AWS credentials
#   2. Builds & deploys the serverless backend (AWS SAM)
#   3. Optionally populates the third-party API key secrets
#   4. Reads the deployed stack's outputs and generates frontend/src/config.js
#   5. Installs dependencies and builds the frontend (Vite/React)
#   6. Deploys the production build to AWS Amplify Hosting
#
# Run from anywhere — paths are resolved relative to this script's location:
#   chmod +x 09/deploy.sh && ./09/deploy.sh
#
# Requires a Bash environment (Linux, macOS, WSL, or Git Bash on Windows) and the
# tooling installed by 09/setup.sh (Node.js, AWS CLI v2, AWS SAM CLI, zip, jq, curl).
# See 09/INSTALL.md for the full walkthrough and the manual steps AWS itself requires.

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

trap 'error "Deployment aborted at line $LINENO — see the message above for the cause."' ERR

# ---------------------------------------------------------------------------
# Paths & configuration (override via environment variables if needed)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend/infra"
FRONTEND_DIR="$REPO_ROOT/frontend"

STACK_NAME="${STACK_NAME:-tripwiz}"
REGION="${AWS_REGION:-us-east-1}"
AMPLIFY_APP_NAME="${AMPLIFY_APP_NAME:-TripWiz}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"

# Pick up any portable tools 09/setup.sh downloaded for Windows/Git Bash (e.g.
# jq.exe, the "sam" wrapper). A bare "[[ -d ... ]] && export ..." would return
# non-zero — and trip "set -e" — whenever .bin doesn't exist; "if" is exempt.
if [[ -d "$SCRIPT_DIR/.bin" ]]; then
  export PATH="$SCRIPT_DIR/.bin:$PATH"
fi

# Detect Git Bash / MSYS2 / Cygwin (i.e. Bash running on Windows)
is_windows() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) return 0 ;;
    *) return 1 ;;
  esac
}

# AWS's Windows installers register their install directory on PATH via the
# registry, but each new Git Bash window/session inherits PATH from its parent
# process tree at launch — it won't see registry changes made by an installer
# that ran in a *previous* session (e.g. when 09/setup.sh installed AWS CLI /
# SAM CLI earlier). Proactively add their default locations so this run can
# see tools that were already installed, without requiring a full restart.
# Mirrors the helper of the same name in 09/setup.sh — see it for more detail.
refresh_windows_tool_paths() {
  is_windows || return 0

  local program_files
  program_files="$(cygpath -u "${PROGRAMFILES:-C:\\Program Files}")"

  local dir
  for dir in "$program_files/Amazon/AWSCLIV2" "$program_files/Amazon/AWSSAMCLI/bin"; do
    if [[ -d "$dir" && ":$PATH:" != *":$dir:"* ]]; then
      export PATH="$dir:$PATH"
    fi
  done

  # Re-create the "sam" wrapper (sam.cmd isn't resolved by "command -v") in
  # case 09/.bin was cleaned or this is the first script run in this checkout.
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

refresh_windows_tool_paths

# ---------------------------------------------------------------------------
# Pre-flight check — make sure 09/setup.sh has been run
# ---------------------------------------------------------------------------
check_tooling() {
  local required=(node npm aws sam jq curl)
  # "zip" isn't required on Windows — deploy_frontend() falls back to
  # PowerShell's built-in Compress-Archive there (see zip_directory below),
  # since Git Bash has no package manager and no official "zip" binary ships
  # with any of the AWS installers.
  is_windows || required+=(zip)

  local missing=()
  for tool in "${required[@]}"; do
    command -v "$tool" &>/dev/null || missing+=("$tool")
  done
  if (( ${#missing[@]} > 0 )); then
    die "Missing required tool(s): ${missing[*]}. Run ./09/setup.sh first to install them."
  fi
}

# ---------------------------------------------------------------------------
# Packs a directory's contents into a zip file for upload to Amplify.
# Uses the native "zip" tool where available; on Windows (no package manager,
# no official "zip" binary) falls back to the "tar.exe" (bsdtar) bundled with
# every Windows 10/11 install in System32, using "-a" to auto-detect the zip
# format from the destination's ".zip" extension.
#
# NOTE: PowerShell's Compress-Archive — and even raw .NET ZipFile under
# Windows PowerShell 5.1's bundled .NET Framework — write zip entries with
# backslash ("\") path separators on Windows. The ZIP spec requires forward
# slashes, so Amplify's Linux-based unzip then creates files literally named
# "assets\index-XXXX.js" instead of "assets/index-XXXX.js" — every asset
# 404s and the deployed site is a blank page. bsdtar writes spec-compliant
# forward-slash paths, avoiding this entirely.
# ---------------------------------------------------------------------------
zip_directory() {
  local src_dir="$1" dest_zip="$2"
  rm -f "$dest_zip"
  if command -v zip &>/dev/null; then
    (cd "$src_dir" && zip -qr "$dest_zip" .)
  elif is_windows; then
    info "'zip' isn't available — packaging with the bundled Windows tar (bsdtar) instead."
    local system_root bsdtar win_dest
    system_root="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")"
    bsdtar="$system_root/System32/tar.exe"
    [[ -x "$bsdtar" ]] || die "Could not find tar.exe at $bsdtar (expected on Windows 10 1803+ / Windows 11). Install 'zip' instead and re-run."
    win_dest="$(cygpath -w "$dest_zip")"
    # Glob from inside src_dir so entries are "assets/foo.js", not "./assets/foo.js"
    (cd "$src_dir" && "$bsdtar" -a -cf "$win_dest" -- *)
  else
    die "'zip' is required to package the frontend build for Amplify. Install it (e.g. apt-get install zip / brew install zip) and re-run ./09/deploy.sh."
  fi
  [[ -f "$dest_zip" ]] || die "Failed to create $dest_zip — packaging the frontend build failed."
}

# ---------------------------------------------------------------------------
# Step 1 — AWS credentials
# ---------------------------------------------------------------------------
configure_aws_credentials() {
  banner "Step 1/6 — AWS credentials"

  if aws sts get-caller-identity --output text &>/dev/null; then
    local account
    account="$(aws sts get-caller-identity --query Account --output text)"
    success "AWS credentials already configured (Account: $account, Region: $REGION)"
  else
    warn "No valid AWS credentials were found on this machine."
    info "Launching 'aws configure' — enter your Access Key ID, Secret Access Key, default region ($REGION) and output format (json)."
    aws configure
    aws sts get-caller-identity --output text &>/dev/null \
      || die "Credentials still invalid after 'aws configure'. Re-run this script once you have a working IAM access key."
    success "AWS credentials verified."
  fi
}

# ---------------------------------------------------------------------------
# Step 2 — Backend build & deploy (AWS SAM)
# ---------------------------------------------------------------------------
deploy_backend() {
  banner "Step 2/6 — Building & deploying the serverless backend (AWS SAM)"
  cd "$BACKEND_DIR"

  info "Running 'sam build'..."
  sam build --region "$REGION"

  if [[ -f samconfig.toml ]]; then
    info "Existing samconfig.toml detected — deploying with its saved parameters."
    sam deploy --region "$REGION" --no-confirm-changeset --no-fail-on-empty-changeset
  else
    info "No samconfig.toml found — running a guided deployment."
    info "You will be asked for: stack name, region, and the parameters AdminEmail,"
    info "SourceEmail, AdminBootstrapEmails and ReminderDays. Answer 'Y' to save these"
    info "settings to samconfig.toml so future re-deploys are non-interactive."
    sam deploy --guided --region "$REGION" --stack-name "$STACK_NAME" --capabilities CAPABILITY_IAM
  fi

  success "Backend stack '$STACK_NAME' deployed."
}

# ---------------------------------------------------------------------------
# Step 3 — Populate the third-party API key secrets (skips ones already set)
# ---------------------------------------------------------------------------

# True if the named Secrets Manager secret already holds a non-empty value —
# lets re-deploys skip the prompt entirely instead of asking every single time.
secret_is_populated() {
  local secret_id="$1" value
  value="$(aws secretsmanager get-secret-value --secret-id "$secret_id" --region "$REGION" \
    --query 'SecretString' --output text 2>/dev/null || true)"
  [[ -n "$value" && "$value" != "None" ]]
}

# Prompts for and stores one secret's value, unless it's already populated.
prompt_and_store_secret() {
  local secret_id="$1" prompt_label="$2" missing_warning="$3"

  if secret_is_populated "$secret_id"; then
    success "$secret_id is already populated — skipping (re-run 'aws secretsmanager put-secret-value' to change it)."
    return 0
  fi

  if [[ ! -t 0 ]]; then
    warn "Non-interactive shell — '$secret_id' is still empty. $missing_warning"
    return 0
  fi

  local value
  read -rp "Enter your $prompt_label (leave blank to skip for now): " value || true
  if [[ -n "${value:-}" ]]; then
    aws secretsmanager put-secret-value --secret-id "$secret_id" --secret-string "$value" --region "$REGION" >/dev/null
    success "$secret_id populated."
  else
    warn "Skipped. $missing_warning"
  fi
}

populate_secrets() {
  banner "Step 3/6 — Third-party API key secrets"

  prompt_and_store_secret "TripWiz/OpenWeatherApiKey" "OpenWeatherMap API key" \
    "Weather validation will not work until this secret is populated."
  prompt_and_store_secret "TripWiz/MappingApiKey" "mapping/geocoding provider API key" \
    "Populate it later via Secrets Manager if your deployment relies on it."
}

# ---------------------------------------------------------------------------
# Step 4 — Read stack outputs & generate frontend/src/config.js
# ---------------------------------------------------------------------------
generate_frontend_config() {
  banner "Step 4/6 — Wiring the frontend to the freshly-deployed backend"

  local outputs_json
  outputs_json="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --region "$REGION" --query "Stacks[0].Outputs" --output json)"

  out() { echo "$outputs_json" | jq -r --arg key "$1" '.[] | select(.OutputKey==$key) | .OutputValue'; }

  local user_pool_id client_id rest_api_url ws_endpoint
  user_pool_id="$(out TripWizUserPoolId)"
  client_id="$(out TripWizUserPoolClientId)"
  rest_api_url="$(out TripWizRestApiUrl)"
  ws_endpoint="$(out WebSocketEndpoint)"

  [[ -n "$user_pool_id" && -n "$client_id" && -n "$rest_api_url" && -n "$ws_endpoint" ]] \
    || die "Could not read all required CloudFormation outputs from stack '$STACK_NAME'."

  cat > "$FRONTEND_DIR/src/config.js" <<EOF
const config = {
  region: '$REGION',
  cognito: {
    userPoolId: '$user_pool_id',
    userPoolWebClientId: '$client_id',
  },
  api: {
    baseUrl: '$rest_api_url',
  },
  websocket: {
    url: '$ws_endpoint',
  },
};

export default config;
EOF

  success "Generated frontend/src/config.js from live stack outputs:"
  echo "      Cognito User Pool ID : $user_pool_id"
  echo "      Cognito Client ID    : $client_id"
  echo "      REST API URL         : $rest_api_url"
  echo "      WebSocket URL        : $ws_endpoint"
}

# ---------------------------------------------------------------------------
# Step 5 — Install dependencies & build the frontend
# ---------------------------------------------------------------------------
build_frontend() {
  banner "Step 5/6 — Installing dependencies & building the frontend"
  cd "$FRONTEND_DIR"

  info "Running 'npm ci'..."
  npm ci

  info "Running 'npm run build'..."
  npm run build

  [[ -d dist ]] || die "Build finished but 'frontend/dist' was not created — check the Vite build output above."
  success "Frontend production build ready at frontend/dist"
}

# ---------------------------------------------------------------------------
# Step 6 — Deploy the build to AWS Amplify Hosting
# ---------------------------------------------------------------------------
deploy_frontend() {
  banner "Step 6/6 — Deploying the frontend to AWS Amplify Hosting"
  cd "$FRONTEND_DIR"

  local app_id
  app_id="$(aws amplify list-apps --region "$REGION" \
    --query "apps[?name=='$AMPLIFY_APP_NAME'].appId | [0]" --output text)"

  if [[ "$app_id" == "None" || -z "$app_id" ]]; then
    info "Creating Amplify app '$AMPLIFY_APP_NAME'..."
    app_id="$(aws amplify create-app --name "$AMPLIFY_APP_NAME" --region "$REGION" \
      --query "app.appId" --output text)"
    success "Amplify app created (App ID: $app_id)"
  else
    info "Reusing existing Amplify app '$AMPLIFY_APP_NAME' (App ID: $app_id)"
  fi

  if ! aws amplify get-branch --app-id "$app_id" --branch-name "$AMPLIFY_BRANCH" --region "$REGION" &>/dev/null; then
    info "Creating branch '$AMPLIFY_BRANCH'..."
    aws amplify create-branch --app-id "$app_id" --branch-name "$AMPLIFY_BRANCH" --region "$REGION" >/dev/null
  fi

  info "Zipping the production build (dist.zip)..."
  zip_directory "$FRONTEND_DIR/dist" "$FRONTEND_DIR/dist.zip"

  info "Requesting a manual deployment slot from Amplify..."
  local deploy_json upload_url job_id
  deploy_json="$(aws amplify create-deployment --app-id "$app_id" --branch-name "$AMPLIFY_BRANCH" --region "$REGION")"
  upload_url="$(echo "$deploy_json" | jq -r '.zipUploadUrl')"
  job_id="$(echo "$deploy_json" | jq -r '.jobId')"

  info "Uploading build artifact..."
  curl -fsS -X PUT -T dist.zip "$upload_url"

  info "Starting deployment (job ID: $job_id)..."
  aws amplify start-deployment --app-id "$app_id" --branch-name "$AMPLIFY_BRANCH" \
    --job-id "$job_id" --region "$REGION" >/dev/null

  info "Waiting for the deployment to finish — this typically takes 1-3 minutes..."
  local status
  while true; do
    status="$(aws amplify get-job --app-id "$app_id" --branch-name "$AMPLIFY_BRANCH" \
      --job-id "$job_id" --region "$REGION" --query "job.summary.status" --output text)"
    case "$status" in
      SUCCEED)            success "Amplify deployment succeeded!"; break ;;
      FAILED|CANCELLED)   die "Amplify deployment ended with status '$status'. Check the build logs in the Amplify console." ;;
      *)                  echo "      ...current status: $status (checking again in 10s)"; sleep 10 ;;
    esac
  done

  local app_url="https://${AMPLIFY_BRANCH}.${app_id}.amplifyapp.com"
  echo "$app_url" > "$SCRIPT_DIR/last-deployment-url.txt"
  success "Frontend is live at: $app_url"
}

# ---------------------------------------------------------------------------
# Final summary — what AWS still requires a human to do
# ---------------------------------------------------------------------------
print_post_deploy_reminders() {
  banner "Deployment finished — a few things AWS requires a human to confirm"
  cat <<'EOF'

  1. Confirm the SNS email subscription
     Open the inbox for the AdminEmail you supplied during deployment and click the
     "Confirm subscription" link — otherwise TripWiz alert emails will never arrive.

  2. Populate any secrets you skipped in Step 3
       aws secretsmanager put-secret-value --secret-id TripWiz/OpenWeatherApiKey --secret-string "<your-key>"
       aws secretsmanager put-secret-value --secret-id TripWiz/MappingApiKey      --secret-string "<your-key>"

  3. Move Amazon SES out of the sandbox
     New AWS accounts can only email verified addresses by default. Request
     "production access" from the SES console before relying on real user emails.

  4. Enable Bedrock model access
     In the Amazon Bedrock console → Model access, enable Anthropic Claude Haiku 4.5 —
     the AI route-optimization feature will fail with an access-denied error otherwise.

  Full background on each of these is in 09/INSTALL.md and in 11/11.md
  (Folder 11 — System Administrator Manual).

EOF
}

# ---------------------------------------------------------------------------
main() {
  banner "TripWiz — Backend & Frontend Deployment"
  check_tooling
  configure_aws_credentials
  deploy_backend
  populate_secrets
  generate_frontend_config
  build_frontend
  deploy_frontend
  print_post_deploy_reminders
  banner "All done — TripWiz is deployed!"
}

main "$@"
