import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { CANONICAL_RESOURCE_TYPES, SUGGESTED_SKU_FAMILIES, toSkuFamily } from './skuFamily.mjs'

const { Pool } = pg

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://pcm:pcm@127.0.0.1:5432/pcm'

const useSsl =
  process.env.PGSSL === 'true' ||
  /(?:^|[?&])sslmode=(?:require|verify-ca|verify-full)/i.test(DATABASE_URL)

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ...(useSsl
    ? {
        ssl: {
          // Azure Flexible Server typically requires TLS; set PGSSL_REJECT_UNAUTHORIZED=true
          // once you trust the server CA in the container.
          rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED === 'true',
        },
      }
    : {}),
})

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tenant_id TEXT NOT NULL UNIQUE,
      csa_owner_id TEXT NOT NULL,
      segment TEXT NOT NULL DEFAULT 'Connected tenant',
      industry TEXT NOT NULL DEFAULT 'Azure tenant',
      region_focus JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_synced_at TIMESTAMPTZ,
      sync_source TEXT NOT NULL DEFAULT 'Customer tenant',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      subscription_id TEXT NOT NULL UNIQUE,
      regions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL,
      azure_subscription_id TEXT,
      resource_type TEXT NOT NULL,
      sku TEXT NOT NULL,
      size TEXT,
      region TEXT NOT NULL,
      resource_group TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'Customer tenant',
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_customer ON inventory_items(customer_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_subscription ON inventory_items(subscription_id);

    CREATE TABLE IF NOT EXISTS quota_items (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      subscription_id TEXT,
      azure_subscription_id TEXT NOT NULL,
      subscription_name TEXT,
      tenant_id TEXT,
      region TEXT NOT NULL,
      name TEXT NOT NULL,
      name_value TEXT,
      usage INTEGER NOT NULL DEFAULT 0,
      limit_value INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'Count',
      source TEXT NOT NULL,
      quota_group TEXT,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_quota_azure_sub ON quota_items(azure_subscription_id);

    CREATE TABLE IF NOT EXISTS quota_group_limits (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
      tenant_id TEXT,
      management_group_id TEXT NOT NULL,
      group_quota_name TEXT NOT NULL,
      group_display_name TEXT,
      subscription_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      region TEXT NOT NULL,
      name TEXT NOT NULL,
      name_value TEXT,
      limit_value INTEGER NOT NULL DEFAULT 0,
      available_limit INTEGER NOT NULL DEFAULT 0,
      allocated INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'Count',
      resource_provider TEXT NOT NULL DEFAULT 'Microsoft.Compute',
      source TEXT NOT NULL,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_quota_group_limits_customer ON quota_group_limits(customer_id);
    CREATE INDEX IF NOT EXISTS idx_quota_group_limits_group ON quota_group_limits(group_quota_name);

    CREATE TABLE IF NOT EXISTS azure_connections (
      id TEXT PRIMARY KEY DEFAULT 'default',
      tenant_id TEXT,
      organization_name TEXT,
      selected_subscription_id TEXT,
      selected_subscription_name TEXT,
      account_json JSONB,
      status TEXT NOT NULL DEFAULT 'idle',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS saved_reports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
      config JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_saved_reports_owner ON saved_reports(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_saved_reports_visibility ON saved_reports(visibility);

    CREATE TABLE IF NOT EXISTS region_evaluations (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_name TEXT,
      azure_subscription_id TEXT,
      subscription_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      subscription_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_regions JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      results JSONB NOT NULL DEFAULT '[]'::jsonb,
      line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_region_evaluations_customer
      ON region_evaluations(customer_id);
    CREATE INDEX IF NOT EXISTS idx_region_evaluations_created
      ON region_evaluations(created_at DESC);
  `)

  const { initDomainTables } = await import('./domain-db.mjs')
  await initDomainTables()

  const qgCount = await pool.query('SELECT COUNT(*)::int AS n FROM quota_group_limits')
  if (qgCount.rows[0].n === 0) {
    const { seedQuotaGroupLimits } = await import('./seed-data.mjs')
    for (const item of seedQuotaGroupLimits) {
      await pool.query(
        `
        INSERT INTO quota_group_limits (
          id, customer_id, tenant_id, management_group_id, group_quota_name, group_display_name,
          subscription_ids, region, name, name_value, limit_value, available_limit, allocated,
          unit, resource_provider, source, collected_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
        ON CONFLICT (id) DO NOTHING
        `,
        [
          item.id,
          item.customerId,
          item.tenantId,
          item.managementGroupId,
          item.groupQuotaName,
          item.groupDisplayName,
          JSON.stringify(item.subscriptionIds || []),
          item.region,
          item.name,
          item.nameValue || null,
          item.limit,
          item.availableLimit,
          item.allocated,
          item.unit,
          item.resourceProvider || 'Microsoft.Compute',
          item.source || 'Demo seed',
        ],
      )
    }
  }
}

function mapCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    tenantId: row.tenant_id,
    csaOwnerId: row.csa_owner_id,
    segment: row.segment,
    industry: row.industry,
    regionFocus: row.region_focus || [],
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    syncSource: row.sync_source,
  }
}

function mapSubscription(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    subscriptionId: row.subscription_id,
    regions: row.regions || [],
  }
}

function mapInventory(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    resourceType: row.resource_type,
    sku: row.sku,
    size: row.size || undefined,
    region: row.region,
    resourceGroup: row.resource_group,
    name: row.name,
    source: row.source,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : undefined,
  }
}

function mapQuota(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    azureSubscriptionId: row.azure_subscription_id,
    subscriptionName: row.subscription_name,
    tenantId: row.tenant_id,
    region: row.region,
    name: row.name,
    nameValue: row.name_value,
    usage: row.usage,
    limit: row.limit_value,
    unit: row.unit,
    source: row.source,
    quotaGroup: row.quota_group,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : undefined,
  }
}

function mapQuotaGroupLimit(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    tenantId: row.tenant_id,
    managementGroupId: row.management_group_id,
    groupQuotaName: row.group_quota_name,
    groupDisplayName: row.group_display_name,
    subscriptionIds: row.subscription_ids || [],
    region: row.region,
    name: row.name,
    nameValue: row.name_value,
    limit: row.limit_value,
    availableLimit: row.available_limit,
    allocated: row.allocated,
    unit: row.unit,
    resourceProvider: row.resource_provider,
    source: row.source,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : undefined,
  }
}

export async function getBootstrap() {
  const [customers, subscriptions, inventory, quotas, quotaGroupLimits, connection] =
    await Promise.all([
    pool.query('SELECT * FROM customers ORDER BY updated_at DESC NULLS LAST, name ASC'),
    pool.query('SELECT * FROM subscriptions ORDER BY name ASC'),
    pool.query('SELECT * FROM inventory_items ORDER BY collected_at DESC, name ASC'),
    pool.query('SELECT * FROM quota_items ORDER BY collected_at DESC, name ASC'),
    pool.query('SELECT * FROM quota_group_limits ORDER BY collected_at DESC, name ASC'),
    pool.query(`SELECT * FROM azure_connections WHERE id = 'default'`),
  ])

  const { listDomainBootstrap } = await import('./domain-db.mjs')
  const domain = await listDomainBootstrap()

  const conn = connection.rows[0]
  return {
    customers: customers.rows.map(mapCustomer),
    subscriptions: subscriptions.rows.map(mapSubscription),
    inventory: inventory.rows.map(mapInventory),
    quotas: quotas.rows.map(mapQuota),
    quotaGroupLimits: quotaGroupLimits.rows.map(mapQuotaGroupLimit),
    connection: conn
      ? {
          tenantId: conn.tenant_id,
          organizationName: conn.organization_name,
          selectedSubscriptionId: conn.selected_subscription_id,
          selectedSubscriptionName: conn.selected_subscription_name,
          account: conn.account_json,
          status: conn.status,
          updatedAt: conn.updated_at ? new Date(conn.updated_at).toISOString() : null,
        }
      : null,
    ...domain,
  }
}

/** Distinct resource types present in inventory, merged with canonical constraint types. */
export async function listInventoryResourceTypes() {
  const result = await pool.query(
    `
      SELECT resource_type AS "resourceType", COUNT(*)::int AS "resourceCount"
      FROM inventory_items
      WHERE resource_type IS NOT NULL AND BTRIM(resource_type) <> ''
      GROUP BY resource_type
      ORDER BY resource_type ASC
    `,
  )
  const counts = new Map(
    result.rows.map((row) => [row.resourceType, row.resourceCount]),
  )
  for (const type of CANONICAL_RESOURCE_TYPES) {
    if (!counts.has(type)) counts.set(type, 0)
  }
  return [...counts.entries()]
    .map(([resourceType, resourceCount]) => ({ resourceType, resourceCount }))
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType))
}

/**
 * Distinct SKU families/series for a resource type (not exact VM sizes).
 * @param {string} resourceType
 */
function mergeSuggestedFamilies(resourceType, families) {
  const suggestions = SUGGESTED_SKU_FAMILIES[resourceType] || []
  if (suggestions.length === 0) return families
  const existing = new Set(families.map((f) => f.sku.toLowerCase()))
  const merged = [...families]
  for (const sku of suggestions) {
    if (existing.has(sku.toLowerCase())) continue
    merged.push({ sku, resourceCount: 0, regions: [], sizes: [] })
  }
  return merged.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }))
}

/**
 * Distinct SKU families/series for a resource type (not exact VM sizes).
 * @param {string} resourceType
 */
export async function listInventorySkus(resourceType) {
  if (!resourceType) return []
  const result = await pool.query(
    `
      SELECT sku, size, region
      FROM inventory_items
      WHERE resource_type = $1
        AND sku IS NOT NULL
        AND BTRIM(sku) <> ''
    `,
    [resourceType],
  )

  /** @type {Map<string, { sku: string, resourceCount: number, regions: Set<string>, sizes: Set<string> }>} */
  const families = new Map()
  for (const row of result.rows) {
    const family = toSkuFamily(row.sku, row.size)
    if (!family) continue
    const key = family.toLowerCase()
    let entry = families.get(key)
    if (!entry) {
      entry = {
        sku: family,
        resourceCount: 0,
        regions: new Set(),
        sizes: new Set(),
      }
      families.set(key, entry)
    }
    entry.resourceCount += 1
    if (row.region) entry.regions.add(row.region)
    const exact = String(row.sku || '').trim()
    if (exact && exact.toLowerCase() !== family.toLowerCase()) entry.sizes.add(exact)
  }

  const fromInventory = [...families.values()].map((entry) => ({
    sku: entry.sku,
    resourceCount: entry.resourceCount,
    regions: [...entry.regions].sort((a, b) => a.localeCompare(b)),
    sizes: [...entry.sizes].sort((a, b) => a.localeCompare(b)),
  }))

  return mergeSuggestedFamilies(resourceType, fromInventory)
}

/**
 * Impact analysis against the full inventory table in Postgres.
 * Matches SKU family/series (not only exact size), resource type, and region.
 * @param {{
 *   sku: string
 *   resourceType: string
 *   regions: string[]
 *   customerId?: string | null
 *   subscriptionId?: string | null
 *   constraintId?: string
 * }} input
 */
export async function runInventoryImpactAnalysis(input) {
  const sku = String(input?.sku || '').trim()
  const resourceType = String(input?.resourceType || '').trim()
  const regions = Array.isArray(input?.regions)
    ? input.regions.map((r) => String(r).trim()).filter(Boolean)
    : []
  const customerId = input?.customerId || null
  const subscriptionId = input?.subscriptionId || null
  const constraintId = input?.constraintId || 'preview'
  const family = toSkuFamily(sku).toLowerCase()

  if (!sku || !resourceType || regions.length === 0) {
    return []
  }

  const result = await pool.query(
    `
      SELECT
        i.customer_id AS "customerId",
        i.subscription_id AS "subscriptionId",
        i.region,
        i.sku,
        i.size
      FROM inventory_items i
      WHERE i.resource_type = $1
        AND (
          EXISTS (
            SELECT 1
            FROM unnest($2::text[]) AS r(region_name)
            WHERE regexp_replace(lower(i.region), '[^a-z0-9]', '', 'g')
                = regexp_replace(lower(r.region_name), '[^a-z0-9]', '', 'g')
          )
        )
        AND ($3::text IS NULL OR i.customer_id = $3)
        AND ($4::text IS NULL OR i.subscription_id = $4)
    `,
    [resourceType, regions, customerId, subscriptionId],
  )

  /** @type {Map<string, { customerId: string, subscriptionId: string, region: string, matchingResourceCount: number, skus: Set<string> }>} */
  const groups = new Map()
  for (const row of result.rows) {
    const rowFamily = toSkuFamily(row.sku, row.size).toLowerCase()
    const exactSku = String(row.sku || '').trim()
    const exactSize = String(row.size || '').trim()
    const matches =
      (family && rowFamily === family) ||
      exactSku.toLowerCase() === sku.toLowerCase() ||
      (exactSize && exactSize.toLowerCase() === sku.toLowerCase())
    if (!matches) continue

    const key = `${row.customerId}|${row.subscriptionId}|${row.region}`
    let group = groups.get(key)
    if (!group) {
      group = {
        customerId: row.customerId,
        subscriptionId: row.subscriptionId,
        region: row.region,
        matchingResourceCount: 0,
        skus: new Set(),
      }
      groups.set(key, group)
    }
    group.matchingResourceCount += 1
    if (exactSku) group.skus.add(exactSku)
  }

  return [...groups.values()]
    .map((group) => ({
      id: `imp-${constraintId}-${group.customerId}|${group.subscriptionId}|${group.region}`,
      constraintId,
      customerId: group.customerId,
      subscriptionId: group.subscriptionId,
      region: group.region,
      matchingResourceCount: group.matchingResourceCount,
      skus: [...group.skus].sort((a, b) => a.localeCompare(b)),
    }))
    .sort(
      (a, b) =>
        b.matchingResourceCount - a.matchingResourceCount ||
        a.region.localeCompare(b.region),
    )
}

export async function upsertCustomer(customer) {
  const existing = await pool.query(
    `SELECT id FROM customers WHERE id = $1 OR tenant_id = $2 LIMIT 1`,
    [customer.id, customer.tenantId],
  )
  const id = existing.rows[0]?.id || customer.id

  await pool.query(
    `
    INSERT INTO customers (
      id, name, tenant_id, csa_owner_id, segment, industry, region_focus,
      last_synced_at, sync_source, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      tenant_id = EXCLUDED.tenant_id,
      csa_owner_id = EXCLUDED.csa_owner_id,
      segment = EXCLUDED.segment,
      industry = EXCLUDED.industry,
      region_focus = EXCLUDED.region_focus,
      last_synced_at = EXCLUDED.last_synced_at,
      sync_source = EXCLUDED.sync_source,
      updated_at = NOW()
    `,
    [
      id,
      customer.name,
      customer.tenantId,
      customer.csaOwnerId,
      customer.segment || 'Connected tenant',
      customer.industry || 'Azure tenant',
      JSON.stringify(customer.regionFocus || []),
      customer.lastSyncedAt || new Date().toISOString(),
      customer.syncSource || 'Customer tenant',
    ],
  )
  return { ...customer, id }
}

export async function upsertSubscription(subscription) {
  const existing = await pool.query(
    `SELECT id FROM subscriptions WHERE id = $1 OR subscription_id = $2 LIMIT 1`,
    [subscription.id, subscription.subscriptionId],
  )
  const id = existing.rows[0]?.id || subscription.id

  await pool.query(
    `
    INSERT INTO subscriptions (
      id, customer_id, name, subscription_id, regions, updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
    ON CONFLICT (id) DO UPDATE SET
      customer_id = EXCLUDED.customer_id,
      name = EXCLUDED.name,
      subscription_id = EXCLUDED.subscription_id,
      regions = EXCLUDED.regions,
      updated_at = NOW()
    `,
    [
      id,
      subscription.customerId,
      subscription.name,
      subscription.subscriptionId,
      JSON.stringify(subscription.regions || []),
    ],
  )
  return { ...subscription, id }
}

export async function replaceInventory({ customerId, subscriptionId, items }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM inventory_items WHERE customer_id = $1 AND subscription_id = $2`,
      [customerId, subscriptionId],
    )
    for (const item of items) {
      try {
        await client.query(
          `
          INSERT INTO inventory_items (
            id, customer_id, subscription_id, azure_subscription_id, resource_type,
            sku, size, region, resource_group, name, source, collected_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          `,
          [
            item.id,
            customerId,
            subscriptionId,
            item.azureSubscriptionId || null,
            item.resourceType,
            item.sku,
            item.size || null,
            item.region,
            item.resourceGroup,
            item.name,
            item.source || 'Customer tenant',
            item.collectedAt || new Date().toISOString(),
          ],
        )
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err)
        throw Object.assign(
          new Error(
            `Failed to store inventory item "${item.name || 'unknown'}" (${item.resourceType || 'unknown type'}) in database: ${base}`,
          ),
          err && typeof err === 'object' && 'code' in err ? { code: err.code } : {},
        )
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { imported: items.length }
}

export async function replaceQuotas({ azureSubscriptionId, customerId, subscriptionId, items }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM quota_items WHERE azure_subscription_id = $1`, [
      azureSubscriptionId,
    ])
    for (const item of items) {
      await client.query(
        `
        INSERT INTO quota_items (
          id, customer_id, subscription_id, azure_subscription_id, subscription_name,
          tenant_id, region, name, name_value, usage, limit_value, unit, source,
          quota_group, collected_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `,
        [
          item.id,
          customerId || null,
          subscriptionId || null,
          azureSubscriptionId,
          item.subscriptionName || null,
          item.tenantId || null,
          item.region,
          item.name,
          item.nameValue || null,
          item.usage ?? 0,
          item.limit ?? 0,
          item.unit || 'Count',
          item.source || 'Azure Compute Usage API',
          item.quotaGroup || null,
          item.collectedAt || new Date().toISOString(),
        ],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { imported: items.length }
}

export async function replaceQuotaGroupLimits({ customerId, tenantId, items }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (customerId) {
      await client.query(`DELETE FROM quota_group_limits WHERE customer_id = $1`, [customerId])
    } else if (tenantId) {
      await client.query(`DELETE FROM quota_group_limits WHERE tenant_id = $1`, [tenantId])
    }
    for (const item of items) {
      await client.query(
        `
        INSERT INTO quota_group_limits (
          id, customer_id, tenant_id, management_group_id, group_quota_name, group_display_name,
          subscription_ids, region, name, name_value, limit_value, available_limit, allocated,
          unit, resource_provider, source, collected_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `,
        [
          item.id,
          customerId || item.customerId || null,
          tenantId || item.tenantId || null,
          item.managementGroupId,
          item.groupQuotaName,
          item.groupDisplayName || null,
          JSON.stringify(item.subscriptionIds || []),
          item.region,
          item.name,
          item.nameValue || null,
          item.limit ?? 0,
          item.availableLimit ?? 0,
          item.allocated ?? 0,
          item.unit || 'Count',
          item.resourceProvider || 'Microsoft.Compute',
          item.source || 'Azure Quota Groups API',
          item.collectedAt || new Date().toISOString(),
        ],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return { imported: items.length }
}

export async function saveConnection(connection) {
  await pool.query(
    `
    INSERT INTO azure_connections (
      id, tenant_id, organization_name, selected_subscription_id,
      selected_subscription_name, account_json, status, updated_at
    ) VALUES ('default',$1,$2,$3,$4,$5::jsonb,$6,NOW())
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      organization_name = EXCLUDED.organization_name,
      selected_subscription_id = EXCLUDED.selected_subscription_id,
      selected_subscription_name = EXCLUDED.selected_subscription_name,
      account_json = EXCLUDED.account_json,
      status = EXCLUDED.status,
      updated_at = NOW()
    `,
    [
      connection.tenantId || null,
      connection.organizationName || null,
      connection.selectedSubscriptionId || null,
      connection.selectedSubscriptionName || null,
      JSON.stringify(connection.account || null),
      connection.status || 'idle',
    ],
  )
  return connection
}

export async function clearConnection() {
  await pool.query(
    `
    INSERT INTO azure_connections (id, status, updated_at)
    VALUES ('default', 'idle', NOW())
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = NULL,
      organization_name = NULL,
      selected_subscription_id = NULL,
      selected_subscription_name = NULL,
      account_json = NULL,
      status = 'idle',
      updated_at = NOW()
    `,
  )
}

export async function seedIfEmpty() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(742001)')
    const count = await client.query('SELECT COUNT(*)::int AS n FROM customers')
    if (count.rows[0].n > 0) {
      await client.query('COMMIT')
      return false
    }

    const { seedCustomers, seedSubscriptions, seedInventory, seedQuotas, seedQuotaGroupLimits } =
      await import('./seed-data.mjs')

    for (const customer of seedCustomers) {
      await client.query(
        `
        INSERT INTO customers (
          id, name, tenant_id, csa_owner_id, segment, industry, region_focus,
          last_synced_at, sync_source, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,NOW())
        ON CONFLICT (tenant_id) DO NOTHING
        `,
        [
          customer.id,
          customer.name,
          customer.tenantId,
          customer.csaOwnerId,
          customer.segment,
          customer.industry,
          JSON.stringify(customer.regionFocus || []),
          customer.lastSyncedAt,
          customer.syncSource,
        ],
      )
    }

    for (const subscription of seedSubscriptions) {
      await client.query(
        `
        INSERT INTO subscriptions (
          id, customer_id, name, subscription_id, regions, updated_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
        ON CONFLICT (subscription_id) DO NOTHING
        `,
        [
          subscription.id,
          subscription.customerId,
          subscription.name,
          subscription.subscriptionId,
          JSON.stringify(subscription.regions || []),
        ],
      )
    }

    for (const item of seedInventory) {
      await client.query(
        `
        INSERT INTO inventory_items (
          id, customer_id, subscription_id, resource_type, sku, size, region,
          resource_group, name, source, collected_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (id) DO NOTHING
        `,
        [
          item.id,
          item.customerId,
          item.subscriptionId,
          item.resourceType,
          item.sku,
          item.size || null,
          item.region,
          item.resourceGroup,
          item.name,
          item.source,
        ],
      )
    }

    for (const subscription of seedSubscriptions) {
      const items = seedQuotas.filter((q) => q.subscriptionId === subscription.id)
      for (const item of items) {
        await client.query(
          `
          INSERT INTO quota_items (
            id, customer_id, subscription_id, azure_subscription_id, subscription_name,
            region, name, usage, limit_value, unit, source, quota_group, collected_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
          ON CONFLICT (id) DO NOTHING
          `,
          [
            item.id,
            item.customerId,
            item.subscriptionId,
            subscription.subscriptionId,
            subscription.name,
            item.region,
            item.name,
            item.usage,
            item.limit,
            item.unit,
            item.source || 'Demo seed',
            item.quotaGroup || null,
          ],
        )
      }
    }

    for (const item of seedQuotaGroupLimits) {
      await client.query(
        `
        INSERT INTO quota_group_limits (
          id, customer_id, tenant_id, management_group_id, group_quota_name, group_display_name,
          subscription_ids, region, name, name_value, limit_value, available_limit, allocated,
          unit, resource_provider, source, collected_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
        ON CONFLICT (id) DO NOTHING
        `,
        [
          item.id,
          item.customerId,
          item.tenantId,
          item.managementGroupId,
          item.groupQuotaName,
          item.groupDisplayName,
          JSON.stringify(item.subscriptionIds || []),
          item.region,
          item.name,
          item.nameValue || null,
          item.limit,
          item.availableLimit,
          item.allocated,
          item.unit,
          item.resourceProvider || 'Microsoft.Compute',
          item.source || 'Demo seed',
        ],
      )
    }

    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

function mapSavedReport(row) {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    config: row.config,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.created_at,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : row.updated_at,
  }
}

export async function listSavedReportsForUser(userId) {
  const result = await pool.query(
    `
      SELECT *
      FROM saved_reports
      WHERE visibility = 'shared' OR owner_user_id = $1
      ORDER BY updated_at DESC, name ASC
    `,
    [userId],
  )
  return result.rows.map(mapSavedReport)
}

export async function createSavedReport(report) {
  const result = await pool.query(
    `
      INSERT INTO saved_reports (id, name, owner_user_id, visibility, config, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
      RETURNING *
    `,
    [report.id, report.name, report.ownerUserId, report.visibility, JSON.stringify(report.config)],
  )
  return mapSavedReport(result.rows[0])
}

export async function deleteSavedReport(id, userId) {
  const result = await pool.query(
    `
      DELETE FROM saved_reports
      WHERE id = $1 AND owner_user_id = $2
      RETURNING id
    `,
    [id, userId],
  )
  return result.rowCount > 0
}

function mapRegionEvaluation(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    azureSubscriptionId: row.azure_subscription_id,
    subscriptionIds: row.subscription_ids || [],
    subscriptionNames: row.subscription_names || [],
    targetRegions: row.target_regions || [],
    summary: row.summary || {},
    results: row.results || [],
    lineItems: row.line_items || [],
    errors: row.errors || [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.created_at,
  }
}

export async function listRegionEvaluations({ customerId } = {}) {
  const params = []
  let where = ''
  if (customerId) {
    params.push(customerId)
    where = `WHERE customer_id = $${params.length}`
  }
  const result = await pool.query(
    `
      SELECT *
      FROM region_evaluations
      ${where}
      ORDER BY created_at DESC
    `,
    params,
  )
  return result.rows.map(mapRegionEvaluation)
}

export async function getRegionEvaluation(id) {
  const result = await pool.query(`SELECT * FROM region_evaluations WHERE id = $1`, [id])
  if (!result.rows[0]) return null
  return mapRegionEvaluation(result.rows[0])
}

export async function createRegionEvaluation(evaluation) {
  const id = evaluation.id || `reval-${randomUUID()}`
  const result = await pool.query(
    `
      INSERT INTO region_evaluations (
        id, customer_id, customer_name, created_by_user_id, created_by_name,
        azure_subscription_id, subscription_ids, subscription_names, target_regions,
        summary, results, line_items, errors, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,NOW()
      )
      RETURNING *
    `,
    [
      id,
      evaluation.customerId,
      evaluation.customerName,
      evaluation.createdByUserId || null,
      evaluation.createdByName || null,
      evaluation.azureSubscriptionId || null,
      JSON.stringify(evaluation.subscriptionIds || []),
      JSON.stringify(evaluation.subscriptionNames || []),
      JSON.stringify(evaluation.targetRegions || []),
      JSON.stringify(evaluation.summary || {}),
      JSON.stringify(evaluation.results || []),
      JSON.stringify(evaluation.lineItems || []),
      JSON.stringify(evaluation.errors || []),
    ],
  )
  return mapRegionEvaluation(result.rows[0])
}

export async function deleteRegionEvaluation(id) {
  const result = await pool.query(
    `DELETE FROM region_evaluations WHERE id = $1 RETURNING id`,
    [id],
  )
  return result.rowCount > 0
}
