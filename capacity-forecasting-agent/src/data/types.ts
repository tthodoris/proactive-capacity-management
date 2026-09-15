export type Customer = {
  CustomerID: string
  CustomerName: string
  Industry?: string
  Segment?: string
  AccountOwner?: string
  TAM_CSAM?: string
  CurrentAnnualACR_USD?: number
  ContractRenewalDate?: string
}

export type Opportunity = {
  OpportunityID: string
  CustomerID: string
  CustomerName: string
  OpportunityName: string
  SolutionArea?: string
  Stage?: string
  Probability_Pct?: number
  EstimatedACR_USD?: number
  EstimatedConsumptionStart?: string
  EstimatedCloseDate?: string
  DealValue_USD?: number
  PrimaryRegion?: string
  SecondaryRegion?: string
  OpportunityOwner?: string
  RiskFlag?: string
  LastModified?: string
}

export type SkuDemand = {
  DemandID: string
  OpportunityID: string
  CustomerID: string
  Region: string
  AvailabilityZone?: string
  VMSKU: string
  vCPUsPerVM?: number
  RequiredVMCount?: number
  RequiredCores?: number
  RequiredMemoryGB?: number
  DeploymentWave?: string
  RequiredByDate?: string
  WorkloadType?: string
  IsZoneRedundant?: string | boolean
  Criticality?: string
  QuotaRequested?: string | boolean
}

export type CapacityCurrent = {
  CapacityID: string
  Region: string
  AvailabilityZone?: string
  VMSKU: string
  VMFamily?: string
  vCPUsPerVM?: number
  TotalCapacityCores?: number
  AllocatedCores?: number
  AvailableCores?: number
  UtilisationPct?: number
  AvailableVMCount?: number
  CapacityStatus?: string
  RestrictionLevel?: string
  QuotaApprovalRequired?: string | boolean
  SnapshotDate?: string
}

export type CapacityForecast = {
  Region: string
  AvailabilityZone?: string
  VMSKU: string
  ForecastMonth?: string
  ProjectedTotalCapacityCores?: number
  ProjectedDemandCores?: number
  ProjectedAvailableCores?: number
  ProjectedUtilisationPct?: number
  ForecastStatus?: string
  NewCapacityLandingCores?: number
  NewCapacityETA?: string
}

export type CapacityBuildout = {
  BuildoutID: string
  Region: string
  AvailabilityZone?: string
  VMFamily?: string
  AdditionalCores?: number
  PlannedOnlineDate?: string
  Confidence?: string
  Status?: string
  Notes?: string
}

export type SkuAlternative = {
  ConstrainedVMSKU: string
  RecommendedAlternativeSKU: string
  AlternativeRegion?: string
  AlternativeAvailabilityZone?: string
  PerformanceDeltaPct?: number
  CostDeltaPct?: number
  MigrationComplexity?: string
  Notes?: string
}

export type InventoryAcrRow = {
  CustomerID: string
  CustomerName: string
  AzureService: string
  ServiceCategory?: string
  Region?: string
  CurrentResourceCount?: number
  CurrentACR_USD?: number
  ACR_YearMinus2_USD?: number
  ACR_YearMinus1_USD?: number
  ACR_CurrentYear_USD?: number
  YoY_GrowthPct?: number
  ThreeYearCAGR_Pct?: number
  GrowthRatio?: number
  GrowthClassification?: string
  Trend?: 'Increasing' | 'Decreasing' | 'Flat'
  Notes?: string
}

export type DeployedInventoryRow = {
  InventoryID: string
  CustomerID: string
  CustomerName: string
  SubscriptionName?: string
  ResourceGroup?: string
  Region: string
  AvailabilityZone?: string
  ResourceType?: string
  VMSKU?: string
  vCPUsPerVM?: number
  InstanceCount?: number
  DeployedCores?: number
  MemoryGB?: number
  Environment?: string
  OS?: string
  AvgCPUUtilisationPct?: number
  DeploymentDate?: string
  MonthlyCost_USD?: number
  ReservedInstanceCoverage?: string
  Tags?: string
}

export type CustomerAcrSummary = {
  CustomerID: string
  CustomerName: string
  Industry?: string
  TotalACR_FY2024?: number
  TotalACR_FY2025?: number
  TotalACR_FY2026?: number
  YoY_Growth_FY25_Pct?: number
  YoY_Growth_FY26_Pct?: number
  CAGR_3yr_Pct?: number
  TotalDeployedCores?: number
  TotalVMs?: number
  PrimaryRegion?: string
  GrowthTrajectory?: string
}

export type CapacityStore = {
  customers: Customer[]
  opportunities: Opportunity[]
  skuDemand: SkuDemand[]
  capacityCurrent: CapacityCurrent[]
  capacityForecast: CapacityForecast[]
  capacityBuildout: CapacityBuildout[]
  skuAlternatives: SkuAlternative[]
  inventoryAcr: InventoryAcrRow[]
  deployedInventory: DeployedInventoryRow[]
  customerAcrSummary: CustomerAcrSummary[]
  meta: {
    loadedAt: string
    sources: string[]
    warnings: string[]
  }
}
