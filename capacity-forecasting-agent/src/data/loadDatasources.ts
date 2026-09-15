import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import type {
  CapacityBuildout,
  CapacityCurrent,
  CapacityForecast,
  CapacityStore,
  Customer,
  CustomerAcrSummary,
  DeployedInventoryRow,
  InventoryAcrRow,
  Opportunity,
  SkuAlternative,
  SkuDemand,
} from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATASOURCE_DIR = join(__dirname, '..', '..', 'datasources')

function sheetToObjects<T extends Record<string, unknown>>(
  workbook: XLSX.WorkBook,
  sheetName: string,
): T[] {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<T>(sheet, { defval: null, raw: true })
}

function excelDateToIso(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const utc = Math.round((value - 25569) * 86400 * 1000)
    return new Date(utc).toISOString().slice(0, 10)
  }
  return String(value)
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Normalize fraction (0.21) or already-percent (21) into percent points. */
function pct(value: unknown): number | undefined {
  const n = num(value)
  if (n == null) return undefined
  if (Math.abs(n) <= 2) return Math.round(n * 1000) / 10
  return Math.round(n * 10) / 10
}

function mapTrend(
  value: unknown,
  yoyPct?: number,
): InventoryAcrRow['Trend'] | undefined {
  const raw = String(value || '').toLowerCase()
  if (/increas|accelerat|high growth|moderate growth|strong/i.test(raw)) return 'Increasing'
  if (/decreas|declin|contract/i.test(raw)) return 'Decreasing'
  if (/flat|steady|stable/i.test(raw)) return 'Flat'
  if (yoyPct != null) {
    if (yoyPct > 3) return 'Increasing'
    if (yoyPct < -3) return 'Decreasing'
    return 'Flat'
  }
  return undefined
}

type CxObserveBundle = {
  inventoryAcr: InventoryAcrRow[]
  deployedInventory: DeployedInventoryRow[]
  customerAcrSummary: CustomerAcrSummary[]
}

