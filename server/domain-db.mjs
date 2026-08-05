import { pool } from './db.mjs'

function mapHistory(row) {
  return {
    id: row.id,
    at: row.at ? new Date(row.at).toISOString() : row.at,
    by: row.by_user,
    action: row.action,
    detail: row.detail,
  }
}

function mapConstraint(row, history = []) {
  return {
    id: row.id,
    sku: row.sku,
    resourceType: row.resource_type,
    regions: row.regions || [],
    scope: row.scope,
    subscriptionId: row.subscription_id || undefined,
    customerId: row.customer_id || undefined,
    reportedDate: row.reported_date ? new Date(row.reported_date).toISOString() : row.reported_date,
    source: row.source,
    severity: row.severity,
    status: row.status,
    description: row.description,
    createdBy: row.created_by,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : row.updated_at,
    history,
  }
}

function mapImpact(row) {
  return {
    id: row.id,
    constraintId: row.constraint_id,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    region: row.region,
    matchingResourceCount: row.matching_resource_count,
    skus: row.skus || [],
  }
}

function mapAlert(row) {
  return {
    id: row.id,
    constraintId: row.constraint_id,
    customerId: row.customer_id,
    csaOwnerId: row.csa_owner_id,
    channel: row.channel,
    title: row.title,
    message: row.message,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.created_at,
    read: Boolean(row.read),
  }
}

function mapEngagement(row) {
  return {
    id: row.id,
    constraintId: row.constraint_id,
    customerId: row.customer_id,
    initiatedBy: row.initiated_by,
    status: row.status,
    notes: row.notes || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.created_at,
  }
}

function mapReward(row) {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    points: row.points,
    label: row.label,
    relatedId: row.related_id || undefined,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.created_at,
  }
}

