# Notes for SAM Deploy

- SAM and AWS CLI are installed on this machine but may not be on PATH. Direct paths:
  - `C:\Program Files\Amazon\AWSSAMCLI\bin\sam.cmd`
  - `C:\Program Files\Amazon\AWSCLIV2\aws.exe`
- Set `$env:SAM_CLI_TELEMETRY = '0'`, `$env:AWS_SAM_CLI_TELEMETRY = '0'`, and `$env:APPDATA = (Resolve-Path '.sam-appdata').Path` from `backend/` before SAM commands to avoid metadata path issues with the Windows user profile.
- AWS credentials are not configured yet. Run `aws configure` or the full-path equivalent before deploy.
- The stack creates the Cognito User Pool and User Pool Client required by the frontend.
- The stack creates the REST API, WebSocket API, Lambda handlers, DynamoDB table, Secrets Manager placeholders, EventBridge schedule, and SNS email alert subscription.
- After deploy, populate `TripWiz/OpenWeatherApiKey` and `TripWiz/MappingApiKey` in Secrets Manager.
- Confirm the SNS email subscription sent to `AdminEmail`.
- WebSocket clients must pass a Cognito access token as `?token=...` during `$connect`.
