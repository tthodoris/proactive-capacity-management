# Azure deployment

This app deploys as **two Azure Container Apps** in one environment:

| App | Image | Ingress | Role |
|-----|--------|---------|------|
| `pcm-web` | `Dockerfile.web` | External (HTTPS) | React UI (nginx) + `/api` reverse proxy |
| `pcm-api` | `Dockerfile.api` | Internal only | Express + Azure CLI + Postgres |

PostgreSQL is **not** containerized in Azure — use **Azure Database for PostgreSQL Flexible Server**.

GitHub Actions (`.github/workflows/deploy-azure.yml`) builds both images, pushes them to Azure Container Registry, and updates (or creates) the Container Apps on every push to `main`/`master`.

```text
GitHub push → build pcm-api + pcm-web → push ACR → Azure Container Apps
                                                      ↓
                                         Azure PostgreSQL Flexible Server
```

## Prerequisites

- Azure subscription + Owner or Contributor rights
- Azure CLI (`az`) locally for one-time setup
- GitHub repo: `https://github.com/tthodoris/proactive-capacity-management`
- Azure PostgreSQL Flexible Server with a database (e.g. `pcm`) and a connection string using TLS

Example connection string:

```text
postgres://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/pcm?sslmode=require
```

Allow the Container Apps environment outbound IPs (or temporarily `0.0.0.0/0` for testing) on the Flexible Server firewall / networking.

## One-time Azure setup

### 1. Variables

```bash
export SUBSCRIPTION_ID="<your-subscription-id>"
export RG="pcm-rg"
export LOC="westeurope"          # or your region
export ACR_NAME="pcmacr$RANDOM"  # globally unique, 5–50 alphanumeric
export DATABASE_URL="postgres://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/pcm?sslmode=require"
```

### 2. Resource group + ACR

```bash
az account set --subscription "$SUBSCRIPTION_ID"
az group create --name "$RG" --location "$LOC"

az deployment group create \
  --resource-group "$RG" \
  --template-file infra/acr.bicep \
  --parameters acrName="$ACR_NAME" location="$LOC"

ACR_LOGIN_SERVER=$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)
echo "ACR: $ACR_LOGIN_SERVER"
```

### 3. GitHub OIDC (federated credential)

Create an Entra app registration / service principal that GitHub Actions can use without a client secret:

```bash
APP_NAME="pcm-github-oidc"
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Federated credential for this repo + branch
PROJECT_NUMBER=$(az ad app show --id "$APP_ID" --query id -o tsv)
cat > /tmp/pcm-github-fed.json <<EOF
{
  "name": "pcm-github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:tthodoris/proactive-capacity-management:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "GitHub Actions main branch"
}
EOF
az ad app federated-credential create --id "$APP_ID" --parameters @/tmp/pcm-github-fed.json

# Also allow workflow_dispatch / master if needed:
# subject: repo:tthodoris/proactive-capacity-management:ref:refs/heads/master

SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG"

# AcrPush on the registry
ACR_ID=$(az acr show -n "$ACR_NAME" --query id -o tsv)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role AcrPush \
  --scope "$ACR_ID"

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$TENANT_ID"
echo "AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID"
```

If your default branch is `master`, create a second federated credential with subject  
`repo:tthodoris/proactive-capacity-management:ref:refs/heads/master`.

### 4. GitHub repository secrets

In the repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|--------|--------|
| `AZURE_CLIENT_ID` | App (client) ID from step 3 |
| `AZURE_TENANT_ID` | Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID |
| `AZURE_RESOURCE_GROUP` | `pcm-rg` (or your RG) |
| `AZURE_LOCATION` | e.g. `westeurope` |
| `ACR_NAME` | ACR name (not login server) |
| `ACR_LOGIN_SERVER` | e.g. `pcmacr123.azurecr.io` |
| `DATABASE_URL` | Flexible Server connection string (`sslmode=require`) |

### 5. Push and deploy

Push to `main` (or run **Actions → Deploy to Azure Container Apps → Run workflow**).

The first run builds images and creates `pcm-api` + `pcm-web` via `infra/main.bicep`. Later runs only update images.

```bash
git remote add origin https://github.com/tthodoris/proactive-capacity-management.git
git branch -M main
git push -u origin main
```

After a successful run, open the URL printed in the workflow log (`https://pcm-web.<...>.azurecontainerapps.io`).

## Manual first deploy (optional)

If you prefer to create apps before GitHub Actions:

```bash
# Build/push once locally
az acr login -n "$ACR_NAME"
docker build -f Dockerfile.api -t "$ACR_LOGIN_SERVER/pcm-api:latest" .
docker build -f Dockerfile.web -t "$ACR_LOGIN_SERVER/pcm-web:latest" .
docker push "$ACR_LOGIN_SERVER/pcm-api:latest"
docker push "$ACR_LOGIN_SERVER/pcm-web:latest"

az deployment group create \
  --resource-group "$RG" \
  --template-file infra/main.bicep \
  --parameters \
    acrName="$ACR_NAME" \
    location="$LOC" \
    apiImage="$ACR_LOGIN_SERVER/pcm-api:latest" \
    webImage="$ACR_LOGIN_SERVER/pcm-web:latest" \
    databaseUrl="$DATABASE_URL"
```

## Networking notes

- Browser traffic hits **pcm-web** only. nginx proxies `/api/*` to **pcm-api** inside the environment (`http://pcm-api:80`).
- **pcm-api** is not exposed publicly.
- Flexible Server must accept connections from the Container Apps environment (public firewall rules or private networking / VNet integration).

## Azure CLI inside pcm-api

The API image includes **Azure CLI** so **Connect with az login** (device code) works in the container. Token cache is ephemeral — after a revision restart you may need to reconnect. For production hardening, mount Azure Files on `~/.azure` or move to service-principal / managed-identity auth.

## Local Docker (optional smoke test)

```bash
# Start local Postgres
npm run db:up

docker build -f Dockerfile.api -t pcm-api:local .
docker build -f Dockerfile.web -t pcm-web:local .

docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://pcm:pcm@host.docker.internal:5432/pcm \
  --name pcm-api pcm-api:local

docker run --rm -p 8081:80 \
  -e API_HOST=host.docker.internal \
  -e API_PORT=8080 \
  --name pcm-web pcm-web:local
```

Open `http://localhost:8081`.
