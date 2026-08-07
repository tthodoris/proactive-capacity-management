import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { azureRegions } from '../data/mockData'
import {
  fetchInventoryResourceTypes,
  fetchInventorySkus,
  type InventorySkuOption,
} from '../lib/dataApi'
import type { ConstraintScope, ConstraintSeverity, ResourceType } from '../types'

const FALLBACK_RESOURCE_TYPES: ResourceType[] = [
  'Virtual Machine',
  'Azure SQL Database',
  'Azure SQL Managed Instance',
  'Azure Database for MySQL',
  'Azure Database for PostgreSQL',
  'Azure Cosmos DB',
  'Azure Kubernetes Service',
  'Container Instances',
  'Azure Container Apps',
  'Azure Container Apps Environment',
  'Azure Databricks',
  'Azure Data Explorer',
  'Azure Cache for Redis',
  'Azure Managed Redis',
  'Key Vault',
  'Storage Account',
  'Application Gateway',
  'API Management',
  'VPN Gateway',
]

export function NewConstraintPage() {
  const { createConstraint } = useApp()
  const navigate = useNavigate()
  const [resourceTypes, setResourceTypes] = useState<string[]>(FALLBACK_RESOURCE_TYPES)
  const [skuOptions, setSkuOptions] = useState<InventorySkuOption[]>([])
  const [sku, setSku] = useState('')
  const [resourceType, setResourceType] = useState<string>('Virtual Machine')
  const [regions, setRegions] = useState<string[]>([])
  const [scope, setScope] = useState<ConstraintScope>('Region')
  const [source, setSource] = useState('Weekly Capacity call')
  const [severity, setSeverity] = useState<ConstraintSeverity>('Critical')
  const [description, setDescription] = useState(
    'Capacity exhausted for this SKU in the selected regions. New deployments may fail until workarounds are confirmed.',
  )
  const [loadingTypes, setLoadingTypes] = useState(true)
  const [loadingSkus, setLoadingSkus] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingTypes(true)
      try {
        const data = await fetchInventoryResourceTypes()
        if (cancelled) return
        const fromDb = data.resourceTypes.map((t) => t.resourceType)
        const types = [
          ...new Set([...FALLBACK_RESOURCE_TYPES, ...fromDb]),
        ].sort((a, b) => a.localeCompare(b))
        if (types.length > 0) {
          setResourceTypes(types)
          setResourceType((prev) => (types.includes(prev) ? prev : types[0]))
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoadingTypes(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!resourceType) return
      setLoadingSkus(true)
      setError(null)
      try {
        const data = await fetchInventorySkus(resourceType)
        if (cancelled) return
        setSkuOptions(data.skus)
        setSku((prev) => {
          if (data.skus.some((s) => s.sku === prev)) return prev
          return data.skus[0]?.sku ?? ''
        })
      } catch (err) {
        if (!cancelled) {
          setSkuOptions([])
          setSku('')
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoadingSkus(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resourceType])

  const selectedSku = useMemo(
    () => skuOptions.find((option) => option.sku === sku) ?? null,
    [skuOptions, sku],
  )

  const regionChoices = useMemo(() => {
    const fromInventory = selectedSku?.regions ?? []
    const merged = [...fromInventory]
    for (const region of azureRegions) {
      if (!merged.includes(region)) merged.push(region)
    }
    return merged
  }, [selectedSku])

  useEffect(() => {
    if (!selectedSku) {
      setRegions([])
      return
    }
    setRegions((prev) => {
      const available = selectedSku.regions
      if (available.length === 0) return prev
      const kept = prev.filter((r) => available.includes(r))
      return kept.length > 0 ? kept : [...available]
    })
  }, [selectedSku])

  function toggleRegion(region: string) {
    setRegions((prev) =>
      prev.includes(region) ? prev.filter((r) => r !== region) : [...prev, region],
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!sku || regions.length === 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      const created = await createConstraint({
        sku,
        resourceType: resourceType as ResourceType,
        regions,
        scope,
        source,
        severity,
        description,
      })
      navigate(`/constraints/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 920 }}>
      <div className="page-hero">
        <div>
          <h3>Create capacity-constraint record</h3>
          <p>
            Choose a resource type, then a SKU family/series (not an exact size). Families come from
            inventory when available, with suggested series for Azure SQL, MySQL, PostgreSQL, and
            Container Apps. On save, PCM runs impact analysis across Postgres inventory and alerts
            owning CSAs.
          </p>
        </div>
      </div>

      <form className="panel" onSubmit={onSubmit}>
        <div className="panel-header">
          <div>
            <h4>Constraint details</h4>
            <p>FR-4.1 / FR-4.2 — SKU from inventory, regions, scope, source, severity</p>
          </div>
        </div>
        <div className="panel-body">
          {error ? <div className="banner banner-error">{error}</div> : null}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="type">Resource type</label>
              <select
                id="type"
                value={resourceType}
                onChange={(e) => setResourceType(e.target.value)}
                disabled={loadingTypes}
                required
              >
                {resourceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="sku">SKU / series (family)</label>
              <select
                id="sku"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                disabled={loadingSkus || skuOptions.length === 0}
                required
              >
                {skuOptions.length === 0 ? (
                  <option value="">
                    {loadingSkus ? 'Loading families…' : 'No families available for this type'}
                  </option>
                ) : (
                  skuOptions.map((option) => (
                    <option key={option.sku} value={option.sku}>
                      {option.sku}
                      {option.resourceCount > 0
                        ? ` (${option.resourceCount} resource${option.resourceCount === 1 ? '' : 's'})`
                        : ' (suggested)'}
                    </option>
                  ))
                )}
              </select>
              {selectedSku ? (
                <p className="field-hint">
                  {selectedSku.resourceCount > 0
                    ? `Present in ${selectedSku.regions.length} region${
                        selectedSku.regions.length === 1 ? '' : 's'
                      } in inventory`
                    : 'Suggested family — collect inventory to refine regions and counts'}
                  {selectedSku.sizes.length > 0
                    ? ` · example sizes: ${selectedSku.sizes.slice(0, 6).join(', ')}`
                    : ''}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="scope">Scope</label>
              <select
                id="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as ConstraintScope)}
              >
                <option>Region</option>
                <option>Subscription</option>
                <option>Customer</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="severity">Severity</label>
              <select
                id="severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as ConstraintSeverity)}
              >
                <option>Critical</option>
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </div>

            <div className="field full">
              <label htmlFor="source">Source</label>
              <input
                id="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Weekly Capacity call, email, Teams, escalation…"
                required
              />
            </div>

            <div className="field full">
              <label>Affected regions</label>
              <div className="chips">
                {regionChoices.map((region) => {
                  const inInventory = selectedSku?.regions.includes(region)
                  return (
                    <button
                      key={region}
                      type="button"
                      className={`chip${regions.includes(region) ? ' active' : ''}`}
                      onClick={() => toggleRegion(region)}
                      title={inInventory ? 'Found in inventory for this SKU' : undefined}
                    >
                      {region}
                      {inInventory ? ' · inventory' : ''}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="field full">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.1rem' }}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={saving || !sku || regions.length === 0}
            >
              {saving ? 'Running impact analysis…' : 'Save & run impact analysis'}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => navigate(-1)}>
              Cancel
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
