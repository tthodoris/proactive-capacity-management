# Proactive Capacity Management (PCM)

Internal web application for Cloud Solution Architects to anticipate and act on Azure capacity constraints before they impact customers.

Built from the PCM Business Requirements Document (v0.1 draft).

## Run locally

```bash
npm install
npm run db:up
npm run dev
```

This starts:
- PostgreSQL via Docker (`pcm` / `pcm` on `localhost:5432`)
- the Vite UI (usually `http://localhost:5173`)
- the Azure bridge API on `http://127.0.0.1:8788`

### Connect a tenant and load live quotas

1. Open **Azure Connect** in the left menu
2. Enter a tenant GUID and click **Connect with az login**
3. Complete device-code login at [microsoft.com/devicelogin](https://microsoft.com/devicelogin)
4. Choose a subscription
5. Click **Collect inventory** and/or **Collect quotas**

Collected customers, subscriptions, inventory, and quotas are stored in PostgreSQL and survive refresh / tab changes.

Requires Azure CLI (`az`) on your PATH and permission to the target tenant/subscriptions.

## Deploy to Azure

Production layout:

- **pcm-web** — Container App (public HTTPS), nginx UI + `/api` proxy  
- **pcm-api** — Container App (internal), Express + Azure CLI  
- **Azure Database for PostgreSQL Flexible Server** — `DATABASE_URL`  
- **GitHub Actions** — build/push images to ACR and deploy on every push to `main`

Step-by-step (OIDC, secrets, Bicep): see [docs/azure-deploy.md](docs/azure-deploy.md).

## What’s included

- **Dashboard** — active constraints, affected customers, alerts, engagements
- **Constraints** — create/manage SKU capacity records with severity, status, audit trail (persisted in PostgreSQL)
- **Rewards** — points per user action (constraint created, engagement started, resolved) stored in PostgreSQL
- **Impact analysis** — automatic customer/subscription matching on create and on demand
- **Customers / Inventory / Quotas** — portfolio views with CSA ownership filtering
- **Alerts & engagement** — in-app/Teams/email-style alerts and Capacity-team engagement logging
- **Admin** — RBAC preview, data-source status, sync jobs

Use the sidebar **Demo identity** control to switch between CSA, Capacity Manager, and Administrator.

## Notes

This MVP uses rich mock data to demonstrate Must/Should workflows from the BRD. Entra ID SSO, live tenant inventory, and Graph alerting are represented in the UI and ready to wire to real Microsoft backends.
