# TripWiz

A serverless, AI-powered travel planning platform. Users build multi-stop trip itineraries, get real-time weather validation, collaborate in real time, and receive smart daily reminders. Admins manage the platform through a dedicated dark-theme dashboard.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [AWS Services](#aws-services)
3. [External APIs & Dependencies](#external-apis--dependencies)
4. [Feature Status](#feature-status)
5. [Project Structure](#project-structure)
6. [Collaborator Setup Guide](#collaborator-setup-guide)
7. [Running Locally](#running-locally)
8. [Deploying Online (AWS)](#deploying-online-aws)
9. [Environment Variables & Configuration](#environment-variables--configuration)
10. [Admin Portal](#admin-portal)
11. [Data Model](#data-model)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   React Frontend                     │
│         (Vite · React Router · Leaflet)              │
│  Hosted via S3 + CloudFront  /  or  localhost:5174   │
└──────────────────┬──────────────────────────────────┘
                   │ HTTPS / WSS
        ┌──────────┴──────────┐
        │                     │
   REST API Gateway      WebSocket API Gateway
   (prod stage)          (prod stage)
        │                     │
   ┌────┴──────┐        ┌─────┴──────────┐
   │ TripWiz-  │        │ WebSocket      │
   │ Trips     │        │ Handler Lambda │
   │ Lambda    │        │ + Authorizer   │
   └────┬──────┘        └─────────────── ┘
        │
   ┌────┴──────────────────────────────────────┐
   │              DynamoDB                      │
   │    Single table — PK/SK + GSI1            │
   └────────────────────────────────────────────┘
        │
   ┌────┴──────────────────────────────────────┐
   │           Supporting Lambdas               │
   │  TripWiz-Validate  (EventBridge nightly)  │
   │  TripWiz-TripReminder (cron 8am UTC)      │
   │  TripWiz-SnsToSes  (SNS → SES emails)    │
   └────────────────────────────────────────────┘
```

**Key flows:**

| Flow | Path |
|---|---|
| User auth | Cognito SRP → JWT → API Gateway Cognito authorizer |
| Trip CRUD | Frontend → REST API → Lambda → DynamoDB |
| Weather alerts | Validate Lambda → Open-Meteo → SNS → SES |
| AI optimization | Lambda → AWS Bedrock (Claude Haiku) |
| Real-time collab | Frontend WebSocket → WS API Gateway → WS Handler Lambda → DynamoDB |
| Daily reminders | EventBridge cron → TripReminder Lambda → DynamoDB → SES |
| Place search | Lambda → AWS Location Service (Esri) |

---

## AWS Services

| Service | Resource(s) | Purpose |
|---|---|---|
| **Lambda** | 6 functions | REST API, WebSocket, validation, reminders, SNS→SES |
| **DynamoDB** | `TripWizTable` (on-demand) | All application data — single table |
| **API Gateway (REST)** | `TripWizApi` prod | HTTP REST endpoints with Cognito auth |
| **API Gateway (WebSocket)** | `TripWizWebSocketApi` prod | Real-time collaborative editing |
| **Cognito** | User Pool + Client + Admins group | Authentication & role-based access |
| **AWS Location Service** | Place Index + Route Calculator (Esri) | Geocoding and route calculation |
| **SNS** | `TripWiz-Alerts` topic | Publishes weather alerts |
| **SES** | Verified sender email | Sends alert emails and trip reminders |
| **Secrets Manager** | 2 secrets | API key storage |
| **Bedrock** | Claude Haiku (`claude-haiku-4-5-20251001`) | AI trip route optimization |
| **EventBridge** | 2 scheduled rules | Nightly validation + daily reminders |
| **CloudFormation / SAM** | `tripwiz` stack | All infra as code |
| **IAM** | Roles + inline policies | Least-privilege Lambda permissions |

All infrastructure is defined in `backend/infra/template.yaml` and deployed with AWS SAM.

---

## External APIs & Dependencies

| API / Library | Provider | Cost | Purpose |
|---|---|---|---|
| **Open-Meteo** | Free, no key required | Free | 16-day weather forecasts (WMO codes) |
| **Claude Haiku** | AWS Bedrock (pay per token) | ~$0.001/request | Trip itinerary optimization |
| **Esri (via AWS Location)** | AWS (pay per request) | Low | Place search & route calculation |
| **Leaflet** | Open source | Free | Interactive map rendering |
| **Amazon Cognito Identity JS** | AWS SDK (open source) | Free (Cognito pricing applies) | Client-side SRP authentication |

**No third-party API keys are needed in the frontend.** All keys are stored in AWS Secrets Manager and accessed by Lambda at runtime.

---

## Feature Status

### ✅ Fully Implemented

- **User authentication** — sign up, email verification, sign in, sign out (Cognito SRP)
- **Trip CRUD** — create, edit, delete multi-stop trips with itinerary slots
- **Interactive map** — Leaflet map with stop markers, route lines, day groupings
- **Route calculation** — actual road/path distances via AWS Location (Esri)
- **Place search** — autocomplete via AWS Location with location bias
- **Weather validation** — nightly Lambda checks Open-Meteo forecasts for every upcoming trip stop
  - Context-aware categories: SKI / BEACH / INDOOR / GENERAL_OUTDOOR
  - Specific thresholds per category (heat, rain probability, wind, snow conditions)
  - Descriptive alert messages per weather condition
- **Weather alerts** — stored in DynamoDB, shown per trip stop in the UI
- **Fallback activities** — Lambda searches for indoor alternatives (museums, malls, cinemas) when weather is bad
- **AI route optimization** — Bedrock / Claude Haiku reorders daily stops intelligently, respects fixed times (airports, hotels)
- **Real-time collaboration** — WebSocket API with room-based editing; multiple users can edit the same trip simultaneously
- **Trip invitations** — invite collaborators by email; shared access in DynamoDB
- **User preferences** — name, currency, timezone, language, notification toggles — persisted to DynamoDB
- **Trip reminder emails** — daily Lambda sends branded HTML reminders via SES for trips starting within 2 days
- **SNS → SES pipeline** — alert topic subscribers receive formatted emails
- **Admin portal (dark dashboard)**
  - Overview metrics: total users, total trips, active trips, 7-day activity chart, top destinations rings
  - Live activity feed (user registrations + trip creations with owner email)
  - User management: suspend/unsuspend, promote/demote admin role, delete account + all data
  - Trip moderation: search, preview itinerary, hide/unhide, delete
  - Platform settings: edit trending destinations (city, country, tag, emoji) shown on all user dashboards
- **Admin identity** — dual mechanism: Cognito `Admins` group (JWT-carried) OR email whitelist bootstrap

### 🔶 Partially Implemented / Needs More Work

- **SES email verification** — the Lambda infrastructure exists and sends correctly, but the SES sender domain must be manually verified in the AWS console for each deployment region. New collaborators need to do this step.
- **Notification preferences UI** — the toggle exists in Account Settings and is persisted to DynamoDB, but there is no UI feedback confirming that the backend saved successfully (errors are silently swallowed).
- **WebSocket collaboration UI** — the WebSocket connection and room join/leave/edit/cursor events are wired in the backend. The frontend connects but the live cursor and presence indicators are not yet visually rendered on the trip editor page.
- **Fallback activity UI** — the backend fetches and stores fallback indoor alternatives in DynamoDB. The data is fetchable via `GET /trips/{tripId}/fallbacks` but there is no frontend component that displays these suggestions yet.
- **Trip weather panel** — `GET /trips/{tripId}/weather` is implemented in the backend but the frontend trip editor does not have a dedicated weather panel to display the per-stop forecasts (alerts are shown, raw forecast data is not).
- **Trending destinations — dynamic loading** — `TripsPage.jsx` currently uses a hardcoded `INSPIRATION` array as a fallback. The API call to `GET /trending` exists in `api.js` but the page has not been wired to load dynamically from the backend (AdminTrendingPage writes to DynamoDB; TripsPage should read it).
- **Admin metrics real-time refresh** — metrics are fetched once on page load; there is no polling or WebSocket-driven refresh.

### ❌ Not Yet Implemented

- **Frontend hosting** — no S3 bucket or CloudFront distribution is defined in `template.yaml`. The frontend is currently only served locally via Vite dev server or built and served manually.
- **Email invite acceptance flow** — collaborators are added by the owner calling `POST /trips/{tripId}/invite`. There is no email sent to the invited user and no "accept invitation" link or UI.
- **Password reset** — no forgot-password flow in the login UI. Cognito supports it but the frontend form has not been built.
- **MFA / 2FA** — not configured in Cognito or the frontend.
- **Trip sharing (public link)** — trips are private or collaborator-only; there is no public share URL.
- **Audit log** — admin actions (delete user, hide trip, promote) are not logged anywhere.
- **Pagination UI** — the admin Users and Trips tables load up to 60 records. There is no "load more" button or page navigation.
- **Push notifications** — the SNS topic is email-only; no mobile push or browser push configured.
- **Trip export** — no PDF, iCal, or share format for completed itineraries.
- **Billing / subscription tiers** — the app has no payment integration.

---

## Project Structure

```
TripWiz/
├── backend/
│   ├── infra/
│   │   ├── template.yaml        # SAM / CloudFormation — all AWS resources
│   │   └── samconfig.toml       # SAM CLI defaults (region, stack name, params)
│   └── src/
│       ├── rest_handlers/
│       │   └── trips.js         # Single Lambda — all REST routes
│       ├── validate_lambda/
│       │   └── index.js         # Nightly weather validation Lambda
│       ├── trip_reminder/
│       │   └── index.js         # Daily reminder email Lambda
│       ├── ws_handler/
│       │   └── index.js         # WebSocket message handler Lambda
│       ├── ws_authorizer/
│       │   └── index.js         # WebSocket token authorizer Lambda
│       └── sns_to_ses/
│           └── index.js         # Converts SNS alerts → SES emails
└── frontend/
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── App.jsx              # Root component — all routes defined here
        ├── config.js            # Cognito IDs, API URL, WebSocket URL
        ├── pages/
        │   ├── HomePage.jsx
        │   ├── LoginPage.jsx
        │   ├── TripsPage.jsx
        │   ├── TripPage.jsx          # Single trip editor (map, itinerary, collab)
        │   ├── AccountSettings.jsx
        │   ├── AdminLoginPage.jsx
        │   ├── AdminOverviewPage.jsx
        │   ├── AdminUsersPage.jsx
        │   ├── AdminTripsPage.jsx
        │   ├── AdminTrendingPage.jsx
        │   └── UnauthorizedPage.jsx
        ├── components/
        │   ├── AdminLayout.jsx   # Admin sidebar + outlet
        │   ├── AdminRoute.jsx    # Route guard (admin check)
        │   └── TripMap.jsx       # Leaflet map component
        └── services/
            ├── api.js            # All backend API calls
            ├── auth.js           # Cognito auth functions
            └── admin.js          # Admin identity check (JWT decode)
```

---

## Collaborator Setup Guide

### Prerequisites

Install these tools before cloning:

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20.x | https://nodejs.org |
| npm | ≥ 10.x | bundled with Node |
| AWS CLI | ≥ 2.x | https://aws.amazon.com/cli/ |
| AWS SAM CLI | ≥ 1.120.x | https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html |
| Git | any | https://git-scm.com |

### Step 1 — Clone the repository

```bash
git clone <repo-url>
cd TripWiz
```

### Step 2 — Install frontend dependencies

```bash
cd frontend
npm install
```

### Step 3 — Configure AWS credentials

The backend and all AWS services require credentials. Run:

```bash
aws configure
```

Enter:
- AWS Access Key ID
- AWS Secret Access Key
- Default region: `us-east-1`
- Default output: `json`

> The IAM user or role must have permissions for: Lambda, DynamoDB, API Gateway, Cognito, CloudFormation, SAM (S3 for artifacts), Location Service, SNS, SES, Secrets Manager, Bedrock, EventBridge, IAM.
> For development, `AdministratorAccess` on a non-production account is the simplest option.

### Step 4 — Configure SAM deployment parameters

Open `backend/infra/samconfig.toml` and update:

```toml
[default.deploy.parameters]
parameter_overrides = "AdminEmail=\"your@email.com\" SourceEmail=\"your-verified-ses@email.com\" AdminBootstrapEmails=\"your@email.com\""
```

| Parameter | Description |
|---|---|
| `AdminEmail` | Email that receives platform alert notifications |
| `SourceEmail` | SES-verified "From" address for all outbound emails |
| `AdminBootstrapEmails` | Comma-separated list of admin emails (no Cognito group needed initially) |

### Step 5 — Verify your SES sender email

Before deploying, verify your `SourceEmail` in SES:

```bash
aws ses verify-email-identity --email-address your-verified-ses@email.com --region us-east-1
```

Check your inbox and click the verification link. The Lambda will fail to send emails until this is done.

> If your AWS account is in SES sandbox mode, you must also verify every **recipient** email. To send to arbitrary addresses, [request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

### Step 6 — Deploy the backend

```bash
cd backend/infra
sam build
sam deploy
```

SAM will create the full `tripwiz` CloudFormation stack. After deploy completes, note the **Outputs** section — it contains:
- `TripWizApiUrl` — the REST API base URL
- `TripWizWebSocketUrl` — the WebSocket URL
- `TripWizUserPoolId` — Cognito user pool ID
- `TripWizUserPoolClientId` — Cognito web client ID

### Step 7 — Update frontend config

Open `frontend/src/config.js` and paste the values from the SAM outputs:

```js
export const config = {
  region: 'us-east-1',
  cognito: {
    userPoolId: 'us-east-1_XXXXXXXXX',      // ← TripWizUserPoolId
    userPoolWebClientId: 'XXXXXXXXXXXXXXXXX', // ← TripWizUserPoolClientId
  },
  api: {
    baseUrl: 'https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',  // ← TripWizApiUrl
  },
  websocket: {
    url: 'wss://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',  // ← TripWizWebSocketUrl
  },
};
```

### Step 8 — Bootstrap your admin account

Sign up via the app first (so a Cognito user is created), then add yourself to the Admins group:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id us-east-1_XXXXXXXXX \
  --username your@email.com \
  --group-name Admins \
  --region us-east-1
```

Sign out and sign back in — your JWT will now carry `cognito:groups: ["Admins"]`.

---

## Running Locally

The frontend runs locally against the **live deployed AWS backend**. There is no local backend emulation configured.

```bash
cd frontend
npm run dev
```

The app is served at **http://localhost:5174**

> Make sure `frontend/src/config.js` points to your deployed API Gateway and Cognito pool (Step 7 above). The dev server proxies nothing — all API calls go directly to AWS.

### Available npm scripts

| Script | Command | Description |
|---|---|---|
| Dev server | `npm run dev` | Start Vite HMR dev server on port 5174 |
| Build | `npm run build` | Production build to `frontend/dist/` |
| Preview | `npm run preview` | Serve the built `dist/` locally |

---

## Deploying Online (AWS)

### Backend — already live after `sam deploy`

The REST API, WebSocket API, and all Lambdas are immediately live after `sam deploy`. The API Gateway URLs are the public endpoints.

### Frontend — hosting options

The frontend `dist/` folder (built with `npm run build`) is a static site. Two common options:

#### Option A — S3 + CloudFront (recommended)

```bash
# Build
cd frontend && npm run build

# Create bucket (one time)
aws s3 mb s3://tripwiz-frontend-prod --region us-east-1

# Enable static website hosting
aws s3 website s3://tripwiz-frontend-prod --index-document index.html --error-document index.html

# Upload
aws s3 sync dist/ s3://tripwiz-frontend-prod --delete

# (Optional) Create CloudFront distribution pointing to the bucket for HTTPS + CDN
```

Then set the bucket policy to allow public reads, or use a CloudFront OAC for private-bucket access.

> ⚠️ The `template.yaml` does **not** yet define the S3 bucket or CloudFront distribution. These must be created manually or added to the template.

#### Option B — Any static host

Because the frontend is a pure React SPA with no server-side rendering, it can be deployed to:
- **Vercel** — connect repo, set build command `npm run build`, output dir `dist`
- **Netlify** — same settings, add a `_redirects` file with `/* /index.html 200` for client-side routing
- **GitHub Pages** — works with `gh-pages` package

No environment variables are needed at build time — all config lives in `config.js` which is committed to the repo.

### Redeploying after backend changes

```bash
cd backend/infra
sam build && sam deploy --no-confirm-changeset
```

For Lambda-only changes (no infra changes), you can redeploy faster:

```bash
sam build && sam deploy --no-confirm-changeset
```

SAM detects which resources changed and only updates those.

---

## Environment Variables & Configuration

### Frontend — `frontend/src/config.js`

| Key | Description |
|---|---|
| `region` | AWS region (e.g. `us-east-1`) |
| `cognito.userPoolId` | Cognito User Pool ID |
| `cognito.userPoolWebClientId` | Cognito App Client ID |
| `api.baseUrl` | REST API Gateway base URL (no trailing slash) |
| `websocket.url` | WebSocket API Gateway URL (`wss://...`) |

> There are no `.env` files. Config is in `config.js` which is checked in. Do not commit real credentials here — these are public-facing IDs (Cognito pool IDs are safe to expose; the actual secrets are in Secrets Manager).

### Backend — SAM parameters (`samconfig.toml` / `sam deploy`)

| Parameter | Default | Description |
|---|---|---|
| `AdminEmail` | (required) | Receives platform alert notifications |
| `SourceEmail` | (required) | SES-verified "From" address for all emails |
| `AdminBootstrapEmails` | `davidkitinberg@gmail.com` | Comma-separated admin email whitelist |
| `ReminderDays` | `2` | Days before trip start to send reminder email |

### Backend — AWS Secrets Manager (populated post-deploy)

| Secret | Key | Description |
|---|---|---|
| `TripWiz/OpenWeatherApiKey` | `apiKey` | Reserved — Open-Meteo is free and requires no key |
| `TripWiz/MappingApiKey` | `apiKey` | Reserved for future mapping service upgrade |

These secrets are created by the SAM template but their values must be set manually if used:

```bash
aws secretsmanager put-secret-value \
  --secret-id TripWiz/OpenWeatherApiKey \
  --secret-string '{"apiKey":"your-key-here"}' \
  --region us-east-1
```

### Backend — Lambda environment variables (set by SAM automatically)

These are injected by CloudFormation and do not need manual configuration:

| Variable | Source |
|---|---|
| `TABLE_NAME` | DynamoDB table name (from `!Ref TripWizTable`) |
| `USER_POOL_ID` | Cognito pool ID |
| `ALERTS_TOPIC_ARN` | SNS topic ARN |
| `WS_ENDPOINT` | WebSocket API management endpoint |
| `PLACE_INDEX_NAME` | `TripWizPlaceIndex` |
| `ROUTE_CALCULATOR_NAME` | `TripWizRouteCalculator` |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `ADMIN_EMAILS` | From `AdminBootstrapEmails` parameter |
| `SOURCE_EMAIL` | From `SourceEmail` parameter |
| `ADMIN_EMAIL` | From `AdminEmail` parameter |
| `REMINDER_DAYS` | From `ReminderDays` parameter |

---

## Admin Portal

The admin portal is accessible at `/admin-login` (a discreet link appears at the bottom of the home page).

**Access:** A user is treated as admin if **either** is true:
1. Their Cognito JWT contains `cognito:groups: ["Admins"]` (managed via AWS console or the Users page promote/demote action)
2. Their email is in the `ADMIN_EMAILS` env var (bootstrap path — no group needed)

**Admin capabilities:**

| Section | Route | What you can do |
|---|---|---|
| Overview | `/admin` | Platform metrics, 7-day activity chart, top destinations, live activity feed |
| User Management | `/admin/users` | View all users, suspend/unsuspend, promote/demote admin, delete accounts |
| Trip Moderation | `/admin/trips` | Search all trips, preview itinerary, hide/unhide, delete |
| Platform Settings | `/admin/trending` | Edit the 4 trending destinations shown on every user's dashboard |

**Security:** The frontend `AdminRoute` guard blocks UI access. Every admin API endpoint independently calls `requireAdmin(event)` in the Lambda — frontend-level blocking alone is bypassable via direct API calls.

---

## Data Model

All data lives in a single DynamoDB table using a PK/SK pattern.

| Entity | PK | SK | Notes |
|---|---|---|---|
| Trip | `TRIP#<tripId>` | `METADATA` | Title, dates, itinerary, ownerId |
| Trip (GSI) | GSI1PK=`TRIP` | GSI1SK=`<tripStart>` | Allows querying all trips by start date |
| Trip access | `TRIP#<tripId>` | `ACCESS#<userId>` | Collaborator membership |
| Trip pointer | `USER#<userId>` | `TRIPPTR#<tripId>` | Owner's index into their trips |
| User prefs | `USER#<userId>` | `PREFS` | Name, currency, timezone, notification flags, email |
| Weather alert | `TRIP#<tripId>` | `ALERT#<timestamp>` | Weather alert, TTL 7 days |
| Weather data | `TRIP#<tripId>` | `WEATHER#<stopId>` | Raw forecast cache, TTL 7 days |
| Fallback | `TRIP#<tripId>` | `FALLBACK#<stopId>` | Indoor alternative suggestions, TTL 7 days |
| WS connection | `CONN#<connId>` | `META` | WebSocket connection → trip mapping |
| Trending | `SETTINGS` | `TRENDING` | Array of 4 destination objects |

---

## Quick Reference — Common Commands

```bash
# Start frontend dev server
cd frontend && npm run dev

# Build frontend for production
cd frontend && npm run build

# Deploy backend (build + deploy)
cd backend/infra && sam build && sam deploy

# Deploy backend without confirmation prompt
cd backend/infra && sam build && sam deploy --no-confirm-changeset

# View deployed stack outputs
aws cloudformation describe-stacks --stack-name tripwiz --query "Stacks[0].Outputs" --region us-east-1

# Add a user to the Admins group
aws cognito-idp admin-add-user-to-group --user-pool-id <poolId> --username <email> --group-name Admins --region us-east-1

# Verify SES email address
aws ses verify-email-identity --email-address <email> --region us-east-1

# Invoke validate Lambda manually (for testing)
aws lambda invoke --function-name TripWiz-Validate --payload '{}' response.json --region us-east-1

# Invoke reminder Lambda manually
aws lambda invoke --function-name TripWiz-TripReminder --payload '{}' response.json --region us-east-1

# Tail Lambda logs
aws logs tail /aws/lambda/TripWiz-Trips --follow --region us-east-1
```
