# Capacity Forecasting Agent

Natural-language capacity forecasting agent built with:

- **Microsoft 365 Agents SDK** (`@microsoft/agents-hosting` + `@microsoft/agents-hosting-express`) for hosting / channel messaging
- **GitHub Copilot SDK** (`@github/copilot-sdk`) for model reasoning + tool calling
- Excel datasources under `./datasources`

> **PCM UI:** The same agent is available in the main app under **Capacity forecast** (`/forecast`), via `POST /api/agent/chat` on the PCM API (loads `dist/chatCore.js`).

## Datasources

| File | Role |
|------|------|
| `MSX_Opportunities_Pipeline.xlsx` | Customers, open opportunities, regions/AZs, VM SKU demand |
| `Stratus_Capacity_Availability.xlsx` | Current capacity, forecast, buildout plan, SKU alternatives |
| `CXObserve_Inventory_ACR_Analysis.xlsx` | Inventory + 3-year ACR trend by Azure service |

Sheets used from CXObserve: `Customer_Summary`, `Deployed_Inventory`, `Service_Growth_Ratio`.

## What the agent can answer

- Future capacity needs for a customer from MSX opportunities + SKU demand
- Capacity restrictions / shortfalls vs Stratus availability & forecast
- Proactive actions (quota requests, buildout tracking, SKU alternatives)
- ACR increase/decrease signals by Azure service

## Tools exposed to Copilot

- `list_customers`
- `get_customer_opportunities`
- `get_opportunity_sku_demand`
- `get_capacity_availability`
- `get_capacity_forecast`
- `get_customer_acr_trend`
- `get_customer_deployed_inventory`
- `analyze_customer_capacity_risk`
- `get_datasource_status`

## Setup

```bash
cd capacity-forecasting-agent
npm install
cp .env.example .env
```

Set `GH_TOKEN` (or `GITHUB_TOKEN`) for an account with an active GitHub Copilot subscription.  
Alternatively rely on local `gh auth login` / Copilot CLI login (`useLoggedInUser`).

Optional:

```env
COPILOT_MODEL=gpt-4.1
CAPACITY_DATASOURCE_DIR=./datasources
```

## Run

Validate datasources:

```bash
npm run check-data
```

Interactive CLI (recommended for local demos):

```bash
npm run cli
```

Example prompts:

- `What is the capacity forecast for Hellenic Bank of Attica?`
- `Which VM SKUs are constrained for Aegean Retail Group?`
- `What proactive actions should we take for CUST-003?`

Hosted Microsoft 365 Agent endpoint (Teams / WebChat / test tool):

```bash
npm run build
npm start
```

Default messaging endpoint: `http://localhost:3978/api/messages`

For Azure Bot / Teams, configure the connection settings from `.env.example` and point the bot messaging endpoint at your tunnel URL + `/api/messages`.

## Project layout

```
capacity-forecasting-agent/
  datasources/           # Excel inputs
  src/
    index.ts             # M365 Agents host + Copilot sessions
    cli.ts               # Local REPL over Copilot SDK
    data/                # Excel loaders + types
    tools/capacityTools.ts
    scripts/checkData.ts
```
