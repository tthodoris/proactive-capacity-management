import { loadCapacityStore } from '../data/loadDatasources.js'

const store = loadCapacityStore(true)
console.log(JSON.stringify(store.meta, null, 2))
console.log('counts', {
  customers: store.customers.length,
  opportunities: store.opportunities.length,
  skuDemand: store.skuDemand.length,
  capacityCurrent: store.capacityCurrent.length,
  capacityForecast: store.capacityForecast.length,
  inventoryAcr: store.inventoryAcr.length,
  deployedInventory: store.deployedInventory.length,
  customerAcrSummary: store.customerAcrSummary.length,
})
console.log('sample customers', store.customers.slice(0, 3).map((c) => c.CustomerName))
console.log(
  'sample ACR',
  store.inventoryAcr.slice(0, 2).map((r) => ({
    customer: r.CustomerName,
    service: r.AzureService,
    fy26: r.ACR_CurrentYear_USD,
    yoy: r.YoY_GrowthPct,
    trend: r.Trend,
  })),
)