function loadCxObserveWorkbook(path: string, warnings: string[]): CxObserveBundle | null {
  if (!existsSync(path)) {
    warnings.push(`Missing ACR workbook: ${path}`)
    return null
  }
  try {
    const workbook = XLSX.read(readFileSync(path), { type: 'buffer', cellDates: true })

    const summaries = sheetToObjects<Record<string, unknown>>(workbook, 'Customer_Summary').map(
      (row) =>
        ({
          CustomerID: String(row.CustomerID || ''),
          CustomerName: String(row.CustomerName || ''),
          Industry: row.Industry ? String(row.Industry) : undefined,
          TotalACR_FY2024: num(row.TotalACR_FY2024),
          TotalACR_FY2025: num(row.TotalACR_FY2025),
          TotalACR_FY2026: num(row.TotalACR_FY2026),
          YoY_Growth_FY25_Pct: pct(row.YoY_Growth_FY25_Pct),
          YoY_Growth_FY26_Pct: pct(row.YoY_Growth_FY26_Pct),
          CAGR_3yr_Pct: pct(row.CAGR_3yr_Pct),
          TotalDeployedCores: num(row.TotalDeployedCores),
          TotalVMs: num(row.TotalVMs),
          PrimaryRegion: row.PrimaryRegion ? String(row.PrimaryRegion) : undefined,
          GrowthTrajectory: row.GrowthTrajectory ? String(row.GrowthTrajectory) : undefined,
        }) satisfies CustomerAcrSummary,
    )

    const primaryRegionByCustomer = new Map(
      summaries.map((s) => [s.CustomerID, s.PrimaryRegion] as const),
    )

    const growthRows = sheetToObjects<Record<string, unknown>>(workbook, 'Service_Growth_Ratio')
    let inventoryAcr: InventoryAcrRow[] = []

    if (growthRows.length) {
      inventoryAcr = growthRows.map((row) => {
        const fy24 = num(row.ACR_FY2024)
        const fy25 = num(row.ACR_FY2025)
        const fy26 = num(row.ACR_FY2026)
        const yoy =
          fy25 && fy25 > 0 && fy26 != null
            ? Math.round(((fy26 - fy25) / fy25) * 1000) / 10
            : pct(row.YoY_Change_Pct)
        const customerId = String(row.CustomerID || '')
        return {
          CustomerID: customerId,
          CustomerName: String(row.CustomerName || ''),
          AzureService: String(row.ServiceName || row.AzureService || 'Unknown'),
          ServiceCategory: row.ServiceCategory ? String(row.ServiceCategory) : undefined,
          Region: primaryRegionByCustomer.get(customerId),
          CurrentACR_USD: fy26 ?? fy25,
          ACR_YearMinus2_USD: fy24,
          ACR_YearMinus1_USD: fy25,
          ACR_CurrentYear_USD: fy26 ?? fy25,
          YoY_GrowthPct: yoy,
          ThreeYearCAGR_Pct: pct(row.CAGR_3yr_Pct),
          GrowthRatio: num(row.Growth_Ratio_FY26_vs_FY24),
          GrowthClassification: row.GrowthClassification
            ? String(row.GrowthClassification)
            : undefined,
          Trend: mapTrend(row.GrowthClassification || row.Trend, yoy),
        } satisfies InventoryAcrRow
      })
    } else {
      // Fallback: pivot ACR_By_Service_Yearly into one row per customer+service
      const yearly = sheetToObjects<Record<string, unknown>>(workbook, 'ACR_By_Service_Yearly')
      const byKey = new Map<string, InventoryAcrRow>()
      for (const row of yearly) {
        const customerId = String(row.CustomerID || '')
        const service = String(row.ServiceName || 'Unknown')
        const key = `${customerId}::${service}`
        const existing =
          byKey.get(key) ||
          ({
            CustomerID: customerId,
            CustomerName: String(row.CustomerName || ''),
            AzureService: service,
            ServiceCategory: row.ServiceCategory ? String(row.ServiceCategory) : undefined,
            Region: primaryRegionByCustomer.get(customerId),
          } satisfies InventoryAcrRow)
        const fy = String(row.FiscalYear || '').toUpperCase()
        const acr = num(row.ACR_USD)
        if (fy.includes('2024')) existing.ACR_YearMinus2_USD = acr
        else if (fy.includes('2025')) existing.ACR_YearMinus1_USD = acr
        else if (fy.includes('2026')) existing.ACR_CurrentYear_USD = acr
        const yoy = pct(row.YoY_Change_Pct)
        if (yoy != null) existing.YoY_GrowthPct = yoy
        existing.Trend = mapTrend(row.Trend, existing.YoY_GrowthPct)
        existing.CurrentACR_USD = existing.ACR_CurrentYear_USD ?? existing.ACR_YearMinus1_USD
        byKey.set(key, existing)
      }
      inventoryAcr = [...byKey.values()]
    }

    const deployedInventory = sheetToObjects<Record<string, unknown>>(
      workbook,
      'Deployed_Inventory',
    ).map(
      (row) =>
        ({
          InventoryID: String(row.InventoryID || ''),
          CustomerID: String(row.CustomerID || ''),
          CustomerName: String(row.CustomerName || ''),
          SubscriptionName: row.SubscriptionName ? String(row.SubscriptionName) : undefined,
          ResourceGroup: row.ResourceGroup ? String(row.ResourceGroup) : undefined,
          Region: String(row.Region || ''),
          AvailabilityZone: row.AvailabilityZone ? String(row.AvailabilityZone) : undefined,
          ResourceType: row.ResourceType ? String(row.ResourceType) : undefined,
          VMSKU: row.VMSKU && String(row.VMSKU) !== 'N/A' ? String(row.VMSKU) : undefined,
          vCPUsPerVM: num(row.vCPUsPerVM),
          InstanceCount: num(row.InstanceCount),
          DeployedCores: num(row.DeployedCores),
          MemoryGB: num(row.MemoryGB),
          Environment: row.Environment ? String(row.Environment) : undefined,
          OS: row.OS ? String(row.OS) : undefined,
          AvgCPUUtilisationPct: num(row.AvgCPUUtilisationPct),
          DeploymentDate: excelDateToIso(row.DeploymentDate),
          MonthlyCost_USD: num(row.MonthlyCost_USD),
          ReservedInstanceCoverage: row.ReservedInstanceCoverage
            ? String(row.ReservedInstanceCoverage)
            : undefined,
          Tags: row.Tags ? String(row.Tags) : undefined,
        }) satisfies DeployedInventoryRow,
    )

    if (!inventoryAcr.length) {
      warnings.push(
        `CXObserve workbook opened (${workbook.SheetNames.join(', ')}) but no ACR growth rows found.`,
      )
    }

    return {
      inventoryAcr,
      deployedInventory,
      customerAcrSummary: summaries,
    }
  } catch (err) {
    warnings.push(
      `Could not read CXObserve_Inventory_ACR_Analysis.xlsx (${
        err instanceof Error ? err.message : String(err)
      }).`,
    )
    return null
  }
}

let cachedStore: CapacityStore | null = null

export function getDatasourceDir() {
  return process.env.CAPACITY_DATASOURCE_DIR || DEFAULT_DATASOURCE_DIR
}

