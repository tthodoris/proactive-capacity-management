/**
 * Azure Retail Prices helpers for region-evaluation cost comparison.
 * Public API: https://prices.azure.com/api/retail/prices (no auth).
 *
 * VMs use exact armSkuName matching. PaaS services use service-specific
 * strategies that prefer a base/fixed meter when capacity, throughput, or
 * usage metrics are not available from inventory.
 */

const RETAIL_API = 'https://prices.azure.com/api/retail/prices'
const RETAIL_API_VERSION = '2023-01-01-preview'
const HOURS_PER_MONTH = 730

/** @type {Map<string, Promise<object | null>>} */
const priceCache = new Map()

const RESOURCE_TYPE_SERVICE_NAME = {
  'Virtual Machine': 'Virtual Machines',
  'Azure Databricks': 'Azure Databricks',
  'Azure Data Explorer': 'Azure Data Explorer',
  'Azure SQL Database': 'SQL Database',
  'Azure SQL Managed Instance': 'SQL Managed Instance',
  'Azure SQL Server': 'SQL Database',
  'Azure Database for MySQL': 'Azure Database for MySQL',
  'Azure Database for PostgreSQL': 'Azure Database for PostgreSQL',
  'Azure Cosmos DB': 'Azure Cosmos DB',
  'Azure Cache for Redis': 'Redis Cache',
  'Azure Managed Redis': 'Azure Managed Redis',
  'Key Vault': 'Key Vault',
  'Storage Account': 'Storage',
  'Application Gateway': 'Application Gateway',
  'API Management': 'API Management',
  'VPN Gateway': 'VPN Gateway',
  'Container Instances': 'Container Instances',
  'Azure Container Apps': 'Azure Container Apps',
  'Azure Kubernetes Service': 'Azure Kubernetes Service',
  // Legacy
  'Azure SQL': 'SQL Database',
  MySQL: 'Azure Database for MySQL',
  PostgreSQL: 'Azure Database for PostgreSQL',
  Container: 'Azure Kubernetes Service',
  'PaaS Database': 'Azure Cosmos DB',
}

