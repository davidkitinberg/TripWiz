# TripWiz Backend (SAM)

This folder contains the AWS SAM backend for the TripWiz serverless POC.

## Validate and Build

From `backend/`:

```powershell
sam validate --template-file infra\template.yaml --region us-east-1
sam build --template-file infra\template.yaml --region us-east-1
```

If `sam` is installed but not on PATH in PowerShell, use:

```powershell
$env:SAM_CLI_TELEMETRY = '0'
$env:AWS_SAM_CLI_TELEMETRY = '0'
$env:APPDATA = (Resolve-Path '.sam-appdata').Path
& 'C:\Program Files\Amazon\AWSSAMCLI\bin\sam.cmd' validate --template-file infra\template.yaml --region us-east-1
& 'C:\Program Files\Amazon\AWSSAMCLI\bin\sam.cmd' build --template-file infra\template.yaml --region us-east-1
```

Using the local `.sam-appdata` folder avoids SAM metadata issues on Windows profiles with non-ASCII characters.

## Deploy

Configure AWS credentials first:

```powershell
aws configure
aws sts get-caller-identity
```

If `aws` is installed but not on PATH:

```powershell
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' configure
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' sts get-caller-identity
```

Then deploy:

```powershell
sam deploy --guided --region us-east-1
```

Use the direct SAM path if needed:

```powershell
$env:SAM_CLI_TELEMETRY = '0'
$env:AWS_SAM_CLI_TELEMETRY = '0'
$env:APPDATA = (Resolve-Path '.sam-appdata').Path
& 'C:\Program Files\Amazon\AWSSAMCLI\bin\sam.cmd' deploy --guided --region us-east-1
```

## Pre-Deploy Notes

- Provide `AdminEmail` during `sam deploy --guided`; the stack creates an SNS email subscription for TripWiz alerts.
- Confirm the SNS subscription email after deployment, or alerts will not be delivered.
- After stack creation, populate Secrets Manager entries `TripWiz/OpenWeatherApiKey` and `TripWiz/MappingApiKey`.
- WebSocket clients should connect with a Cognito access token as `?token=...`.
- Review IAM policies before production.

## Local Test

```powershell
npm test --prefix src
sam local invoke ValidateLambdaFunction --event src\validate_lambda\test-event.json
```