export async function initDomainTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS capacity_constraints (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      regions JSONB NOT NULL DEFAULT '[]'::jsonb,
      scope TEXT NOT NULL,
      subscription_id TEXT,
      customer_id TEXT,
      reported_date TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS constraint_history (
      id TEXT PRIMARY KEY,
      constraint_id TEXT NOT NULL REFERENCES capacity_constraints(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL,
      by_user TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_constraint_history_constraint
      ON constraint_history(constraint_id);

    CREATE TABLE IF NOT EXISTS impact_results (
      id TEXT PRIMARY KEY,
      constraint_id TEXT NOT NULL REFERENCES capacity_constraints(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      region TEXT NOT NULL,
      matching_resource_count INTEGER NOT NULL DEFAULT 0,
      skus JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_impact_constraint ON impact_results(constraint_id);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      constraint_id TEXT NOT NULL REFERENCES capacity_constraints(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      csa_owner_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_constraint ON alerts(constraint_id);

    CREATE TABLE IF NOT EXISTS engagements (
      id TEXT PRIMARY KEY,
      constraint_id TEXT NOT NULL REFERENCES capacity_constraints(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      initiated_by TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      points INTEGER NOT NULL,
      label TEXT NOT NULL,
      related_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reward_user ON reward_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_reward_created ON reward_events(created_at DESC);
  `)
}

export async function listDomainBootstrap() {
  const [constraints, history, impacts, alerts, engagements, rewards] = await Promise.all([
    pool.query('SELECT * FROM capacity_constraints ORDER BY updated_at DESC'),
    pool.query('SELECT * FROM constraint_history ORDER BY at ASC'),
    pool.query('SELECT * FROM impact_results ORDER BY id ASC'),
    pool.query('SELECT * FROM alerts ORDER BY created_at DESC'),
    pool.query('SELECT * FROM engagements ORDER BY created_at DESC'),
    pool.query('SELECT * FROM reward_events ORDER BY created_at DESC'),
  ])

  const historyByConstraint = new Map()
  for (const row of history.rows) {
    const list = historyByConstraint.get(row.constraint_id) || []
    list.push(mapHistory(row))
    historyByConstraint.set(row.constraint_id, list)
  }

  return {
    constraints: constraints.rows.map((row) =>
      mapConstraint(row, historyByConstraint.get(row.id) || []),
    ),
    impactResults: impacts.rows.map(mapImpact),
    alerts: alerts.rows.map(mapAlert),
    engagements: engagements.rows.map(mapEngagement),
    rewardEvents: rewards.rows.map(mapReward),
  }
}

/**
 * @param {object} constraint
 * @param {import('pg').PoolClient} [client]
 */
export async function upsertConstraint(constraint, client = pool) {
  if (!constraint?.id) throw new Error('constraint.id is required')
  await client.query(
    `
    INSERT INTO capacity_constraints (
      id, sku, resource_type, regions, scope, subscription_id, customer_id,
      reported_date, source, severity, status, description, created_by, updated_at
    ) VALUES (
      $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
    )
    ON CONFLICT (id) DO UPDATE SET
      sku = EXCLUDED.sku,
      resource_type = EXCLUDED.resource_type,
      regions = EXCLUDED.regions,
      scope = EXCLUDED.scope,
      subscription_id = EXCLUDED.subscription_id,
      customer_id = EXCLUDED.customer_id,
      reported_date = EXCLUDED.reported_date,
      source = EXCLUDED.source,
      severity = EXCLUDED.severity,
      status = EXCLUDED.status,
      description = EXCLUDED.description,
      created_by = EXCLUDED.created_by,
      updated_at = EXCLUDED.updated_at
    `,
    [
      constraint.id,
      constraint.sku,
      constraint.resourceType,
      JSON.stringify(constraint.regions || []),
      constraint.scope,
      constraint.subscriptionId || null,
      constraint.customerId || null,
      constraint.reportedDate,
      constraint.source,
      constraint.severity,
      constraint.status,
      constraint.description,
      constraint.createdBy,
      constraint.updatedAt || new Date().toISOString(),
    ],
  )

  await client.query('DELETE FROM constraint_history WHERE constraint_id = $1', [constraint.id])
  for (const entry of constraint.history || []) {
    await client.query(
      `
      INSERT INTO constraint_history (id, constraint_id, at, by_user, action, detail)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET
        constraint_id = EXCLUDED.constraint_id,
        at = EXCLUDED.at,
        by_user = EXCLUDED.by_user,
        action = EXCLUDED.action,
        detail = EXCLUDED.detail
      `,
      [entry.id, constraint.id, entry.at, entry.by, entry.action, entry.detail],
    )
  }

  return constraint
}

/**
 * @param {string} constraintId
 * @param {object[]} impacts
 * @param {import('pg').PoolClient} [client]
 */
export async function replaceImpactsForConstraint(constraintId, impacts, client = pool) {
  await client.query('DELETE FROM impact_results WHERE constraint_id = $1', [constraintId])
  for (const impact of impacts || []) {
    await client.query(
      `
      INSERT INTO impact_results (
        id, constraint_id, customer_id, subscription_id, region,
        matching_resource_count, skus
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `,
      [
        impact.id,
        constraintId,
        impact.customerId,
        impact.subscriptionId,
        impact.region,
        impact.matchingResourceCount,
        JSON.stringify(impact.skus || []),
      ],
    )
  }
  return impacts || []
}

/**
 * @param {object[]} alerts
 * @param {import('pg').PoolClient} [client]
 */
export async function upsertAlerts(alerts, client = pool) {
  for (const alert of alerts || []) {
    await client.query(
      `
      INSERT INTO alerts (
        id, constraint_id, customer_id, csa_owner_id, channel, title, message, created_at, read
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        constraint_id = EXCLUDED.constraint_id,
        customer_id = EXCLUDED.customer_id,
        csa_owner_id = EXCLUDED.csa_owner_id,
        channel = EXCLUDED.channel,
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        created_at = EXCLUDED.created_at,
        read = EXCLUDED.read
      `,
      [
        alert.id,
        alert.constraintId,
        alert.customerId,
        alert.csaOwnerId,
        alert.channel,
        alert.title,
        alert.message,
        alert.createdAt,
        Boolean(alert.read),
      ],
    )
  }
  return alerts || []
}

export async function markAlertReadDb(id) {
  const result = await pool.query(
    `UPDATE alerts SET read = TRUE WHERE id = $1 RETURNING *`,
    [id],
  )
  return result.rows[0] ? mapAlert(result.rows[0]) : null
}

export async function upsertEngagement(engagement) {
  await pool.query(
    `
    INSERT INTO engagements (
      id, constraint_id, customer_id, initiated_by, status, notes, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET
      constraint_id = EXCLUDED.constraint_id,
      customer_id = EXCLUDED.customer_id,
      initiated_by = EXCLUDED.initiated_by,
      status = EXCLUDED.status,
      notes = EXCLUDED.notes,
      created_at = EXCLUDED.created_at
    `,
    [
      engagement.id,
      engagement.constraintId,
      engagement.customerId,
      engagement.initiatedBy,
      engagement.status,
      engagement.notes || '',
      engagement.createdAt,
    ],
  )
  return engagement
}

export async function insertRewardEvent(event) {
  await pool.query(
    `
    INSERT INTO reward_events (
      id, user_id, action, points, label, related_id, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO NOTHING
    `,
    [
      event.id,
      event.userId,
      event.action,
      event.points,
      event.label,
      event.relatedId || null,
      event.createdAt,
    ],
  )
  return event
}

/**
 * Persist a newly created constraint with impacts, alerts, and optional reward in one transaction.
 */
export async function persistConstraintBundle({
  constraint,
  impacts = [],
  alerts = [],
  reward = null,
}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await upsertConstraint(constraint, client)
    await replaceImpactsForConstraint(constraint.id, impacts, client)
    await upsertAlerts(alerts, client)
    if (reward) {
      await client.query(
        `
        INSERT INTO reward_events (
          id, user_id, action, points, label, related_id, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          reward.id,
          reward.userId,
          reward.action,
          reward.points,
          reward.label,
          reward.relatedId || null,
          reward.createdAt,
        ],
      )
    }
    await client.query('COMMIT')
    return { constraint, impacts, alerts, reward }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function seedDomainIfEmpty() {
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM capacity_constraints')
  if (count.rows[0].n > 0) return false

  const {
    seedConstraints,
    seedImpacts,
    seedAlerts,
    seedEngagements,
    seedRewards,
  } = await import('./seed-domain.mjs')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const constraint of seedConstraints) {
      await upsertConstraint(constraint, client)
    }
    for (const impact of seedImpacts) {
      await client.query(
        `
        INSERT INTO impact_results (
          id, constraint_id, customer_id, subscription_id, region,
          matching_resource_count, skus
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          impact.id,
          impact.constraintId,
          impact.customerId,
          impact.subscriptionId,
          impact.region,
          impact.matchingResourceCount,
          JSON.stringify(impact.skus || []),
        ],
      )
    }
    await upsertAlerts(seedAlerts, client)
    for (const engagement of seedEngagements) {
      await client.query(
        `
        INSERT INTO engagements (
          id, constraint_id, customer_id, initiated_by, status, notes, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          engagement.id,
          engagement.constraintId,
          engagement.customerId,
          engagement.initiatedBy,
          engagement.status,
          engagement.notes || '',
          engagement.createdAt,
        ],
      )
    }
    for (const reward of seedRewards) {
      await client.query(
        `
        INSERT INTO reward_events (
          id, user_id, action, points, label, related_id, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          reward.id,
          reward.userId,
          reward.action,
          reward.points,
          reward.label,
          reward.relatedId || null,
          reward.createdAt,
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
