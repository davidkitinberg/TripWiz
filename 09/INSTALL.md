# TripWiz — Folder 09: Source Code & Installation

**Team:** TripWiz — Ariel University · David Kitinberg, Amit Bitton, Sagi Hassid

This folder contains two automated entry points that take a clean AWS account from
zero to a fully running TripWiz deployment (backend + frontend):

* **[`setup.sh`](setup.sh)** — prepares the local machine: installs/checks all
  required tooling. Touches nothing in AWS.
* **[`deploy.sh`](deploy.sh)** — does the actual work: configures AWS credentials,
  builds & deploys the backend, wires up the frontend, builds it, and deploys it to
  AWS Amplify Hosting.

Keeping them separate means you can re-run `deploy.sh` as often as you like during
development (every code change → one command) without repeating the one-time
environment setup.

---

## 1. What you need before you start

* A **bash shell** — Linux, macOS, Windows Subsystem for Linux (WSL), or Git Bash on
  Windows. Both scripts are plain Bash and do not depend on any particular OS package
  manager (they will try to auto-install missing tools, but fall back to clear manual
  instructions if they can't).
* An **AWS account** with permissions to create the full set of resources declared in
  [`backend/infra/template.yaml`](../backend/infra/template.yaml) (IAM, Lambda, API
  Gateway, DynamoDB, Cognito, S3, Bedrock, Location Service, SES, SNS, EventBridge,
  Secrets Manager, Amplify, CloudWatch). `AdministratorAccess` is the simplest option
  for a first deployment.
* (Recommended, not required) An **OpenWeatherMap API key** and a **mapping/geocoding
  provider API key** — `deploy.sh` will offer to store these for you, or you can add
  them afterwards.

---

## 2. Running it — two steps

From the repository root:

```bash
# One-time: install/verify all required local tooling
chmod +x 09/setup.sh
./09/setup.sh

# Build & deploy everything to AWS (re-run any time you ship a change)
chmod +x 09/deploy.sh
./09/deploy.sh
```

Both scripts resolve all paths relative to their own location, so they can be run from
any working directory. `deploy.sh` refuses to start if any required tool is missing —
run `setup.sh` first.

---

## 3. `setup.sh` — environment preparation

Installs/checks for everything the deployment needs, and **makes no AWS calls**:

| Step | What happens |
|------|-------------|
| **1. Node.js & npm** | Required to build the React/Vite frontend. Installed via `brew`/`apt-get` if missing. |
| **2. AWS CLI v2** | Required for all AWS interaction (credentials, stack inspection, Amplify uploads). Installed via the official installers if missing. |
| **3. AWS SAM CLI** | Required to build and deploy the serverless backend. Installed via `pip3` if missing. |
| **4. Supporting tools** | `jq` (parsing AWS CLI JSON output) and `curl` (uploading to Amplify) — plus `zip`/`unzip` (packaging the frontend build for Amplify) on Linux/macOS. On Windows, `deploy.sh` packages the build with PowerShell's built-in `Compress-Archive` instead, since Git Bash has no package manager and AWS ships no official Windows `zip` binary. |

Wherever a tool can't be auto-installed (e.g. no supported package manager is found),
the script prints a direct install link and stops — re-run it once that tool is on
your `PATH`.

---

## 4. `deploy.sh` — build & deploy

Performs the actual deployment, in order:

| Step | What happens |
|------|-------------|
| **1. AWS credentials** | Runs `aws sts get-caller-identity`; if it fails, launches `aws configure` and re-checks. |
| **2. Backend deploy** | Runs `sam build` then `sam deploy` against [`backend/infra/template.yaml`](../backend/infra/template.yaml). On a first run (no `samconfig.toml`) it uses `sam deploy --guided`, which walks you through the stack parameters (`AdminEmail`, `SourceEmail`, `AdminBootstrapEmails`, `ReminderDays`) and offers to save them for non-interactive re-deploys. |
| **3. API key secrets** | Checks whether `TripWiz/OpenWeatherApiKey` and `TripWiz/MappingApiKey` already hold a value in Secrets Manager — if so, it skips them silently (no re-prompting on every redeploy). Only prompts for, and writes via `aws secretsmanager put-secret-value`, the ones that are still empty. |
| **4. Frontend wiring** | Reads the live CloudFormation stack outputs (Cognito User Pool ID, App Client ID, REST API URL, WebSocket endpoint) and **regenerates [`frontend/src/config.js`](../frontend/src/config.js)** so the frontend points at your new backend — no manual copy-pasting of IDs and URLs. |
| **5. Frontend build** | Runs `npm ci` and `npm run build` inside `frontend/`, producing the production bundle in `frontend/dist`. |
| **6. Frontend deploy** | Creates (or reuses) an AWS Amplify Hosting app and a `main` branch, zips `frontend/dist`, uploads it through Amplify's manual-deployment API, starts the deployment, polls until it succeeds, and prints the live `https://main.<app-id>.amplifyapp.com` URL (also saved to `09/last-deployment-url.txt`). |

Both scripts print clearly-labelled `[INFO]` / `[ OK ]` / `[WARN]` / `[FAIL]` messages
and stop immediately (via `set -euo pipefail` and an error trap) on the first command
that fails, so you always know exactly which step needs attention.

> **Why Amplify and not an S3/CloudFront upload?** TripWiz's frontend is hosted on
> **AWS Amplify Hosting** (see [`frontend/amplify.yml`](../frontend/amplify.yml) and
> Folder 06's cost breakdown) rather than a static S3 bucket behind CloudFront.
> `deploy.sh` therefore performs an Amplify **manual deployment** — functionally the
> same "build once, upload, go live" automation the task calls for, just using the API
> that matches our actual hosting architecture.

---

## 5. Steps that AWS requires a human to complete

A few actions inherently require a person to click a link or approve a request — they
cannot be scripted on a brand-new account, and `deploy.sh` prints a reminder for each
at the end of its run:

1. **Confirm the SNS email subscription** — AWS emails a "Confirm subscription" link
   to the `AdminEmail` address you provided; alerts will not be delivered until you
   click it.
2. **Populate any secrets you skipped** — if you didn't provide your OpenWeatherMap
   or mapping-provider API keys during Step 3, add them afterwards:
   ```bash
   aws secretsmanager put-secret-value --secret-id TripWiz/OpenWeatherApiKey --secret-string "<your-key>"
   aws secretsmanager put-secret-value --secret-id TripWiz/MappingApiKey      --secret-string "<your-key>"
   ```
3. **Request SES production access** — new AWS accounts start in the SES sandbox,
   which can only email *verified* addresses. Request production access from the SES
   console before relying on real user-facing emails.
4. **Enable Bedrock model access** — in the Amazon Bedrock console under **Model
   access**, grant access to **Anthropic Claude Haiku 4.5**; without this, the AI
   route-optimization feature fails with an access-denied error.

Full operational detail on each of these (including which console page to use and what
to check) is documented in **[`11.md`](../11/11.md)** (Folder 11 — System Administrator
Manual), Sections 6.1, 7.1, 7.2, and 8.

---

## 6. Re-running the scripts

Both scripts are **idempotent**:

* Re-running `setup.sh` simply re-checks tooling and skips anything already installed.
* Re-running `deploy.sh` will skip credential setup (already verified), run
  `sam deploy` non-interactively using the saved `samconfig.toml`, regenerate
  `frontend/src/config.js` from the (possibly updated) stack outputs, rebuild the
  frontend, and push a new Amplify deployment to the same app/branch.

This makes `deploy.sh` equally suitable as the first-time installer step and as a
day-to-day build-and-redeploy command for ongoing development — just `git pull` and
run it again.
