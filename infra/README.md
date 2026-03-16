# Autopod Infrastructure

Azure deployment using Bicep templates. Deploys the daemon as a Container App with ACR, Key Vault, Managed Identity, and Log Analytics.

## Prerequisites

- Azure CLI (`az`) with Bicep support
- A resource group (`autopod-dev-rg` / `autopod-prod-rg`)
- GitHub repo with OIDC configured for Azure

## Quick Deploy

```bash
# Validate templates
az bicep build --file infra/main.bicep

# Dry run
az deployment group what-if \
  --resource-group autopod-dev-rg \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam

# Deploy
az deployment group create \
  --resource-group autopod-dev-rg \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam
```

## Post-Deploy: Seed Key Vault Secrets

Secrets are **not** stored in Bicep — set them manually after the first deploy:

```bash
az keyvault secret set --vault-name autopod-dev-kv --name anthropic-api-key --value <value>
az keyvault secret set --vault-name autopod-dev-kv --name openai-api-key --value <value>
az keyvault secret set --vault-name autopod-dev-kv --name github-pat --value <value>
az keyvault secret set --vault-name autopod-dev-kv --name teams-webhook-url --value <value>
```

## Entra ID Setup (Manual)

Entra ID app registration cannot be fully automated with Bicep. Follow these steps once per tenant.

### 1. Create App Registration

```bash
az ad app create --display-name "Autopod" \
  --sign-in-audience "AzureADMyOrg" \
  --web-redirect-uris "http://localhost:3000/auth/callback"
```

### 2. Add App Roles

In the Azure Portal, navigate to **App registrations > Autopod > App roles** and create:

| Display Name | Value    | Allowed Member Types |
|-------------|----------|---------------------|
| Admin       | admin    | Users               |
| Operator    | operator | Users               |
| Viewer      | viewer   | Users               |

### 3. API Permissions

Add `User.Read` (delegated) under **API permissions**.

### 4. Client Secret

Create a client secret and store it in Key Vault:

```bash
az keyvault secret set --vault-name autopod-dev-kv --name entra-client-secret --value <secret-value>
```

### 5. Assign Users

In **Enterprise Applications > Autopod > Users and groups**, assign app roles to users/groups.

### 6. Update Daemon Config

Set these environment variables on the Container App (or add to Bicep env vars):

```bash
ENTRA_CLIENT_ID=<app-registration-client-id>
ENTRA_TENANT_ID=<your-tenant-id>
```

## GitHub Actions OIDC Setup

Configure federated credentials so GitHub Actions can deploy without stored secrets.

### 1. Create Service Principal

```bash
az ad sp create-for-rbac --name "autopod-github-deploy" --role contributor \
  --scopes /subscriptions/<sub-id>/resourceGroups/autopod-dev-rg
```

### 2. Add Federated Credential

```bash
az ad app federated-credential create --id <app-id> --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<org>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

### 3. Set GitHub Secrets

| Secret                   | Value                          |
|--------------------------|--------------------------------|
| `AZURE_CLIENT_ID`       | Service principal app ID       |
| `AZURE_TENANT_ID`       | Azure AD tenant ID             |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID          |

## Verification

```bash
# Check daemon is running
az containerapp show \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg \
  --query properties.runningStatus

# Hit health endpoint
curl https://$(az containerapp show \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg \
  --query properties.configuration.ingress.fqdn \
  --output tsv)/health

# Check scale-to-zero (after 10min idle)
az containerapp replica list \
  --name autopod-dev-daemon \
  --resource-group autopod-dev-rg

# Local Docker test
docker build -t autopod-daemon:test .
docker run -p 3000:3000 -e DB_PATH=/data/autopod.db autopod-daemon:test
curl http://localhost:3000/health
```

## Architecture

```
┌─ GitHub Actions ──────────────────────────────────┐
│  push image → ACR                                  │
│  deploy → Bicep → Resource Group                   │
└────────────────────────────────────────────────────┘

┌─ Resource Group ──────────────────────────────────┐
│                                                    │
│  Managed Identity ──→ Key Vault (secrets)         │
│        │                                           │
│        └──→ ACR (pull images)                     │
│                                                    │
│  Container Apps Environment                        │
│    ├─ Daemon Container App                        │
│    │   ├─ /health probes (startup/live/ready)     │
│    │   ├─ /data mount (Azure File Share)          │
│    │   └─ Scale: 0-3 replicas                     │
│    └─ Storage: Azure File Share (SQLite)          │
│                                                    │
│  Log Analytics ← application logs                  │
└────────────────────────────────────────────────────┘
```