function odataEscape(value) {
  return String(value || '').replace(/'/g, "''")
}

function looksLikeArmSku(value) {
  const raw = String(value || '').trim()
  return /^Standard_/i.test(raw) || /^Basic_/i.test(raw) || /^Premium_/i.test(raw)
}

/**
 * Prefer an exact ARM size (Standard_*) over a family label (Dsv5).
 * @param {string} sku
 * @param {string | null | undefined} size
 */
export function resolvePricingSku(sku, size) {
  const sizeVal = String(size || '').trim()
  const skuVal = String(sku || '').trim()
  if (looksLikeArmSku(sizeVal)) return sizeVal
  if (looksLikeArmSku(skuVal)) return skuVal
  if (sizeVal && sizeVal !== skuVal && !/family|series/i.test(sizeVal)) return sizeVal
  return skuVal || sizeVal || ''
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function includesAny(haystack, needles) {
  const hay = String(haystack || '').toLowerCase()
  return needles.some((needle) => hay.includes(String(needle).toLowerCase()))
}

function monthlyFromUnit(unitPrice, unitOfMeasure) {
  const price = Number(unitPrice)
  if (!Number.isFinite(price)) return null
  const unit = String(unitOfMeasure || '').toLowerCase()
  if (unit.includes('hour')) return price * HOURS_PER_MONTH
  if (unit.includes('month') || unit === '1/month') return price
  if (unit.includes('day')) return price * 30
  return null
}

function toPriceResult(picked, extras = {}) {
  if (!picked) return null
  const unitPrice = Number(picked.retailPrice ?? picked.unitPrice)
  const unitOfMeasure = picked.unitOfMeasure || null
  return {
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
    monthlyUnitPrice: monthlyFromUnit(unitPrice, unitOfMeasure),
    currencyCode: picked.currencyCode || 'USD',
    unitOfMeasure,
    productName: picked.productName || null,
    meterName: picked.meterName || null,
    armSkuName: picked.armSkuName || picked.skuName || null,
    note: extras.note || null,
    pricingMode: extras.pricingMode || 'exact',
  }
}

async function fetchRetailItems(filter) {
  const url = new URL(RETAIL_API)
  url.searchParams.set('api-version', RETAIL_API_VERSION)
  url.searchParams.set('$filter', filter)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Retail prices HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`)
    }
    const payload = await res.json()
    return Array.isArray(payload.Items) ? payload.Items : []
  } finally {
    clearTimeout(timer)
  }
}

function filterConsumptionItems(items, { primaryOnly = false } = {}) {
  const list = Array.isArray(items) ? items : []
  const typed = list.filter((item) => {
    const type = String(item.type || item.priceType || '')
    if (type && type !== 'Consumption') return false
    const meter = `${item.meterName || ''} ${item.skuName || ''} ${item.productName || ''}`
    if (/spot|low priority/i.test(meter)) return false
    return true
  })
  if (!primaryOnly) return typed.length ? typed : list
  const primary = typed.filter((item) => item.isPrimaryMeterRegion !== false)
  return primary.length ? primary : typed
}

function scoreAndPick(items, scorers = [], options = {}) {
  const candidates = filterConsumptionItems(items, options)
  if (!candidates.length) return null
  let best = null
  let bestScore = -Infinity
  for (const item of candidates) {
    let score = 0
    for (const scorer of scorers) score += scorer(item) || 0
    const price = Number(item.retailPrice ?? item.unitPrice ?? 0)
    const adjusted = score * 1_000_000 - price
    if (adjusted > bestScore) {
      bestScore = adjusted
      best = item
    }
  }
  if (scorers.length && bestScore < 1_000_000) return null
  return best
}

function pickRetailItem(items, serviceName) {
  // Exact VM-style matches prefer primary meters.
  const candidates = filterConsumptionItems(items, { primaryOnly: true })
  if (!candidates.length) return null
  let ranked = candidates
  if (serviceName === 'Virtual Machines') {
    const linux = candidates.filter((item) => !/windows/i.test(String(item.productName || '')))
    if (linux.length) ranked = linux
  }
  ranked = [...ranked].sort(
    (a, b) => Number(a.retailPrice ?? a.unitPrice ?? 0) - Number(b.retailPrice ?? b.unitPrice ?? 0),
  )
  return ranked[0] || null
}

function basePriceNote(detail) {
  return `Base price${detail ? ` (${detail})` : ''} — capacity/throughput/usage not available from inventory`
}

/** Normalize inventory labels to retail product/sku hints. */
function normalizeInventoryHints(resourceType, sku, size) {
  const raw = `${sku || ''} ${size || ''}`.trim()
  const norm = normalizeText(raw)
  const hints = {
    resourceType,
    raw,
    norm,
    sku: String(sku || '').trim(),
    size: String(size || '').trim(),
  }

  if (resourceType === 'Application Gateway') {
    if (/wafv2|waf_v2|waf2/.test(norm)) hints.tier = 'waf_v2'
    else if (/basicv2|basic_v2/.test(norm)) hints.tier = 'basic_v2'
    else if (/standardv2|standard_v2|v2/.test(norm)) hints.tier = 'standard_v2'
    else if (/waf/.test(norm)) hints.tier = 'waf'
    else if (/medium/.test(norm)) hints.tier = 'medium'
    else if (/large/.test(norm)) hints.tier = 'large'
    else if (/small/.test(norm)) hints.tier = 'small'
    else hints.tier = 'standard_v2'
  }

  if (resourceType === 'Storage Account') {
    if (/premium.*zrs|pzrs/.test(norm)) hints.redundancy = 'Premium ZRS'
    else if (/premium.*lrs|plrs|premium/.test(norm)) hints.redundancy = 'Premium LRS'
    else if (/ragzrs/.test(norm)) hints.redundancy = 'Standard RA-GZRS'
    else if (/ragrs/.test(norm)) hints.redundancy = 'Standard RA-GRS'
    else if (/gzrs/.test(norm)) hints.redundancy = 'Standard GZRS'
    else if (/grs/.test(norm)) hints.redundancy = 'Standard GRS'
    else if (/zrs/.test(norm)) hints.redundancy = 'Standard ZRS'
    else hints.redundancy = 'Standard LRS'
  }

  if (resourceType === 'Key Vault') {
    hints.tier = /premium/.test(norm) ? 'Premium' : 'Standard'
  }

  if (resourceType === 'API Management') {
    if (/consumption/.test(norm)) hints.tier = 'Consumption'
    else if (/isolated|premium/.test(norm)) hints.tier = 'Premium'
    else if (/standard/.test(norm)) hints.tier = 'Standard'
    else if (/basic/.test(norm)) hints.tier = 'Basic'
    else if (/developer/.test(norm)) hints.tier = 'Developer'
    else hints.tier = raw || 'Developer'
  }

  if (resourceType === 'VPN Gateway') {
    const match = raw.match(/VpnGw\d+[A-Za-z]*/i) || raw.match(/Basic/i)
    hints.tier = match ? match[0] : raw || 'VpnGw1'
  }

  if (resourceType === 'Azure Cache for Redis' || resourceType === 'Azure Managed Redis') {
    hints.tier = raw || 'Standard'
  }

  if (resourceType === 'Azure Cosmos DB') {
    hints.tier = /autoscale/.test(norm) ? 'Autoscale' : 'Standard'
  }

  return hints
}

function regionFilter(regionId) {
  return `armRegionName eq '${odataEscape(regionId)}' and priceType eq 'Consumption'`
}

async function lookupApplicationGateway(regionId, hints) {
  const items = await fetchRetailItems(
    `serviceName eq 'Application Gateway' and ${regionFilter(regionId)}`,
  )
  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const product = String(item.productName || '')
      const meter = String(item.meterName || '')
      let score = 0
      if (/fixed cost/i.test(meter)) score += 50
      if (/capacity units|data processed|captcha|association|agc/i.test(meter)) score -= 40
      if (/discounted/i.test(product)) score -= 40
      if (hints.tier === 'waf_v2') {
        if (/waf v2/i.test(product) && !/discounted/i.test(product)) score += 30
        if (/standard v2/i.test(product)) score -= 10
      } else if (hints.tier === 'basic_v2') {
        if (/basic v2/i.test(product)) score += 30
      } else if (hints.tier === 'standard_v2') {
        if (/standard v2/i.test(product) && !/waf/i.test(product)) score += 30
        if (/waf v2/i.test(product)) score -= 5
      } else if (hints.tier === 'waf') {
        if (/^waf application gateway$/i.test(product) || /waf application gateway/i.test(product))
          score += 20
      }
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote('fixed gateway cost; capacity units excluded'),
  })
}

async function lookupKeyVault(regionId, hints) {
  const items = await fetchRetailItems(
    `serviceName eq 'Key Vault' and ${regionFilter(regionId)} and skuName eq '${odataEscape(hints.tier)}'`,
  )
  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const meter = String(item.meterName || '')
      const product = String(item.productName || '')
      let score = 0
      if (!/^key vault$/i.test(product)) score -= 50
      if (/^operations$/i.test(meter)) score += 80
      if (/advanced key operations/i.test(meter)) score += 5
      if (/rotation|renewal|certificate|hsm|dedicated/i.test(`${meter} ${product}`)) score -= 60
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote(`${hints.tier} operations meter (per 10K); request volume unknown`),
  })
}

async function lookupStorageAccount(regionId, hints) {
  const redundancy = hints.redundancy || 'Standard LRS'
  // Prefer exact skuName first (e.g. "Standard LRS").
  let items = await fetchRetailItems(
    `serviceName eq 'Storage' and ${regionFilter(regionId)} and skuName eq '${odataEscape(redundancy)}'`,
  )
  if (!items.length) {
    items = await fetchRetailItems(
      `serviceName eq 'Storage' and ${regionFilter(regionId)} and contains(skuName, '${odataEscape(redundancy.replace(/^Standard\s+/i, ''))}')`,
    )
  }

  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const product = String(item.productName || '')
      const meter = String(item.meterName || '')
      const skuName = String(item.skuName || '')
      let score = 0
      if (normalizeText(skuName) === normalizeText(redundancy)) score += 30
      if (/^general block blob$/i.test(product) || /^blob storage$/i.test(product)) score += 40
      if (/data stored/i.test(meter) && !/disk data stored/i.test(meter)) score += 50
      if (/hierarchical|data lake|files|tables|queues|page blob|disk|discovery|archive|cool|cold/i.test(product))
        score -= 35
      if (/operations|write|read|list|index|bandwidth|retrieval|io/i.test(meter)) score -= 40
      if (/1 gb\/month|gb\/month/i.test(String(item.unitOfMeasure || ''))) score += 15
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote(`${redundancy} blob data stored at 1 GB/month baseline; capacity unknown`),
  })
}

async function lookupCosmosDb(regionId, hints) {
  const items = await fetchRetailItems(
    `serviceName eq 'Azure Cosmos DB' and ${regionFilter(regionId)} and meterName eq '100 RU/s'`,
  )
  const fallback =
    items.length > 0
      ? items
      : await fetchRetailItems(`serviceName eq 'Azure Cosmos DB' and ${regionFilter(regionId)}`)

  const picked = scoreAndPick(fallback, [
    (item) => {
      const product = String(item.productName || '')
      const meter = String(item.meterName || '')
      const skuName = String(item.skuName || '')
      let score = 0
      if (/^azure cosmos db$/i.test(product) && /100 ru\/?s/i.test(meter)) score += 50
      if (/^rus$/i.test(skuName)) score += 40
      if (/free tier/i.test(skuName) || Number(item.retailPrice ?? 0) === 0) score -= 50
      if (/autoscale/i.test(meter) && hints.tier === 'Autoscale') score += 20
      if (/analytics|mongodb|documentdb|garnet|dedicated gateway|graph api|backup|materialized/i.test(product))
        score -= 40
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote('100 RU/s provisioned throughput baseline; actual RU/s unknown'),
  })
}

async function lookupApiManagement(regionId, hints) {
  const tier = hints.tier || 'Developer'
  const items = await fetchRetailItems(
    `serviceName eq 'API Management' and ${regionFilter(regionId)}`,
  )
  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const product = String(item.productName || '')
      const meter = String(item.meterName || '')
      const skuName = String(item.skuName || '')
      let score = 0
      if (new RegExp(`^${tier}$`, 'i').test(skuName)) score += 50
      if (new RegExp(tier, 'i').test(product)) score += 10
      if (new RegExp(`${tier}\\s+unit$`, 'i').test(meter) || /^unit$/i.test(meter)) score += 40
      if (/workspace pack|self-hosted|secondary|gateway unit pack/i.test(meter)) score -= 40
      if (Number(item.retailPrice ?? 0) === 0) score -= 30
      if (/1\/hour|1 hour/i.test(String(item.unitOfMeasure || ''))) score += 10
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote(`${tier} unit base hours; scale units unknown`),
  })
}

async function lookupVpnGateway(regionId, hints) {
  const tier = hints.tier || 'VpnGw1'
  const items = await fetchRetailItems(
    `serviceName eq 'VPN Gateway' and ${regionFilter(regionId)}`,
  )
  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const meter = String(item.meterName || '')
      const skuName = String(item.skuName || '')
      let score = 0
      if (new RegExp(`^${tier}$`, 'i').test(meter) || new RegExp(`^${tier}$`, 'i').test(skuName)) {
        score += 60
      } else if (new RegExp(tier, 'i').test(meter) || new RegExp(tier, 'i').test(skuName)) {
        score += 20
      }
      if (/p2s|connection|data transfer|add-on|bandwidth/i.test(meter)) score -= 50
      if (/1 hour|1\/hour/i.test(String(item.unitOfMeasure || ''))) score += 10
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: 'base',
    note: basePriceNote(`${tier} gateway base hours; P2S/data transfer excluded`),
  })
}

async function lookupRedis(regionId, hints, serviceName) {
  const items = await fetchRetailItems(
    `serviceName eq '${odataEscape(serviceName)}' and ${regionFilter(regionId)}`,
  )
  // PaaS base-meter selection must include non-primary meters (e.g. Key Vault Operations).
  const picked = scoreAndPick(items, [
    (item) => {
      const meter = String(item.meterName || '')
      const skuName = String(item.skuName || '')
      const product = String(item.productName || '')
      const hay = `${product} ${skuName} ${meter}`
      let score = 0
      if (hints.raw && includesAny(hay, [hints.raw, hints.sku, hints.size].filter(Boolean))) score += 35
      if (/cache instance|cache/i.test(meter)) score += 15
      if (/1 hour|1\/hour/i.test(String(item.unitOfMeasure || ''))) score += 10
      if (/bandwidth|data transfer|geo/i.test(meter)) score -= 25
      return score
    },
  ])
  return toPriceResult(picked, {
    pricingMode: picked ? 'base' : 'exact',
    note: picked ? basePriceNote('cache instance base; shards/capacity assumed from SKU meter') : null,
  })
}

async function lookupGenericExact(regionId, serviceName, pricingSku) {
  const skuEsc = odataEscape(pricingSku)
  const regionEsc = odataEscape(regionId)
  const filters = []
  if (serviceName) {
    filters.push(
      `serviceName eq '${odataEscape(serviceName)}' and armRegionName eq '${regionEsc}' and armSkuName eq '${skuEsc}' and priceType eq 'Consumption'`,
    )
    filters.push(
      `serviceName eq '${odataEscape(serviceName)}' and armRegionName eq '${regionEsc}' and skuName eq '${skuEsc}' and priceType eq 'Consumption'`,
    )
  }
  filters.push(
    `armRegionName eq '${regionEsc}' and armSkuName eq '${skuEsc}' and priceType eq 'Consumption'`,
  )

  let lastError = null
  for (const filter of filters) {
    try {
      const items = await fetchRetailItems(filter)
      const picked = pickRetailItem(items, serviceName)
      if (!picked) continue
      return toPriceResult(picked, { pricingMode: 'exact', note: null })
    } catch (err) {
      lastError = err
    }
  }
  return {
    unitPrice: null,
    monthlyUnitPrice: null,
    currencyCode: null,
    unitOfMeasure: null,
    productName: null,
    meterName: null,
    armSkuName: pricingSku,
    pricingMode: 'none',
    note: lastError
      ? `Retail price lookup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      : looksLikeArmSku(pricingSku)
        ? 'No consumption retail price found for this SKU/region'
        : 'No base retail meter matched for this service/SKU',
  }
}

/**
 * @param {{ resourceType: string, sku: string, size?: string | null, regionId: string }} input
 */
export async function lookupRetailPrice(input) {
  const regionId = String(input.regionId || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
  const pricingSku = resolvePricingSku(input.sku, input.size)
  const resourceType = String(input.resourceType || '')
  const serviceName = RESOURCE_TYPE_SERVICE_NAME[resourceType] || null
  const hints = normalizeInventoryHints(resourceType, input.sku, input.size)

  if (!regionId || (!pricingSku && pricingSku !== '0') || pricingSku === '—') {
    return {
      unitPrice: null,
      monthlyUnitPrice: null,
      currencyCode: null,
      unitOfMeasure: null,
      productName: null,
      meterName: null,
      armSkuName: null,
      pricingMode: 'none',
      note: 'No SKU available for retail price lookup',
    }
  }

  const cacheKey = `${resourceType}|${serviceName || '*'}|${pricingSku}|${hints.tier || ''}|${hints.redundancy || ''}|${regionId}`
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey)

  const promise = (async () => {
    try {
      if (resourceType === 'Application Gateway') {
        return (await lookupApplicationGateway(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'Key Vault') {
        return (await lookupKeyVault(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'Storage Account') {
        return (await lookupStorageAccount(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'Azure Cosmos DB') {
        return (await lookupCosmosDb(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'API Management') {
        return (await lookupApiManagement(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'VPN Gateway') {
        return (await lookupVpnGateway(regionId, hints)) || (await lookupGenericExact(regionId, serviceName, pricingSku))
      }
      if (resourceType === 'Azure Cache for Redis' || resourceType === 'Azure Managed Redis') {
        return (
          (await lookupRedis(regionId, hints, serviceName)) ||
          (await lookupGenericExact(regionId, serviceName, pricingSku))
        )
      }

      // VM / SQL / other: prefer exact ARM SKU match.
      return await lookupGenericExact(regionId, serviceName, pricingSku)
    } catch (err) {
      return {
        unitPrice: null,
        monthlyUnitPrice: null,
        currencyCode: null,
        unitOfMeasure: null,
        productName: null,
        meterName: null,
        armSkuName: pricingSku,
        pricingMode: 'none',
        note: `Retail price lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })()

  priceCache.set(cacheKey, promise)
  return promise
}

/**
 * Enrich evaluation region cells with retail cost fields.
 * Fills `byRegion` (targets) and `bySourceRegion` (current deployment regions).
 */
export async function enrichResultsWithRetailPrices(results, targetRegions, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency) || 8)
  /** @type {Array<{ row: any, regionId: string, bag: 'byRegion' | 'bySourceRegion' }>} */
  const jobs = []

  for (const row of results) {
    for (const region of targetRegions) {
      jobs.push({ row, regionId: region.id, bag: 'byRegion' })
    }
    for (const regionId of Object.keys(row.bySourceRegion || {})) {
      jobs.push({ row, regionId, bag: 'bySourceRegion' })
    }
  }

  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor
      cursor += 1
      const job = jobs[index]
      const price = await lookupRetailPrice({
        resourceType: job.row.resourceType,
        sku: job.row.sku,
        size: job.row.size,
        regionId: job.regionId,
      })
      const bag = job.row[job.bag] || {}
      const cell = bag[job.regionId]
      if (!cell) continue

      let count = Number(job.row.resourceCount || 0)
      if (job.bag === 'bySourceRegion') {
        const perSource = job.row.sourceRegionCounts?.[job.regionId]
        if (perSource != null && Number.isFinite(Number(perSource))) {
          count = Number(perSource)
        }
      }

      const monthlyUnit = price?.monthlyUnitPrice ?? null
      cell.unitPrice = price?.unitPrice ?? null
      cell.monthlyUnitPrice = monthlyUnit
      cell.monthlyTotalPrice =
        monthlyUnit != null && Number.isFinite(count) ? monthlyUnit * count : null
      cell.currencyCode = price?.currencyCode ?? null
      cell.unitOfMeasure = price?.unitOfMeasure ?? null
      cell.productName = price?.productName ?? null
      cell.meterName = price?.meterName ?? null
      cell.costNote = price?.note ?? null
      cell.pricingMode = price?.pricingMode ?? null
      cell.resourceCount = count
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker()))
  return results
}

export function formatMoney(amount, currencyCode = 'USD') {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode || 'USD',
      maximumFractionDigits: Number(amount) < 1 ? 4 : 2,
    }).format(Number(amount))
  } catch {
    return `${Number(amount).toFixed(4)} ${currencyCode || 'USD'}`
  }
}
