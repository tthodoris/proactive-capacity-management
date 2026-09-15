import { z } from 'zod'
import { defineTool } from '@github/copilot-sdk'
import {
  findCustomers,
  loadCapacityStore,
  resolveCustomerId,
} from '../data/loadDatasources.js'

function matchText(value: string | undefined, query?: string) {
  if (!query?.trim()) return true
  return String(value || '')
    .toLowerCase()
    .includes(query.trim().toLowerCase())
}

export function createCapacityTools() {
  const listCustomers = defineTool('list_customers', {
    description:
      'List sample customers available in the MSX opportunities datasource. Optionally filter by name, id, industry, or segment.',
    parameters: z.object({
      query: z.string().optional().describe('Optional customer name/id/industry filter'),
    }),
    skipPermission: true,
    handler: async ({ query }) => {
      const customers = findCustomers(query).map((c) => ({
        customerId: c.CustomerID,
        customerName: c.CustomerName,
        industry: c.Industry,
        segment: c.Segment,
        currentAnnualAcrUsd: c.CurrentAnnualACR_USD,
        renewalDate: c.ContractRenewalDate,
        accountOwner: c.AccountOwner,
      }))
      return { count: customers.length, customers }
    },
  })

  const getOpportunities = defineTool('get_customer_opportunities', {
    description:
      'Get open/upcoming MSX opportunities for a customer, including regions and estimated ACR.',
    parameters: z.object({
      customer: z.string().describe('Customer name or CustomerID (e.g. CUST-001 or Hellenic Bank)'),
      stage: z.string().optional().describe('Optional stage filter'),
    }),
    skipPermission: true,
    handler: async ({ customer, stage }) => {
      const resolved = resolveCustomerId(customer)
      if (!resolved) {
        return {
          error: `Customer not found for "${customer}". Call list_customers first.`,
          suggestions: findCustomers(customer).slice(0, 5),
        }
      }
      const store = loadCapacityStore()
      const opportunities = store.opportunities
        .filter((o) => o.CustomerID === resolved.CustomerID)
        .filter((o) => matchText(o.Stage, stage))
        .map((o) => ({
          opportunityId: o.OpportunityID,
          name: o.OpportunityName,
          stage: o.Stage,
          probabilityPct: o.Probability_Pct,
          estimatedAcrUsd: o.EstimatedACR_USD,
          consumptionStart: o.EstimatedConsumptionStart,
          closeDate: o.EstimatedCloseDate,
          primaryRegion: o.PrimaryRegion,
          secondaryRegion: o.SecondaryRegion,
          riskFlag: o.RiskFlag,
          solutionArea: o.SolutionArea,
        }))
      return {
        customer: {
          customerId: resolved.CustomerID,
          customerName: resolved.CustomerName,
        },
        count: opportunities.length,
        opportunities,
      }
    },
  })

  const getSkuDemand = defineTool('get_opportunity_sku_demand', {
    description:
      'Get VM SKU / AZ demand lines for a customer (and optional opportunity), from MSX Opportunity_SKU_Demand.',
    parameters: z.object({
      customer: z.string().describe('Customer name or CustomerID'),
      opportunityId: z.string().optional().describe('Optional OpportunityID filter'),
      region: z.string().optional().describe('Optional region filter'),
      sku: z.string().optional().describe('Optional VM SKU filter'),
    }),
    skipPermission: true,
    handler: async ({ customer, opportunityId, region, sku }) => {
      const resolved = resolveCustomerId(customer)
      if (!resolved) {
        return { error: `Customer not found for "${customer}".` }
      }
      const store = loadCapacityStore()
      const demand = store.skuDemand
        .filter((d) => d.CustomerID === resolved.CustomerID)
        .filter((d) => !opportunityId || d.OpportunityID === opportunityId)
        .filter((d) => matchText(d.Region, region))
        .filter((d) => matchText(d.VMSKU, sku))
        .map((d) => ({
          demandId: d.DemandID,
          opportunityId: d.OpportunityID,
          region: d.Region,
          availabilityZone: d.AvailabilityZone,
          vmSku: d.VMSKU,
          vcpusPerVm: d.vCPUsPerVM,
          requiredVmCount: d.RequiredVMCount,
          requiredCores: d.RequiredCores,
          requiredByDate: d.RequiredByDate,
          deploymentWave: d.DeploymentWave,
          criticality: d.Criticality,
          quotaRequested: d.QuotaRequested,
        }))
      const totalCores = demand.reduce((sum, d) => sum + (d.requiredCores || 0), 0)
      return {
        customer: resolved.CustomerName,
        count: demand.length,
        totalRequiredCores: totalCores,
        demand,
      }
    },
  })

  const getCapacityAvailability = defineTool('get_capacity_availability', {
    description:
      'Look up current Stratus capacity availability for regions/AZs/VM SKUs (status, available cores, restrictions, quota flags).',
    parameters: z.object({
      region: z.string().optional(),
      availabilityZone: z.string().optional(),
      sku: z.string().optional(),
      onlyConstrained: z
        .boolean()
        .optional()
        .describe('If true, only return restricted / low / critical capacity rows'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    skipPermission: true,
    handler: async ({ region, availabilityZone, sku, onlyConstrained, limit }) => {
      const store = loadCapacityStore()
      let rows = store.capacityCurrent
        .filter((r) => matchText(r.Region, region))
        .filter((r) => matchText(r.AvailabilityZone, availabilityZone))
        .filter((r) => matchText(r.VMSKU, sku))
      if (onlyConstrained) {
        rows = rows.filter((r) => {
          const status = String(r.CapacityStatus || '').toLowerCase()
          const restriction = String(r.RestrictionLevel || '').toLowerCase()
          const util = Number(r.UtilisationPct || 0)
          return (
            util >= 80 ||
            /restrict|critical|low|constrained|tight/i.test(`${status} ${restriction}`) ||
            String(r.QuotaApprovalRequired).toLowerCase() === 'yes' ||
            r.QuotaApprovalRequired === true
          )
        })
      }
      const limited = rows.slice(0, limit ?? 40).map((r) => ({
        capacityId: r.CapacityID,
        region: r.Region,
        availabilityZone: r.AvailabilityZone,
        vmSku: r.VMSKU,
        family: r.VMFamily,
        availableCores: r.AvailableCores,
        allocatedCores: r.AllocatedCores,
        totalCores: r.TotalCapacityCores,
        utilisationPct: r.UtilisationPct,
        availableVmCount: r.AvailableVMCount,
        status: r.CapacityStatus,
        restrictionLevel: r.RestrictionLevel,
        quotaApprovalRequired: r.QuotaApprovalRequired,
        snapshotDate: r.SnapshotDate,
      }))
      return { count: limited.length, totalMatched: rows.length, rows: limited }
    },
  })

  const getCapacityForecast = defineTool('get_capacity_forecast', {
    description:
      'Get Stratus capacity forecast rows (projected demand/availability by month) and optional buildout plan actions.',
    parameters: z.object({
      region: z.string().optional(),
      sku: z.string().optional(),
      availabilityZone: z.string().optional(),
      includeBuildout: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(120).optional(),
    }),
    skipPermission: true,
    handler: async ({ region, sku, availabilityZone, includeBuildout, limit }) => {
      const store = loadCapacityStore()
      const forecast = store.capacityForecast
        .filter((r) => matchText(r.Region, region))
        .filter((r) => matchText(r.VMSKU, sku))
        .filter((r) => matchText(r.AvailabilityZone, availabilityZone))
        .slice(0, limit ?? 60)
        .map((r) => ({
          region: r.Region,
          availabilityZone: r.AvailabilityZone,
          vmSku: r.VMSKU,
          forecastMonth: r.ForecastMonth,
          projectedTotalCores: r.ProjectedTotalCapacityCores,
          projectedDemandCores: r.ProjectedDemandCores,
          projectedAvailableCores: r.ProjectedAvailableCores,
          projectedUtilisationPct: r.ProjectedUtilisationPct,
          forecastStatus: r.ForecastStatus,
          newCapacityLandingCores: r.NewCapacityLandingCores,
          newCapacityEta: r.NewCapacityETA,
        }))
      const buildout = includeBuildout
        ? store.capacityBuildout
            .filter((r) => matchText(r.Region, region))
            .map((r) => ({
              buildoutId: r.BuildoutID,
              region: r.Region,
              availabilityZone: r.AvailabilityZone,
              vmFamily: r.VMFamily,
              additionalCores: r.AdditionalCores,
              plannedOnlineDate: r.PlannedOnlineDate,
              confidence: r.Confidence,
              status: r.Status,
              notes: r.Notes,
            }))
        : []
      return { forecastCount: forecast.length, forecast, buildout }
    },
  })

  const getAcrTrend = defineTool('get_customer_acr_trend', {
    description:
      'Get CXObserve customer ACR trend by Azure service (FY2024–FY2026, CAGR, growth classification).',
    parameters: z.object({
      customer: z.string().describe('Customer name or CustomerID'),
      service: z.string().optional().describe('Optional Azure service filter'),
    }),
    skipPermission: true,
    handler: async ({ customer, service }) => {
      const resolved = resolveCustomerId(customer)
      if (!resolved) return { error: `Customer not found for "${customer}".` }
      const store = loadCapacityStore()
      const summary = store.customerAcrSummary.find((s) => s.CustomerID === resolved.CustomerID)
      const rows = store.inventoryAcr
        .filter((r) => r.CustomerID === resolved.CustomerID)
        .filter((r) => matchText(r.AzureService, service))
        .map((r) => ({
          azureService: r.AzureService,
          serviceCategory: r.ServiceCategory,
          primaryRegion: r.Region,
          acrFy2024Usd: r.ACR_YearMinus2_USD,
          acrFy2025Usd: r.ACR_YearMinus1_USD,
          acrFy2026Usd: r.ACR_CurrentYear_USD,
          yoyGrowthPct: r.YoY_GrowthPct,
          threeYearCagrPct: r.ThreeYearCAGR_Pct,
          growthRatioFy26VsFy24: r.GrowthRatio,
          growthClassification: r.GrowthClassification,
          trend: r.Trend,
        }))
      const increasing = rows.filter((r) => r.trend === 'Increasing').length
      const decreasing = rows.filter((r) => r.trend === 'Decreasing').length
      return {
        customer: resolved.CustomerName,
        summary: summary
          ? {
              totalAcrFy2024: summary.TotalACR_FY2024,
              totalAcrFy2025: summary.TotalACR_FY2025,
              totalAcrFy2026: summary.TotalACR_FY2026,
              yoyFy26Pct: summary.YoY_Growth_FY26_Pct,
              cagr3yrPct: summary.CAGR_3yr_Pct,
              totalDeployedCores: summary.TotalDeployedCores,
              totalVms: summary.TotalVMs,
              primaryRegion: summary.PrimaryRegion,
              growthTrajectory: summary.GrowthTrajectory,
            }
          : null,
        serviceCount: rows.length,
        increasingServices: increasing,
        decreasingServices: decreasing,
        rows,
      }
    },
  })

  const getDeployedInventory = defineTool('get_customer_deployed_inventory', {
    description:
      'Get CXObserve deployed inventory for a customer (regions, VM SKUs, cores, utilisation, monthly cost).',
    parameters: z.object({
      customer: z.string().describe('Customer name or CustomerID'),
      region: z.string().optional(),
      resourceType: z.string().optional().describe('e.g. Virtual Machine'),
      sku: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    skipPermission: true,
    handler: async ({ customer, region, resourceType, sku, limit }) => {
      const resolved = resolveCustomerId(customer)
      if (!resolved) return { error: `Customer not found for "${customer}".` }
      const store = loadCapacityStore()
      const matched = store.deployedInventory
        .filter((r) => r.CustomerID === resolved.CustomerID)
        .filter((r) => matchText(r.Region, region))
        .filter((r) => matchText(r.ResourceType, resourceType))
        .filter((r) => matchText(r.VMSKU, sku))
      const rows = matched.slice(0, limit ?? 80).map((r) => ({
        inventoryId: r.InventoryID,
        region: r.Region,
        availabilityZone: r.AvailabilityZone,
        resourceType: r.ResourceType,
        vmSku: r.VMSKU,
        instanceCount: r.InstanceCount,
        deployedCores: r.DeployedCores,
        memoryGb: r.MemoryGB,
        environment: r.Environment,
        avgCpuUtilisationPct: r.AvgCPUUtilisationPct,
        monthlyCostUsd: r.MonthlyCost_USD,
        subscriptionName: r.SubscriptionName,
      }))
      const totalCores = matched.reduce((sum, r) => sum + (r.DeployedCores || 0), 0)
      return {
        customer: resolved.CustomerName,
        totalMatched: matched.length,
        totalDeployedCores: totalCores,
        rows,
      }
    },
  })

  const analyzeCapacityRisk = defineTool('analyze_customer_capacity_risk', {
    description:
      'Join customer opportunity SKU demand against current Stratus capacity and forecast to highlight shortfalls, restrictions, quota needs, alternatives, and recommended proactive actions.',
    parameters: z.object({
      customer: z.string().describe('Customer name or CustomerID'),
      horizonMonths: z
        .number()
        .int()
        .min(1)
        .max(18)
        .optional()
        .describe('How many months of forecast to consider (default 6)'),
    }),
    skipPermission: true,
    handler: async ({ customer, horizonMonths }) => {
      const resolved = resolveCustomerId(customer)
      if (!resolved) return { error: `Customer not found for "${customer}".` }
      const store = loadCapacityStore()
      const demand = store.skuDemand.filter((d) => d.CustomerID === resolved.CustomerID)
      const opportunities = store.opportunities.filter((o) => o.CustomerID === resolved.CustomerID)
      const horizon = horizonMonths ?? 6
      const now = new Date()
      const concerns: Array<Record<string, unknown>> = []
      const actions: string[] = []

      for (const line of demand) {
        const current = store.capacityCurrent.find(
          (c) =>
            c.Region === line.Region &&
            c.VMSKU === line.VMSKU &&
            (!line.AvailabilityZone || c.AvailabilityZone === line.AvailabilityZone),
        )
        const requiredCores = Number(line.RequiredCores || 0)
        const availableCores = Number(current?.AvailableCores || 0)
        const shortfall = Math.max(0, requiredCores - availableCores)
        const restricted =
          String(current?.QuotaApprovalRequired).toLowerCase() === 'yes' ||
          current?.QuotaApprovalRequired === true ||
          /restrict|critical|low|constrained/i.test(
            `${current?.CapacityStatus || ''} ${current?.RestrictionLevel || ''}`,
          )

        const forecastHits = store.capacityForecast
          .filter((f) => f.Region === line.Region && f.VMSKU === line.VMSKU)
          .filter((f) => {
            if (!f.ForecastMonth) return true
            const month = new Date(f.ForecastMonth)
            if (Number.isNaN(month.getTime())) return true
            const diff =
              (month.getFullYear() - now.getFullYear()) * 12 +
              (month.getMonth() - now.getMonth())
            return diff >= 0 && diff <= horizon
          })
          .filter(
            (f) =>
              Number(f.ProjectedAvailableCores || 0) < requiredCores ||
              Number(f.ProjectedUtilisationPct || 0) >= 85 ||
              /risk|tight|constrained|short/i.test(String(f.ForecastStatus || '')),
          )

        if (shortfall > 0 || restricted || forecastHits.length > 0) {
          const alternatives = store.skuAlternatives.filter(
            (a) => a.ConstrainedVMSKU === line.VMSKU,
          )
          concerns.push({
            opportunityId: line.OpportunityID,
            region: line.Region,
            availabilityZone: line.AvailabilityZone,
            vmSku: line.VMSKU,
            requiredCores,
            availableCores,
            shortfallCores: shortfall,
            capacityStatus: current?.CapacityStatus || 'unknown',
            restrictionLevel: current?.RestrictionLevel || null,
            quotaApprovalRequired: current?.QuotaApprovalRequired || false,
            forecastPressureMonths: forecastHits.map((f) => f.ForecastMonth).slice(0, 4),
            alternatives: alternatives.slice(0, 3),
            criticality: line.Criticality,
            requiredByDate: line.RequiredByDate,
          })
          if (shortfall > 0) {
            actions.push(
              `Request capacity/quota uplift for ${line.VMSKU} in ${line.Region}${
                line.AvailabilityZone ? `/${line.AvailabilityZone}` : ''
              } (~${shortfall} cores short vs opportunity ${line.OpportunityID}).`,
            )
          }
          if (restricted) {
            actions.push(
              `Open quota approval / capacity exception for ${line.VMSKU} in ${line.Region} before consumption start.`,
            )
          }
          if (alternatives.length) {
            actions.push(
              `Evaluate alternate SKU ${alternatives[0].RecommendedAlternativeSKU}` +
                (alternatives[0].AlternativeRegion
                  ? ` in ${alternatives[0].AlternativeRegion}`
                  : '') +
                ` for constrained ${line.VMSKU}.`,
            )
          }
        }
      }

      const buildouts = store.capacityBuildout.filter((b) =>
        demand.some((d) => d.Region === b.Region),
      )

      for (const b of buildouts.slice(0, 5)) {
        actions.push(
          `Track capacity buildout ${b.BuildoutID}: +${b.AdditionalCores || 0} ${
            b.VMFamily || 'cores'
          } in ${b.Region} planned ${b.PlannedOnlineDate || 'TBD'} (${b.Status || 'unknown'}).`,
        )
      }

      const acr = store.inventoryAcr.filter((r) => r.CustomerID === resolved.CustomerID)
      const growthServices = acr
        .filter((r) => (r.YoY_GrowthPct || 0) >= 15)
        .map((r) => `${r.AzureService} (+${r.YoY_GrowthPct}% YoY)`)

      if (growthServices.length) {
        actions.push(
          `Factor ACR growth into forecast: ${growthServices.slice(0, 4).join(', ')}.`,
        )
      }

      return {
        customer: {
          customerId: resolved.CustomerID,
          customerName: resolved.CustomerName,
          currentAnnualAcrUsd: resolved.CurrentAnnualACR_USD,
        },
        opportunityCount: opportunities.length,
        demandLineCount: demand.length,
        concernCount: concerns.length,
        concerns: concerns.slice(0, 40),
        recommendedActions: [...new Set(actions)].slice(0, 20),
        relatedBuildouts: buildouts.slice(0, 10),
        acrGrowthHotspots: growthServices,
        datasourceWarnings: store.meta.warnings,
      }
    },
  })

  const getDatasourceStatus = defineTool('get_datasource_status', {
    description: 'Report which Excel datasources were loaded and any warnings.',
    parameters: z.object({}),
    skipPermission: true,
    handler: async () => {
      const store = loadCapacityStore()
      return {
        loadedAt: store.meta.loadedAt,
        sources: store.meta.sources,
        warnings: store.meta.warnings,
        counts: {
          customers: store.customers.length,
          opportunities: store.opportunities.length,
          skuDemand: store.skuDemand.length,
          capacityCurrent: store.capacityCurrent.length,
          capacityForecast: store.capacityForecast.length,
          inventoryAcr: store.inventoryAcr.length,
          deployedInventory: store.deployedInventory.length,
          customerAcrSummary: store.customerAcrSummary.length,
        },
      }
    },
  })

  return [
    listCustomers,
    getOpportunities,
    getSkuDemand,
    getCapacityAvailability,
    getCapacityForecast,
    getAcrTrend,
    getDeployedInventory,
    analyzeCapacityRisk,
    getDatasourceStatus,
  ]
}
