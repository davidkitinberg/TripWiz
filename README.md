# TripWiz

TripWiz is a serverless travel planning platform that helps users create, organize, validate, and share complete trip plans. It combines itinerary planning, interactive maps, weather-aware recommendations, travel logistics, document storage, collaboration, and admin tools in one web application.

The project is built for travelers, trip organizers, students, and teams who need more than a simple checklist. Users can plan day-by-day activities, check whether the weather fits their schedule, upload important travel documents, manage flights and accommodation details, and collaborate with others on the same trip.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [AWS Services](#aws-services)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deployment](#deployment)
- [Screenshots](#screenshots)
- [Future Improvements](#future-improvements)
- [Contributors](#contributors)

## Features

### Trip Planning

- Create, view, update, and delete trips.
- Build multi-day itineraries with scheduled stops.
- Add stop details such as location, day, time, activity type, and duration.
- Group itinerary items by day.
- Edit trip titles and metadata.

### Interactive Map

- Display trip stops on an interactive Leaflet map.
- Show day-based stop groupings.
- Calculate route geometry through AWS Location Service.
- Search for places with autocomplete support.

### Weather-Aware Planning

- Run on-demand weather validation for planned stops.
- Automatically validate upcoming trips through a scheduled Lambda.
- Use Open-Meteo forecasts to detect weather risks.
- Generate alerts for rain, heat, wind, poor visibility, beach conditions, ski conditions, and other activity-specific issues.
- Suggest nearby indoor alternatives when outdoor plans may be affected.

### Travel Logistics

The trip overview page includes structured sections for:

- Flights
- Accommodation
- Rental cars
- Trip documents
- Notes
- Packing list
- Weather alerts and fallback suggestions
- PDF and Excel export

### Documents and Attachments

- Upload PDF, PNG, JPG/JPEG, WEBP, and DOCX files.
- Store documents in S3 using presigned upload URLs.
- Attach documents to a trip, flight, accommodation, or rental car.
- Open and delete uploaded files through authenticated API requests.

### Collaboration

- Invite existing TripWiz users to collaborate on a trip.
- Manage collaborators from the trip sharing modal.
- Use WebSocket support for real-time trip editing events.
- Support signed-in read-only link sharing when enabled by the trip owner.

### AI Route Optimization

- Use Amazon Bedrock with Claude Haiku to suggest a more efficient itinerary order.
- Respect fixed travel anchors such as flights, airports, transit stops, and hotel constraints.
- Preview and apply optimized schedules from the planner.

### User Accounts

- Sign up and sign in with Amazon Cognito.
- Confirm accounts by email verification code.
- Protect private routes with authenticated sessions.
- Store profile and preference settings such as name, currency, timezone, language, and notification options.

### Admin Dashboard

Admins can:

- View platform metrics.
- Manage users.
- Block or unblock users.
- Delete users.
- View trips from the Trip Moderation table.
- Delete trips.
- Manage trending destinations shown in the user dashboard.

Admin access is enforced through the Cognito `Admins` group or a configured bootstrap admin email list.

## Architecture

TripWiz uses a React frontend and an AWS serverless backend. The frontend communicates with REST and WebSocket APIs exposed by API Gateway. Lambda functions handle application logic, DynamoDB stores application data, and supporting AWS services provide authentication, file storage, mapping, email notifications, scheduling, and AI optimization.

![TripWiz architecture](images/tripwiz-architecture.png)

### High-Level Flow

```text
React + Vite frontend
        |
        | HTTPS / WSS
        v
API Gateway REST API + WebSocket API
        |
        v
AWS Lambda functions
        |
        +-- DynamoDB for trips, users, alerts, preferences, metadata
        +-- S3 for uploaded trip documents
        +-- Cognito for authentication and admin groups
        +-- AWS Location Service for places and routes
        +-- Open-Meteo for weather forecasts
        +-- SNS / SES for alert and reminder emails
        +-- EventBridge for scheduled validation and reminders
        +-- Bedrock for AI itinerary optimization
```

### Frontend

- React single-page application built with Vite.
- React Router manages public, authenticated, and admin routes.
- API calls are centralized in `frontend/src/services/api.js`.
- Cognito authentication logic is handled in `frontend/src/services/auth.js`.
- WebSocket client logic is handled in `frontend/src/services/websocket.js`.

### Backend

- AWS SAM project using Node.js Lambda functions.
- Main REST API handler: `backend/src/rest_handlers/trips.js`.
- Weather validation handler: `backend/src/validate_lambda/index.js`.
- WebSocket handler and authorizer: `backend/src/ws_handler/` and `backend/src/ws_authorizer/`.
- Infrastructure is defined in `backend/infra/template.yaml`.

### Data Model

The backend uses a single DynamoDB table with partition and sort keys. It stores trips, access records, user preferences, weather data, alerts, fallback suggestions, WebSocket connection records, attachment metadata, and platform settings.

## Technology Stack

### Frontend

| Technology | Purpose |
| --- | --- |
| React | UI framework |
| Vite | Frontend build tool |
| React Router | Client-side routing |
| Leaflet / React Leaflet | Interactive map |
| Lucide React | Icons |
| Amazon Cognito Identity JS | Client-side authentication |
| jsPDF / jsPDF AutoTable | PDF export |
| xlsx | Excel export |

### Backend

| Technology | Purpose |
| --- | --- |
| Node.js | Lambda runtime |
| AWS SAM | Infrastructure and deployment |
| AWS SDK for JavaScript v3 | AWS service integration |
| Jest | Backend tests |
| node-fetch | External API requests |

### External APIs

| Service | Purpose |
| --- | --- |
| Open-Meteo | Weather forecasts |
| OpenStreetMap / Nominatim | Frontend place autocomplete |
| Wikipedia image API | Destination imagery |

## AWS Services

| Service | Role |
| --- | --- |
| API Gateway REST API | Exposes authenticated backend endpoints. |
| API Gateway WebSocket API | Supports real-time collaboration events. |
| Lambda | Runs backend business logic. |
| DynamoDB | Stores application data. |
| Cognito | Handles user authentication and admin groups. |
| S3 | Stores uploaded trip documents. |
| SNS | Publishes weather alert events. |
| SES | Sends alert, reminder, and invitation emails. |
| EventBridge | Runs scheduled validation and reminder jobs. |
| AWS Location Service | Provides place search and route calculation. |
| Secrets Manager | Stores mapping-service configuration placeholders. |
| Bedrock | Powers AI itinerary optimization. |
| CloudFormation / SAM | Provisions backend infrastructure. |
| Amplify Hosting | Supported through the included frontend build configuration. |

## Project Structure

```text
TripWiz/
|-- README.md
|-- README_DRAFT2.md
|-- README_draft.md
|-- WEATHER_LOGIC_DOCUMENTATION.md
|-- backend/
|   |-- README.md
|   |-- api/
|   |   `-- REST_and_WebSocket_API.md
|   |-- db/
|   |   `-- dynamodb_schema.md
|   |-- infra/
|   |   |-- template.yaml
|   |   |-- samconfig.toml
|   |   `-- trips-ses-policy.json
|   `-- src/
|       |-- lib/
|       |-- rest_handlers/
|       |-- validate_lambda/
|       |-- ws_handler/
|       |-- ws_authorizer/
|       |-- trip_reminder/
|       |-- sns_to_ses/
|       |-- post_confirmation/
|       `-- package.json
|-- frontend/
|   |-- amplify.yml
|   |-- index.html
|   |-- package.json
|   |-- vite.config.js
|   |-- public/
|   `-- src/
|       |-- App.jsx
|       |-- config.js
|       |-- components/
|       |-- data/
|       |-- pages/
|       |-- services/
|       `-- styles/
|-- images/
`-- tools/
    `-- convert_airports.py
```


## Getting Started

### Prerequisites

Install:

- Git
- Node.js 20 or newer
- npm
- AWS CLI v2
- AWS SAM CLI
- Docker, if using `sam local invoke`

You also need:

- An AWS account.
- AWS credentials configured locally.
- A verified SES sender email for email features.
- Bedrock model access enabled if using AI route optimization.

> The SAM template currently uses the Lambda runtime `nodejs24.x`. Make sure your AWS account and SAM CLI version support that runtime.

### Clone the Repository

```bash
git clone <repository-url>
cd TripWiz
```

### Install Frontend Dependencies

```bash
cd frontend
npm install
```

### Install Backend Dependencies

```bash
cd ../backend/src
npm install
```

### Run the Frontend Locally

```bash
cd frontend
npm run dev
```

Vite will print the local URL, usually:

```text
http://localhost:5173
```

### Build the Frontend

```bash
cd frontend
npm run build
```

### Preview the Frontend Build

```bash
cd frontend
npm run preview
```

## Configuration

### Frontend Configuration

The frontend configuration lives in `frontend/src/config.js`.

```js
const config = {
  region: 'us-east-1',
  cognito: {
    userPoolId: '<cognito-user-pool-id>',
    userPoolWebClientId: '<cognito-app-client-id>',
  },
  api: {
    baseUrl: 'https://<rest-api-id>.execute-api.<region>.amazonaws.com/prod',
  },
  websocket: {
    url: 'wss://<websocket-api-id>.execute-api.<region>.amazonaws.com/prod',
  },
};

export default config;
```

Do not place AWS access keys, passwords, or private credentials in this file.

### Backend Parameters

SAM deployment parameters are defined in `backend/infra/template.yaml`.

| Parameter | Description |
| --- | --- |
| `AdminEmail` | Email address that receives alert emails. |
| `SourceEmail` | SES-verified sender email address. |
| `AdminBootstrapEmails` | Comma-separated list of initial admin emails. |
| `ReminderDays` | Number of days before a trip to send reminders. |
| `FrontendUrl` | Public frontend URL used in emails. |

Example placeholder values:

```text
AdminEmail=admin@example.com
SourceEmail=no-reply@example.com
AdminBootstrapEmails=admin@example.com
ReminderDays=2
FrontendUrl=https://example.com
```

## Testing

Backend tests are implemented with Jest.

```bash
cd backend/src
npm test
```

The frontend package does not currently define a test script. Use the production build as a basic verification step:

```bash
cd frontend
npm run build
```

## Deployment

### Backend

Validate and build the SAM application:

```bash
cd backend
sam validate --template-file infra/template.yaml --region us-east-1
sam build --template-file infra/template.yaml --region us-east-1
```

Deploy with guided setup:

```bash
sam deploy --guided --template-file infra/template.yaml --region us-east-1
```

After deployment, copy the stack outputs into `frontend/src/config.js`:

- REST API URL
- WebSocket endpoint
- Cognito User Pool ID
- Cognito User Pool Client ID

### Frontend

The frontend is a static Vite application. The repository includes `frontend/amplify.yml` for AWS Amplify Hosting:

```yaml
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: dist
```

The SAM template does not currently provision frontend hosting. The built `frontend/dist/` folder can be hosted with AWS Amplify or another static hosting provider.



## Contributors

- Amit Bitton
- David Kitinberg
- Sagi Hassid
