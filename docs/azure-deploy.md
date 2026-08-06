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

# Container Apps pull via managed identity (AcrPull) — do NOT require ACR admin user.
# GitHub Actions pushes with the OIDC principal's AcrPush role (step 3).
```

### 3. GitHub OIDC (federated credential)

Create an Entra app registration / service principal that GitHub Actions can use without a client secret:

```bash
APP_NAME="pcm-github-oidc"
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Federated credential for this repo + branch.
# Prefer the ID-based subject GitHub currently issues for this account/repo:
#   repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/main
# Classic form (repo:owner/repo:ref:...) may fail with AADSTS700213.
cat > /tmp/pcm-github-fed.json <<EOF
{
  "name": "pcm-github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:tthodoris@1280109/proactive-capacity-management@1324159423:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "GitHub Actions main branch (owner/repo IDs)"
}
EOF
az ad app federated-credential create --id "$APP_ID" --parameters @/tmp/pcm-github-fed.json

# If login still fails, copy the exact "presented assertion subject" from the
# workflow AADSTS700213 error and update the federated credential to match.

SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RG"

# Needed so Bicep can grant AcrPull to the Container Apps pull identity
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "User Access Administrator" \
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
| `JUMPHOST_ADMIN_PASSWORD` | Strong password for the Windows jumphost local admin |
| `JUMPHOST_RDP_CIDR` | Your public IP as CIDR, e.g. `203.0.113.10/32` |
| `JUMPHOST_ADMIN_USERNAME` | Optional (default `pcmadmin`) |

### 5. Push and deploy

Push to `main` (or run **Actions → Deploy to Azure Container Apps → Run workflow**).

The first run builds images and creates:
- **VNet** `pcm-vnet` (`10.20.0.0/16`) with subnets `snet-jumphost`, `snet-data` (Postgres delegation), `snet-aca` (reserved)
- **Windows jumphost** `pcm-jump` (RDP from `JUMPHOST_RDP_CIDR` only)
- **Container Apps** `pcm-api` + `pcm-web`

Later runs update images; the jumphost is created once if missing.

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

## Windows jumphost

Deployed by `infra/platform.bicep` (also referenced from `infra/main.bicep`):

| Resource | Name / value |
|----------|----------------|
| VNet | `pcm-vnet` — `10.20.0.0/16` |
| Jumphost subnet | `snet-jumphost` — `10.20.1.0/24` |
| Data subnet | `snet-data` — `10.20.2.0/24` (delegated to PostgreSQL Flexible Server) |
| ACA subnet | `snet-aca` — `10.20.4.0/23` (reserved for future VNet integration) |
| VM | `pcm-jump` — Windows Server 2022, `Standard_B2s`, public IP |
| RDP | Port **3389** allowed only from `JUMPHOST_RDP_CIDR` |

**Use it for:** Azure Data Studio / `psql` against Flexible Server (place the server in `snet-data` with private access, or allow the jumphost public IP on the server firewall), portal management, troubleshooting.

Connect:

```bash
JUMP_IP=$(az vm list-ip-addresses -g "$RG" -n pcm-jump \
  --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" -o tsv)
mstsc /v:$JUMP_IP
# username: pcmadmin (or JUMPHOST_ADMIN_USERNAME)
```

Manual platform-only deploy:

```bash
az deployment group create \
  --resource-group "$RG" \
  --template-file infra/platform.bicep \
  --parameters \
    location="$LOC" \
    jumpHostAdminUsername=pcmadmin \
    jumpHostAdminPassword="$JUMPHOST_ADMIN_PASSWORD" \
    jumpHostRdpSourceCidr="$JUMPHOST_RDP_CIDR"
```

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
