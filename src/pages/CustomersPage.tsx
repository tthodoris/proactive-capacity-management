import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Download, Search, X } from 'lucide-react'
import { exportSheetsToExcel, exportToExcel } from '../lib/exportExcel'
import { filterActiveImpacts } from '../lib/constraints'
import {
  computePortfolioCapacityRisks,
  loadCapacityRiskWeights,
  riskLevelPillClass,
  type CapacityRiskLevel,
} from '../lib/capacityRisk'
import { CheckboxMultiSelect } from '../components/CheckboxMultiSelect'
import { useApp } from '../context/AppContext'
import { formatDate, formatRelative, usageTone } from '../lib/format'
import {
  groupQuotasByProvider,
  isQuotaFamilyName,
  resolveQuotaProvider,
} from '../lib/quotaProviders'
import {
  FilterableTh,
  collectCascadingOptions,
  useColumnFilters,
  useSortState,
  useSortedRows,
} from '../lib/tableSort'

type CustomerSortKey =
  | 'name'
  | 'segment'
  | 'owner'
  | 'inventory'
  | 'risk'
  | 'exposure'
  | 'synced'

const RISK_LEVEL_ORDER: Record<CapacityRiskLevel, number> = { Red: 0, Amber: 1, Green: 2 }

export function CustomersPage() {
  const {
    customers,
    users,
    inventory,
    quotas,
    impactResults,
    constraints,
    portfolioCustomerIds,
    canSeeAllPortfolios,
  } = useApp()
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const { sortKey, sortDir, toggleSort } = useSortState<CustomerSortKey>('name')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<CustomerSortKey>()

  const activeImpacts = useMemo(
    () => filterActiveImpacts(impactResults, constraints),
    [impactResults, constraints],
  )

  const riskByCustomer = useMemo(() => {
    const visible = customers.filter(
      (c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id),
    )
    const list = computePortfolioCapacityRisks({
      customers: visible,
      inventory,
      quotas,
      impacts: impactResults,
      constraints,
      weights: loadCapacityRiskWeights(),
    })
    return new Map(list.map((r) => [r.customerId, r]))
  }, [customers, canSeeAllPortfolios, portfolioCustomerIds, inventory, quotas, impactResults, constraints])

  const baseRows = useMemo(() => {
    return customers
      .filter((c) => canSeeAllPortfolios || portfolioCustomerIds.includes(c.id))
      .filter(
        (c) =>
          !query ||
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.industry.toLowerCase().includes(query.toLowerCase()) ||
          c.segment.toLowerCase().includes(query.toLowerCase()),
      )
  }, [customers, canSeeAllPortfolios, portfolioCustomerIds, query])

  const getValue = useCallback(
    (c: (typeof baseRows)[number], key: string) => {
      const owner = users.find((u) => u.id === c.csaOwnerId)
      switch (key) {
        case 'owner':
          return owner?.name || ''
        case 'inventory': {
          const count = inventory.filter((i) => i.customerId === c.id).length
          return `${count} resources`
        }
        case 'risk':
          return riskByCustomer.get(c.id)?.level || 'Green'
        case 'exposure': {
          const count = new Set(
            activeImpacts.filter((i) => i.customerId === c.id).map((i) => i.constraintId),
          ).size
          return count === 0 ? 'None' : `${count} constraint(s)`
        }
        case 'synced':
          return c.syncSource || ''
        case 'name':
          return c.name
        default:
          return c[key as keyof typeof c]
      }
    },
    [users, inventory, activeImpacts, riskByCustomer],
  )

  const filtered = useMemo(() => {
    return baseRows.filter((c) =>
      matchesColumnFilters((column) => String(getValue(c, column) ?? '')),
    )
  }, [baseRows, matchesColumnFilters, getValue])

  const rows = useSortedRows(filtered, sortKey, sortDir, (row, key) => {
    if (key === 'risk') {
      const level = (riskByCustomer.get(row.id)?.level || 'Green') as CapacityRiskLevel
      return RISK_LEVEL_ORDER[level]
    }
    return getValue(row, key)
  })

  const columnKeys: CustomerSortKey[] = [
    'name',
    'segment',
    'owner',
    'inventory',
    'risk',
    'exposure',
    'synced',
  ]

  const columnOptions = useMemo(
    () => collectCascadingOptions(baseRows, columnKeys, filters, getValue),
    [baseRows, filters, getValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(columnOptions)
  }, [columnOptions, pruneFiltersToOptions])

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>Managed customers</h3>
          <p>Imported from the internal Microsoft system with CSA ownership mapping.</p>
        </div>
      </div>

      <div className="filters">
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customer, industry, or segment"
          />
        </div>
        {activeFilterCount > 0 ? (
          <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
            <X size={16} /> Clear column filters ({activeFilterCount})
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            const columns = [
              { key: 'name', label: 'Customer' },
              { key: 'segment', label: 'Segment' },
              { key: 'owner', label: 'CSA owner' },
              { key: 'inventory', label: 'Inventory' },
              { key: 'risk', label: 'Capacity risk' },
              { key: 'exposure', label: 'Active exposure' },
              { key: 'synced', label: 'Last sync' },
            ]
            exportToExcel('customers', 'Customers', columns, rows.map((c) => {
              const obj: Record<string, unknown> = {}
              for (const col of columns) obj[col.key] = getValue(c, col.key)
              return obj
            }))
          }}
        >
          <Download size={16} /> Export to Excel
        </button>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {(
                  [
                    ['name', 'Customer'],
                    ['segment', 'Segment'],
                    ['owner', 'CSA owner'],
                    ['inventory', 'Inventory'],
                    ['risk', 'Capacity risk'],
                    ['exposure', 'Active exposure'],
                    ['synced', 'Last sync'],
                  ] as Array<[CustomerSortKey, string]>
                ).map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as CustomerSortKey)}
                    options={columnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const owner = users.find((u) => u.id === c.csaOwnerId)
                const resourceCount = inventory.filter((i) => i.customerId === c.id).length
                const risk = riskByCustomer.get(c.id)
                const riskLevel = (risk?.level || 'Green') as CapacityRiskLevel
                const exposure = new Set(
                  activeImpacts
                    .filter((i) => i.customerId === c.id)
                    .map((i) => i.constraintId),
                ).size
                return (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/customers/${c.id}`)}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted">{c.industry}</div>
                    </td>
                    <td>
                      <span className="pill pill-neutral">{c.segment}</span>
                    </td>
                    <td>{owner?.name}</td>
                    <td>{resourceCount} resources</td>
                    <td title={risk?.summary || undefined}>
                      <span className={riskLevelPillClass(riskLevel)}>{riskLevel}</span>
                    </td>
                    <td>
                      {exposure > 0 ? (
                        <span className="pill pill-high">{exposure} constraint(s)</span>
                      ) : (
                        <span className="pill pill-ok">None</span>
                      )}
                    </td>
                    <td className="muted">
                      {formatRelative(c.lastSyncedAt)}
                      <div>{c.syncSource}</div>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">No customers match the current filters.</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

type CustomerInventorySortKey =
  | 'name'
  | 'subscription'
  | 'type'
  | 'sku'
  | 'region'
  | 'resourceGroup'
  | 'source'

const CUSTOMER_INVENTORY_COLUMNS: Array<[CustomerInventorySortKey, string]> = [
  ['name', 'Name'],
  ['subscription', 'Subscription'],
  ['type', 'Type'],
  ['sku', 'SKU'],
  ['region', 'Region'],
  ['resourceGroup', 'Resource group'],
  ['source', 'Source'],
]

export function CustomerDetailPage() {
  const { id } = useParams()
  const {
    customers,
    users,
    subscriptions,
    inventory,
    quotas,
    quotaGroupLimits,
    impactResults,
    constraints,
  } = useApp()
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState<string | null>(null)
  const [selectedFamilies, setSelectedFamilies] = useState<string[]>([])
  const [hideUnused, setHideUnused] = useState(true)
  const [quotaSnapshotExpanded, setQuotaSnapshotExpanded] = useState(true)
  const { sortKey, sortDir, toggleSort } = useSortState<CustomerInventorySortKey>('name')
  const {
    filters,
    setColumnFilter,
    clearAllFilters,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  } = useColumnFilters<CustomerInventorySortKey>()

  const customer = customers.find((c) => c.id === id)
  const owner = customer ? users.find((u) => u.id === customer.csaOwnerId) : undefined
  const subs = useMemo(
    () => (customer ? subscriptions.filter((s) => s.customerId === customer.id) : []),
    [subscriptions, customer],
  )

  const items = useMemo(() => {
    if (!customer) return []
    return inventory.filter((i) => {
      if (i.customerId !== customer.id) return false
      if (selectedSubscriptionId && i.subscriptionId !== selectedSubscriptionId) return false
      return true
    })
  }, [inventory, customer, selectedSubscriptionId])

  const getInventoryValue = useCallback(
    (item: (typeof items)[number], key: string) => {
      switch (key) {
        case 'type':
          return item.resourceType
        case 'subscription':
          return subs.find((s) => s.id === item.subscriptionId)?.name || ''
        default:
          return item[key as keyof typeof item]
      }
    },
    [subs],
  )

  const filteredItems = useMemo(() => {
    return items.filter((item) =>
      matchesColumnFilters((column) => String(getInventoryValue(item, column) ?? '')),
    )
  }, [items, matchesColumnFilters, getInventoryValue])

  const inventoryRows = useSortedRows(filteredItems, sortKey, sortDir, getInventoryValue)

  const inventoryColumnKeys = CUSTOMER_INVENTORY_COLUMNS.map(([key]) => key)

  const inventoryColumnOptions = useMemo(
    () => collectCascadingOptions(items, inventoryColumnKeys, filters, getInventoryValue),
    [items, filters, getInventoryValue],
  )

  useEffect(() => {
    pruneFiltersToOptions(inventoryColumnOptions)
  }, [inventoryColumnOptions, pruneFiltersToOptions])

  useEffect(() => {
    clearAllFilters()
  }, [selectedSubscriptionId, clearAllFilters])

  const subscriptionQuotas = useMemo(() => {
    if (!customer || !selectedSubscriptionId) return []
    const sub = subs.find((s) => s.id === selectedSubscriptionId)
    const rows = quotas.filter((q) => {
      if (q.customerId && q.customerId !== customer.id) return false
      return (
        q.subscriptionId === selectedSubscriptionId ||
        (sub != null && q.azureSubscriptionId === sub.subscriptionId)
      )
    })
    return [...rows].sort((a, b) => b.usage - a.usage)
  }, [quotas, customer, selectedSubscriptionId, subs])

  const visibleSubscriptionQuotas = useMemo(() => {
    if (!hideUnused) return subscriptionQuotas
    return subscriptionQuotas.filter((q) => q.usage > 0)
  }, [subscriptionQuotas, hideUnused])

  const familyOptions = useMemo(() => {
    const familyNames = [
      ...new Set(
        visibleSubscriptionQuotas.filter((q) => isQuotaFamilyName(q.name)).map((q) => q.name),
      ),
    ].sort((a, b) => a.localeCompare(b))

    if (familyNames.length > 0) {
      return [
        ...familyNames.map((name) => ({ value: name, label: name })),
        { value: '__other__', label: 'Other quotas (non-family)' },
      ]
    }

    return [...new Set(visibleSubscriptionQuotas.map((q) => q.name))]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }))
  }, [visibleSubscriptionQuotas])

  const familyOptionValues = useMemo(
    () => familyOptions.map((o) => o.value),
    [familyOptions],
  )

  useEffect(() => {
    setSelectedFamilies(familyOptionValues)
  }, [selectedSubscriptionId, familyOptionValues])

  const filteredQuotas = useMemo(() => {
    if (selectedFamilies.length === 0) return []
    const selected = new Set(selectedFamilies)
    const hasFamilyMode = familyOptions.some((o) => o.value === '__other__')
    return visibleSubscriptionQuotas.filter((q) => {
      if (selected.has(q.name)) return true
      if (hasFamilyMode && selected.has('__other__') && !isQuotaFamilyName(q.name)) return true
      return false
    })
  }, [visibleSubscriptionQuotas, selectedFamilies, familyOptions])

  const groupedQuotas = useMemo(() => groupQuotasByProvider(filteredQuotas), [filteredQuotas])

  const activeCustomerExposures = useMemo(() => {
    if (!customer) return []
    return filterActiveImpacts(
      impactResults.filter((i) => i.customerId === customer.id),
      constraints,
    )
  }, [impactResults, customer, constraints])

  const subscriptionExposures = useMemo(() => {
    if (!selectedSubscriptionId) return []
    return activeCustomerExposures.filter((i) => i.subscriptionId === selectedSubscriptionId)
  }, [activeCustomerExposures, selectedSubscriptionId])

  const customerExposures = activeCustomerExposures

  const customerExposureCount = useMemo(
    () => new Set(customerExposures.map((e) => e.constraintId)).size,
    [customerExposures],
  )

  const affectedSubscriptions = useMemo(() => {
    const bySubscription = new Map<string, typeof customerExposures>()
    for (const exp of customerExposures) {
      const existing = bySubscription.get(exp.subscriptionId) || []
      existing.push(exp)
      bySubscription.set(exp.subscriptionId, existing)
    }

    return [...bySubscription.entries()]
      .map(([subscriptionId, exposures]) => {
        const sub = subs.find((s) => s.id === subscriptionId)
        return {
          subscriptionId,
          name: sub?.name || subscriptionId,
          constraintLabels: [
            ...new Set(
              exposures.map(
                (e) => constraints.find((c) => c.id === e.constraintId)?.sku || e.constraintId,
              ),
            ),
          ],
          regions: [...new Set(exposures.map((e) => e.region))],
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [customerExposures, subs, constraints])

  const exportSubscriptions = useMemo(() => {
    if (selectedSubscriptionId) {
      return subs.filter((s) => s.id === selectedSubscriptionId)
    }
    return subs
  }, [subs, selectedSubscriptionId])

  const exportExposures = useMemo(() => {
    if (selectedSubscriptionId) return subscriptionExposures
    return customerExposures
  }, [selectedSubscriptionId, subscriptionExposures, customerExposures])

  const exportQuotas = useMemo(() => {
    if (!customer) return []
    const pcmIds = new Set(exportSubscriptions.map((s) => s.id))
    const azureIds = new Set(
      exportSubscriptions.map((s) => s.subscriptionId.toLowerCase()),
    )
    return quotas
      .filter((q) => {
        if (q.customerId && q.customerId !== customer.id) return false
        if (q.subscriptionId && pcmIds.has(q.subscriptionId)) return true
        if (q.azureSubscriptionId && azureIds.has(q.azureSubscriptionId.toLowerCase())) {
          return true
        }
        return false
      })
      .sort((a, b) => b.usage - a.usage)
  }, [quotas, customer, exportSubscriptions])

  const exportQuotaGroups = useMemo(() => {
    if (!customer) return []
    const azureIds = new Set(
      exportSubscriptions.map((s) => s.subscriptionId.toLowerCase()),
    )
    return quotaGroupLimits.filter((row) => {
      const matchesCustomer =
        row.customerId === customer.id ||
        (row.tenantId != null && row.tenantId === customer.tenantId)
      if (!matchesCustomer) return false
      if (!selectedSubscriptionId) return true
      if (!row.subscriptionIds?.length) return true
      return row.subscriptionIds.some((id) => azureIds.has(String(id).toLowerCase()))
    })
  }, [quotaGroupLimits, customer, exportSubscriptions, selectedSubscriptionId])

  function onExportCustomerExcel() {
    if (!customer) return
    const selectedSubLabel =
      exportSubscriptions.length === 1 ? exportSubscriptions[0].name : null
    const subNameById = new Map(subs.map((s) => [s.id, s.name]))
    const subNameByAzureId = new Map(
      subs.map((s) => [s.subscriptionId.toLowerCase(), s.name]),
    )

    const safeName = customer.name.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 40)
    const scopeSuffix = selectedSubLabel
      ? `_${selectedSubLabel.replace(/[^\w\-]+/g, '_').slice(0, 30)}`
      : '_all-subscriptions'
    const filename = `customer_${safeName}${scopeSuffix}`

    exportSheetsToExcel(filename, [
      {
        name: 'Subscriptions',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'subscriptionId', label: 'Subscription ID' },
          { key: 'regions', label: 'Regions' },
        ],
        rows: exportSubscriptions.map((s) => ({
          name: s.name,
          subscriptionId: s.subscriptionId,
          regions: s.regions.join(', '),
        })),
      },
      {
        name: 'Capacity exposure',
        columns: [
          { key: 'subscription', label: 'Subscription' },
          { key: 'sku', label: 'SKU / constraint' },
          { key: 'resourceType', label: 'Resource type' },
          { key: 'region', label: 'Region' },
          { key: 'matchingResources', label: 'Matching resources' },
          { key: 'severity', label: 'Severity' },
          { key: 'status', label: 'Status' },
          { key: 'scope', label: 'Scope' },
        ],
        rows: exportExposures.map((exp) => {
          const constraint = constraints.find((c) => c.id === exp.constraintId)
          return {
            subscription: subNameById.get(exp.subscriptionId) || exp.subscriptionId,
            sku: constraint?.sku || exp.constraintId,
            resourceType: constraint?.resourceType || '',
            region: exp.region,
            matchingResources: exp.matchingResourceCount,
            severity: constraint?.severity || '',
            status: constraint?.status || '',
            scope: constraint?.scope || '',
          }
        }),
      },
      {
        name: 'Quotas',
        columns: [
          { key: 'subscription', label: 'Subscription' },
          { key: 'name', label: 'Quota' },
          { key: 'provider', label: 'Provider' },
          { key: 'region', label: 'Region' },
          { key: 'usage', label: 'Usage' },
          { key: 'limit', label: 'Limit' },
          { key: 'unit', label: 'Unit' },
          { key: 'source', label: 'Source' },
          { key: 'retrieved', label: 'Retrieved' },
        ],
        rows: exportQuotas.map((q) => ({
          subscription:
            (q.subscriptionId && subNameById.get(q.subscriptionId)) ||
            q.subscriptionName ||
            (q.azureSubscriptionId &&
              subNameByAzureId.get(q.azureSubscriptionId.toLowerCase())) ||
            q.azureSubscriptionId ||
            '',
          name: q.name,
          provider: resolveQuotaProvider(q),
          region: q.region,
          usage: q.usage,
          limit: q.limit,
          unit: q.unit,
          source: q.source || '',
          retrieved: q.collectedAt ? formatDate(q.collectedAt) : '',
        })),
      },
      {
        name: 'Quota groups',
        columns: [
          { key: 'name', label: 'Quota' },
          { key: 'group', label: 'Quota group' },
          { key: 'managementGroup', label: 'Management group' },
          { key: 'region', label: 'Region' },
          { key: 'allocated', label: 'Allocated' },
          { key: 'limit', label: 'Limit' },
          { key: 'available', label: 'Available' },
          { key: 'unit', label: 'Unit' },
          { key: 'subscriptions', label: 'Subscriptions' },
          { key: 'source', label: 'Source' },
          { key: 'retrieved', label: 'Retrieved' },
        ],
        rows: exportQuotaGroups.map((row) => ({
          name: row.name,
          group: row.groupDisplayName || row.groupQuotaName,
          managementGroup: row.managementGroupId,
          region: row.region,
          allocated: row.allocated,
          limit: row.limit,
          available: row.availableLimit,
          unit: row.unit,
          subscriptions: (row.subscriptionIds || [])
            .map((id) => subNameByAzureId.get(String(id).toLowerCase()) || id)
            .join(', '),
          source: row.source || '',
          retrieved: row.collectedAt ? formatDate(row.collectedAt) : '',
        })),
      },
      {
        name: 'Inventory',
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'subscription', label: 'Subscription' },
          { key: 'type', label: 'Type' },
          { key: 'sku', label: 'SKU' },
          { key: 'region', label: 'Region' },
          { key: 'resourceGroup', label: 'Resource group' },
          { key: 'source', label: 'Source' },
          { key: 'retrieved', label: 'Retrieved' },
        ],
        rows: items.map((item) => ({
          name: item.name,
          subscription: subNameById.get(item.subscriptionId) || item.subscriptionId,
          type: item.resourceType,
          sku: item.sku,
          region: item.region,
          resourceGroup: item.resourceGroup,
          source: item.source,
          retrieved: item.collectedAt ? formatDate(item.collectedAt) : '',
        })),
      },
    ])
  }

  if (!customer) {
    return <div className="empty">Customer not found.</div>
  }

  const selectedSubName = subs.find((s) => s.id === selectedSubscriptionId)?.name

  return (
    <div className="stack">
      <div className="page-hero">
        <div>
          <h3>{customer.name}</h3>
          <p>
            Tenant {customer.tenantId} · CSA {owner?.name} · {customer.segment} ·{' '}
            {customer.industry}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
          <span className="pill pill-neutral">
            Last sync {formatRelative(customer.lastSyncedAt)}
          </span>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={onExportCustomerExcel}
            title={
              selectedSubscriptionId
                ? `Export data for ${selectedSubName || 'selected subscription'}`
                : 'Export data for all subscriptions'
            }
          >
            <Download size={16} /> Export to Excel
          </button>
        </div>
      </div>

      <div className="grid-3">
        <div className="metric-card">
          <div className="label">Subscriptions</div>
          <div className="value">{subs.length}</div>
        </div>
        <div className="metric-card">
          <div className="label">Inventory items</div>
          <div className="value">{items.length}</div>
          <div className="hint">
            {selectedSubscriptionId ? 'Selected subscription' : 'All subscriptions'}
          </div>
        </div>
        <div className="metric-card">
          <div className="label">Active exposures</div>
          <div className="value">{customerExposureCount}</div>
          <div className="hint">All subscriptions</div>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h4>Subscriptions</h4>
              <p>Click a subscription to view its quota snapshot and capacity exposure</p>
            </div>
            {selectedSubscriptionId ? (
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setSelectedSubscriptionId(null)}
              >
                Show all
              </button>
            ) : null}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Subscription ID</th>
                  <th>Regions</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr
                    key={s.id}
                    className={`clickable${selectedSubscriptionId === s.id ? ' selected' : ''}`}
                    onClick={() => setSelectedSubscriptionId(s.id)}
                  >
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td className="muted">{s.subscriptionId}</td>
                    <td>{s.regions.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h4>Active capacity exposure</h4>
                <p>
                  {selectedSubscriptionId
                    ? `Constraints matching inventory in ${selectedSubName || 'subscription'}`
                    : 'Subscriptions affected by active constraints'}
                </p>
              </div>
            </div>
            <div className="panel-body stack">
              {!selectedSubscriptionId ? (
                customerExposures.length === 0 ? (
                  <div className="empty">No active capacity exposure for this customer.</div>
                ) : (
                  <>
                    {affectedSubscriptions.map((sub) => (
                      <div
                        key={sub.subscriptionId}
                        className="list-row list-row-compact"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedSubscriptionId(sub.subscriptionId)}
                      >
                        <div className="exposure-line">
                          <strong>{sub.name}</strong>
                          <span className="muted">
                            · {sub.constraintLabels.join(', ')} · {sub.regions.join(', ')}
                          </span>
                        </div>
                      </div>
                    ))}
                    <p className="field-hint">
                      Select a subscription to view constraint details.
                    </p>
                  </>
                )
              ) : subscriptionExposures.length === 0 ? (
                <div className="empty">No active capacity exposure for this subscription.</div>
              ) : (
                subscriptionExposures.map((exp) => {
                  const constraint = constraints.find((c) => c.id === exp.constraintId)
                  return (
                    <Link
                      key={exp.id}
                      className="list-row list-row-compact"
                      to={`/constraints/${exp.constraintId}`}
                    >
                      <div className="exposure-line">
                        <strong>{selectedSubName}</strong>
                        <span className="muted">
                          · {constraint?.sku} · {exp.region} · {exp.matchingResourceCount} resources
                          · {constraint?.status}
                        </span>
                      </div>
                    </Link>
                  )
                })
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <button
                type="button"
                className="collapsible-trigger panel-header-trigger"
                aria-expanded={quotaSnapshotExpanded}
                onClick={() => setQuotaSnapshotExpanded((v) => !v)}
              >
                <span className="collapsible-trigger-main">
                  {quotaSnapshotExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <div>
                    <h4>Quota snapshot</h4>
                    <p>
                      {selectedSubscriptionId
                        ? `Grouped by Azure provider · ${selectedSubName || 'subscription'}${
                            subscriptionQuotas.length
                              ? ` · ${subscriptionQuotas.length} quota(s)`
                              : ''
                          }`
                        : 'Select a subscription to filter · ordered by usage'}
                    </p>
                  </div>
                </span>
                <span className="pill pill-neutral">
                  {quotaSnapshotExpanded ? 'Hide' : 'Show'}
                </span>
              </button>
            </div>
            {quotaSnapshotExpanded ? (
            <div className="panel-body stack">
            {!selectedSubscriptionId ? (
              <div className="empty">Select a subscription on the left to view its quotas.</div>
            ) : subscriptionQuotas.length === 0 ? (
              <div className="empty">
                No quotas stored for this subscription yet. Collect quotas from Azure Connect.
              </div>
            ) : (
              <>
                <div
                  className="filters"
                  style={{ alignItems: 'center', marginBottom: 0 }}
                >
                  <label className="switch-field" title="Toggle quotas with zero usage">
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={hideUnused}
                        onChange={(e) => setHideUnused(e.target.checked)}
                      />
                      <span className="switch-track" aria-hidden />
                    </span>
                    <span className="switch-label">Hide unused quotas</span>
                  </label>
                </div>
                <CheckboxMultiSelect
                  id="quota-families"
                  label="Quota families"
                  options={familyOptions}
                  value={selectedFamilies}
                  onChange={setSelectedFamilies}
                  placeholder="Select families"
                  selectAllLabel="Select all families"
                  emptyLabel="No families available"
                />
                {visibleSubscriptionQuotas.length === 0 ? (
                  <div className="empty">
                    All quotas for this subscription have zero usage. Turn off Hide unused quotas to
                    show them.
                  </div>
                ) : groupedQuotas.length === 0 ? (
                  <div className="empty">No quotas match the selected families.</div>
                ) : (
                  groupedQuotas.map(({ provider, items: providerItems }) => (
                    <div key={provider} className="quota-provider-block">
                      <div className="quota-provider-title">
                        <h5>{provider}</h5>
                        <span className="muted">{providerItems.length}</span>
                      </div>
                      <div className="quota-provider-items">
                        {providerItems.map((q) => {
                          const pct = q.limit ? Math.round((q.usage / q.limit) * 100) : 0
                          const tone = usageTone(q.usage, Math.max(q.limit, 1))
                          return (
                            <div key={q.id}>
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  gap: '1rem',
                                }}
                              >
                                <strong>{q.name}</strong>
                                <span className="muted">
                                  {q.usage}/{q.limit} {q.unit}
                                </span>
                              </div>
                              <div className="muted" style={{ margin: '0.2rem 0 0.45rem' }}>
                                {q.region} · {pct}% · {resolveQuotaProvider(q)}
                              </div>
                              <div className={`progress ${tone}`}>
                                <span style={{ width: `${Math.min(pct, 100)}%` }} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
            ) : null}
        </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h4>Compute inventory</h4>
            <p>
              {selectedSubscriptionId
                ? `Filtered to ${selectedSubName || 'selected subscription'} · ${inventoryRows.length} of ${items.length} resources`
                : `${inventoryRows.length} of ${items.length} resources · click a column to filter or sort`}
            </p>
          </div>
          {activeFilterCount > 0 ? (
            <button className="btn btn-ghost" type="button" onClick={clearAllFilters}>
              <X size={16} /> Clear filters ({activeFilterCount})
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {CUSTOMER_INVENTORY_COLUMNS.map(([column, label]) => (
                  <FilterableTh
                    key={column}
                    label={label}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={(c) => toggleSort(c as CustomerInventorySortKey)}
                    options={inventoryColumnOptions[column]}
                    selected={filters[column]}
                    onFilterChange={(values) => setColumnFilter(column, values)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {inventoryRows.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{subs.find((s) => s.id === item.subscriptionId)?.name || '—'}</td>
                  <td>{item.resourceType}</td>
                  <td>{item.sku}</td>
                  <td>{item.region}</td>
                  <td className="muted">{item.resourceGroup}</td>
                  <td>
                    <span className="pill pill-neutral">{item.source}</span>
                  </td>
                </tr>
              ))}
              {inventoryRows.length === 0 ? (
                <tr>
                  <td colSpan={CUSTOMER_INVENTORY_COLUMNS.length}>
                    <div className="empty">
                      {items.length === 0
                        ? 'No inventory for this selection.'
                        : 'No inventory matches the current filters.'}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