export function loadCapacityStore(force = false): CapacityStore {
  if (cachedStore && !force) return cachedStore

  const dir = getDatasourceDir()
  const warnings: string[] = []
  const sources: string[] = []

  const msxPath = join(dir, 'MSX_Opportunities_Pipeline.xlsx')
  const stratusPath = join(dir, 'Stratus_Capacity_Availability.xlsx')
  const acrPath = join(dir, 'CXObserve_Inventory_ACR_Analysis.xlsx')

  if (!existsSync(msxPath)) throw new Error(`Missing datasource: ${msxPath}`)
  if (!existsSync(stratusPath)) throw new Error(`Missing datasource: ${stratusPath}`)

  const msx = XLSX.read(readFileSync(msxPath), { type: 'buffer', cellDates: true })
  sources.push(msxPath)
  const customers = sheetToObjects<Record<string, unknown>>(msx, 'Customers').map((row) => ({
    CustomerID: String(row.CustomerID || ''),
    CustomerName: String(row.CustomerName || ''),
    Industry: row.Industry ? String(row.Industry) : undefined,
    Segment: row.Segment ? String(row.Segment) : undefined,
    AccountOwner: row.AccountOwner ? String(row.AccountOwner) : undefined,
    TAM_CSAM: row.TAM_CSAM ? String(row.TAM_CSAM) : undefined,
    CurrentAnnualACR_USD: num(row.CurrentAnnualACR_USD),
    ContractRenewalDate: excelDateToIso(row.ContractRenewalDate),
  })) as Customer[]

  const opportunities = sheetToObjects<Record<string, unknown>>(msx, 'Opportunities').map(
    (row) => ({
      OpportunityID: String(row.OpportunityID || ''),
      CustomerID: String(row.CustomerID || ''),
      CustomerName: String(row.CustomerName || ''),
      OpportunityName: String(row.OpportunityName || ''),
      SolutionArea: row.SolutionArea ? String(row.SolutionArea) : undefined,
      Stage: row.Stage ? String(row.Stage) : undefined,
      Probability_Pct: num(row.Probability_Pct),
      EstimatedACR_USD: num(row.EstimatedACR_USD),
      EstimatedConsumptionStart: excelDateToIso(row.EstimatedConsumptionStart),
      EstimatedCloseDate: excelDateToIso(row.EstimatedCloseDate),
      DealValue_USD: num(row.DealValue_USD),
      PrimaryRegion: row.PrimaryRegion ? String(row.PrimaryRegion) : undefined,
      SecondaryRegion: row.SecondaryRegion ? String(row.SecondaryRegion) : undefined,
      OpportunityOwner: row.OpportunityOwner ? String(row.OpportunityOwner) : undefined,
      RiskFlag: row.RiskFlag ? String(row.RiskFlag) : undefined,
      LastModified: excelDateToIso(row.LastModified),
    }),
  ) as Opportunity[]

  const skuDemand = sheetToObjects<Record<string, unknown>>(msx, 'Opportunity_SKU_Demand').map(
    (row) => ({
      DemandID: String(row.DemandID || ''),
      OpportunityID: String(row.OpportunityID || ''),
      CustomerID: String(row.CustomerID || ''),
      Region: String(row.Region || ''),
      AvailabilityZone: row.AvailabilityZone ? String(row.AvailabilityZone) : undefined,
      VMSKU: String(row.VMSKU || ''),
      vCPUsPerVM: num(row.vCPUsPerVM),
      RequiredVMCount: num(row.RequiredVMCount),
      RequiredCores: num(row.RequiredCores),
      RequiredMemoryGB: num(row.RequiredMemoryGB),
      DeploymentWave: row.DeploymentWave ? String(row.DeploymentWave) : undefined,
      RequiredByDate: excelDateToIso(row.RequiredByDate),
      WorkloadType: row.WorkloadType ? String(row.WorkloadType) : undefined,
      IsZoneRedundant: row.IsZoneRedundant as string | boolean | undefined,
      Criticality: row.Criticality ? String(row.Criticality) : undefined,
      QuotaRequested: row.QuotaRequested as string | boolean | undefined,
    }),
  ) as SkuDemand[]

  const stratus = XLSX.read(readFileSync(stratusPath), { type: 'buffer', cellDates: true })
  sources.push(stratusPath)

  const capacityCurrent = sheetToObjects<Record<string, unknown>>(
    stratus,
    'Capacity_Current',
  ).map((row) => ({
    CapacityID: String(row.CapacityID || ''),
    Region: String(row.Region || ''),
    AvailabilityZone: row.AvailabilityZone ? String(row.AvailabilityZone) : undefined,
    VMSKU: String(row.VMSKU || ''),
    VMFamily: row.VMFamily ? String(row.VMFamily) : undefined,
    vCPUsPerVM: num(row.vCPUsPerVM),
    TotalCapacityCores: num(row.TotalCapacityCores),
    AllocatedCores: num(row.AllocatedCores),
    AvailableCores: num(row.AvailableCores),
    UtilisationPct: num(row.UtilisationPct),
    AvailableVMCount: num(row.AvailableVMCount),
    CapacityStatus: row.CapacityStatus ? String(row.CapacityStatus) : undefined,
    RestrictionLevel: row.RestrictionLevel ? String(row.RestrictionLevel) : undefined,
    QuotaApprovalRequired: row.QuotaApprovalRequired as string | boolean | undefined,
    SnapshotDate: excelDateToIso(row.SnapshotDate),
  })) as CapacityCurrent[]

  const capacityForecast = sheetToObjects<Record<string, unknown>>(
    stratus,
    'Capacity_Forecast',
  ).map((row) => ({
    Region: String(row.Region || ''),
    AvailabilityZone: row.AvailabilityZone ? String(row.AvailabilityZone) : undefined,
    VMSKU: String(row.VMSKU || ''),
    ForecastMonth: excelDateToIso(row.ForecastMonth) || String(row.ForecastMonth || ''),
    ProjectedTotalCapacityCores: num(row.ProjectedTotalCapacityCores),
    ProjectedDemandCores: num(row.ProjectedDemandCores),
    ProjectedAvailableCores: num(row.ProjectedAvailableCores),
    ProjectedUtilisationPct: num(row.ProjectedUtilisationPct),
    ForecastStatus: row.ForecastStatus ? String(row.ForecastStatus) : undefined,
    NewCapacityLandingCores: num(row.NewCapacityLandingCores),
    NewCapacityETA: excelDateToIso(row.NewCapacityETA),
  })) as CapacityForecast[]

  const capacityBuildout = sheetToObjects<Record<string, unknown>>(
    stratus,
    'Capacity_Buildout_Plan',
  ).map((row) => ({
    BuildoutID: String(row.BuildoutID || ''),
    Region: String(row.Region || ''),
    AvailabilityZone: row.AvailabilityZone ? String(row.AvailabilityZone) : undefined,
    VMFamily: row.VMFamily ? String(row.VMFamily) : undefined,
    AdditionalCores: num(row.AdditionalCores),
    PlannedOnlineDate: excelDateToIso(row.PlannedOnlineDate),
    Confidence: row.Confidence ? String(row.Confidence) : undefined,
    Status: row.Status ? String(row.Status) : undefined,
    Notes: row.Notes ? String(row.Notes) : undefined,
  })) as CapacityBuildout[]

  const skuAlternatives = sheetToObjects<Record<string, unknown>>(
    stratus,
    'SKU_Alternatives',
  ).map((row) => ({
    ConstrainedVMSKU: String(row.ConstrainedVMSKU || ''),
    RecommendedAlternativeSKU: String(row.RecommendedAlternativeSKU || ''),
    AlternativeRegion: row.AlternativeRegion ? String(row.AlternativeRegion) : undefined,
    AlternativeAvailabilityZone: row.AlternativeAvailabilityZone
      ? String(row.AlternativeAvailabilityZone)
      : undefined,
    PerformanceDeltaPct: num(row.PerformanceDeltaPct),
    CostDeltaPct: num(row.CostDeltaPct),
    MigrationComplexity: row.MigrationComplexity ? String(row.MigrationComplexity) : undefined,
    Notes: row.Notes ? String(row.Notes) : undefined,
  })) as SkuAlternative[]

  const cx = loadCxObserveWorkbook(acrPath, warnings)
  const inventoryAcr = cx?.inventoryAcr ?? []
  const deployedInventory = cx?.deployedInventory ?? []
  const customerAcrSummary = cx?.customerAcrSummary ?? []
  if (cx && (inventoryAcr.length || deployedInventory.length)) {
    sources.push(acrPath)
  } else if (!warnings.some((w) => /CXObserve|ACR workbook/i.test(w))) {
    warnings.push('CXObserve workbook loaded with no usable ACR/inventory rows.')
  }

  cachedStore = {
    customers,
    opportunities,
    skuDemand,
    capacityCurrent,
    capacityForecast,
    capacityBuildout,
    skuAlternatives,
    inventoryAcr,
    deployedInventory,
    customerAcrSummary,
    meta: {
      loadedAt: new Date().toISOString(),
      sources,
      warnings,
    },
  }
  return cachedStore
}

export function findCustomers(query?: string) {
  const store = loadCapacityStore()
  if (!query?.trim()) return store.customers
  const q = query.trim().toLowerCase()
  return store.customers.filter(
    (c) =>
      c.CustomerID.toLowerCase().includes(q) ||
      c.CustomerName.toLowerCase().includes(q) ||
      (c.Industry || '').toLowerCase().includes(q),
  )
}

export function resolveCustomerId(customer?: string) {
  if (!customer?.trim()) return null
  const matches = findCustomers(customer)
  if (matches.length === 1) return matches[0]
  const exact = matches.find(
    (c) =>
      c.CustomerID.toLowerCase() === customer.toLowerCase() ||
      c.CustomerName.toLowerCase() === customer.toLowerCase(),
  )
  return exact || null
}
