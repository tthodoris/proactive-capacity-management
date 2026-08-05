import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Filter, ListFilter } from 'lucide-react'

export type SortDirection = 'asc' | 'desc'

export function useSortState<T extends string>(initialKey: T, initialDir: SortDirection = 'asc') {
  const [sortKey, setSortKey] = useState<T>(initialKey)
  const [sortDir, setSortDir] = useState<SortDirection>(initialDir)

  function toggleSort(key: T) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return { sortKey, sortDir, toggleSort }
}

export function compareValues(a: unknown, b: unknown, dir: SortDirection) {
  const av = a == null ? '' : a
  const bv = b == null ? '' : b
  let result = 0
  if (typeof av === 'number' && typeof bv === 'number') {
    result = av - bv
  } else {
    result = String(av).localeCompare(String(bv), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }
  return dir === 'asc' ? result : -result
}

export function sortBy<T>(
  rows: T[],
  sortKey: string,
  sortDir: SortDirection,
  getValue: (row: T, key: string) => unknown,
) {
  return [...rows].sort((a, b) => compareValues(getValue(a, sortKey), getValue(b, sortKey), sortDir))
}

export function useSortedRows<T>(
  rows: T[],
  sortKey: string,
  sortDir: SortDirection,
  getValue: (row: T, key: string) => unknown,
) {
  return useMemo(
    () => sortBy(rows, sortKey, sortDir, getValue),
    [rows, sortKey, sortDir, getValue],
  )
}

/** Column filters: missing key = no filter; [] = deselect all (match nothing). */
export function useColumnFilters<T extends string>() {
  const [filters, setFilters] = useState<Partial<Record<T, string[]>>>({})

  const setColumnFilter = useCallback((column: T, values: string[] | null) => {
    setFilters((prev) => {
      const next = { ...prev }
      if (values === null) {
        delete next[column]
      } else {
        next[column] = values
      }
      return next
    })
  }, [])

  const clearColumnFilter = useCallback((column: T) => {
    setFilters((prev) => {
      const next = { ...prev }
      delete next[column]
      return next
    })
  }, [])

  const clearAllFilters = useCallback(() => {
    setFilters({})
  }, [])

  const isColumnFiltered = useCallback(
    (column: T) => Object.prototype.hasOwnProperty.call(filters, column),
    [filters],
  )

  const matchesColumnFilters = useCallback(
    (getValue: (column: T) => string) => {
      for (const [column, selected] of Object.entries(filters) as Array<[T, string[] | undefined]>) {
        if (selected === undefined) continue
        if (selected.length === 0) return false
        const value = normalizeFilterValue(getValue(column))
        if (!selected.includes(value)) return false
      }
      return true
    },
    [filters],
  )

  /** Drop selected values that are no longer available after cascading option changes. */
  const pruneFiltersToOptions = useCallback((optionsByColumn: Partial<Record<T, string[]>>) => {
    setFilters((prev) => {
      let changed = false
      const next: Partial<Record<T, string[]>> = { ...prev }
      for (const [column, selected] of Object.entries(prev) as Array<[T, string[] | undefined]>) {
        if (selected === undefined) continue
        const options = optionsByColumn[column]
        if (!options) continue
        if (selected.length === 0) continue
        const pruned = selected.filter((value) => options.includes(value))
        if (pruned.length !== selected.length) {
          changed = true
          if (pruned.length === options.length) delete next[column]
          else next[column] = pruned
        } else if (pruned.length === options.length && options.length > 0) {
          changed = true
          delete next[column]
        }
      }
      return changed ? next : prev
    })
  }, [])

  const activeFilterCount = Object.keys(filters).length

  return {
    filters,
    setColumnFilter,
    clearColumnFilter,
    clearAllFilters,
    isColumnFiltered,
    matchesColumnFilters,
    pruneFiltersToOptions,
    activeFilterCount,
  }
}

export function normalizeFilterValue(raw: unknown): string {
  return raw == null || raw === '' ? '(blank)' : String(raw)
}

export function collectDistinctValues<T>(
  rows: T[],
  getValue: (row: T) => unknown,
  limit = 250,
): string[] {
  const set = new Set<string>()
  for (const row of rows) {
    set.add(normalizeFilterValue(getValue(row)))
    if (set.size >= limit) break
  }
  return [...set].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/**
 * Options for each column, limited by every *other* active column filter
 * (Excel-style cascading filters).
 *
 * Empty selections (`[]` = deselect all) are ignored when building options so
 * menus stay populated and the user can pick values again. Row matching still
 * treats `[]` as match-nothing.
 */
export function collectCascadingOptions<T, K extends string>(
  rows: T[],
  columns: K[],
  filters: Partial<Record<K, string[]>>,
  getValue: (row: T, key: K) => unknown,
): Record<K, string[]> {
  const result = {} as Record<K, string[]>
  for (const column of columns) {
    const scoped = rows.filter((row) => {
      for (const [other, selected] of Object.entries(filters) as Array<
        [K, string[] | undefined]
      >) {
        if (other === column || selected === undefined || selected.length === 0) continue
        if (!selected.includes(normalizeFilterValue(getValue(row, other)))) return false
      }
      return true
    })
    result[column] = collectDistinctValues(scoped, (row) => getValue(row, column))
  }
  return result
}

export function SortableTh({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  column: string
  sortKey: string
  sortDir: SortDirection
  onSort: (column: string) => void
}) {
  const active = sortKey === column
  return (
    <th>
      <button
        type="button"
        className={`sort-th${active ? ' active' : ''}`}
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp size={14} />
          ) : (
            <ArrowDown size={14} />
          )
        ) : (
          <ArrowUpDown size={14} />
        )}
      </button>
    </th>
  )
}

interface MenuPosition {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

export function FilterableTh({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  options,
  selected,
  onFilterChange,
}: {
  label: string
  column: string
  sortKey: string
  sortDir: SortDirection
  onSort: (column: string) => void
  options: string[]
  /**
   * undefined = no filter (all values).
   * [] = deselect all (show none).
   * string[] = only these values.
   */
  selected: string[] | undefined
  onFilterChange: (values: string[] | null) => void
}) {
  const reactId = useId()
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLTableCellElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const sortActive = sortKey === column
  const filterActive = selected !== undefined
  const unfiltered = selected === undefined
  const selectedSet = useMemo(() => new Set(selected ?? []), [selected])
  const effectiveSelected = unfiltered
    ? options
    : (selected ?? []).filter((v) => options.includes(v))

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [options, query])

  const allVisibleSelected =
    visibleOptions.length > 0 && visibleOptions.every((o) => effectiveSelected.includes(o))
  const noneVisibleSelected =
    visibleOptions.length === 0 ||
    visibleOptions.every((o) => !effectiveSelected.includes(o))

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setMenuPos(null)
      return
    }

    function updatePosition() {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const gap = 6
      const preferredMax = 340
      const menuWidth = Math.max(240, Math.min(340, rect.width + 100))
      const spaceBelow = window.innerHeight - rect.bottom - gap - 12
      const spaceAbove = rect.top - gap - 12
      const openUp = spaceBelow < 200 && spaceAbove > spaceBelow
      const available = Math.max(160, openUp ? spaceAbove : spaceBelow)
      const left = Math.min(rect.left, window.innerWidth - menuWidth - 12)

      if (openUp) {
        setMenuPos({
          bottom: window.innerHeight - rect.top + gap,
          left: Math.max(12, left),
          width: menuWidth,
          maxHeight: Math.min(preferredMax, available),
        })
      } else {
        setMenuPos({
          top: rect.bottom + gap,
          left: Math.max(12, left),
          width: menuWidth,
          maxHeight: Math.min(preferredMax, available),
        })
      }
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
      setQuery('')
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function commitSelection(next: string[]) {
    if (next.length === options.length) onFilterChange(null)
    else onFilterChange(next)
  }

  function toggleValue(value: string) {
    const current = unfiltered ? [...options] : [...effectiveSelected]
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]
    commitSelection(next)
  }

  function selectAllVisible() {
    const merged = new Set([...effectiveSelected, ...visibleOptions])
    commitSelection([...merged])
  }

  function deselectAllVisible() {
    if (!query.trim()) {
      onFilterChange([])
      return
    }
    const next = effectiveSelected.filter((v) => !visibleOptions.includes(v))
    commitSelection(next)
  }

  return (
    <th ref={rootRef} className="filterable-th">
      <div className="filter-sort-th">
        <button
          ref={triggerRef}
          type="button"
          className={`sort-th filter-th-trigger${filterActive ? ' filtered' : ''}${sortActive ? ' active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={`${reactId}-menu`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span>{label}</span>
          {filterActive ? <Filter size={13} /> : <ListFilter size={13} />}
        </button>
        <button
          type="button"
          className={`sort-icon-btn${sortActive ? ' active' : ''}`}
          title={`Sort by ${label}`}
          onClick={() => onSort(column)}
        >
          {sortActive ? (
            sortDir === 'asc' ? (
              <ArrowUp size={14} />
            ) : (
              <ArrowDown size={14} />
            )
          ) : (
            <ArrowUpDown size={14} />
          )}
        </button>
      </div>

      {open && menuPos ? (
        <div
          id={`${reactId}-menu`}
          ref={menuRef}
          className="column-filter-menu"
          role="dialog"
          aria-label={`Filter ${label}`}
          style={{
            top: menuPos.top,
            bottom: menuPos.bottom,
            left: menuPos.left,
            width: menuPos.width,
            maxHeight: menuPos.maxHeight,
          }}
        >
          <div className="column-filter-header">
            <strong>Filter {label}</strong>
            <button type="button" className="btn btn-ghost" onClick={() => onFilterChange(null)}>
              Clear
            </button>
          </div>

          <div className="column-filter-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={options.length === 0 || allVisibleSelected}
              onClick={selectAllVisible}
            >
              Select all{query ? ' matching' : ''}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={options.length === 0 || noneVisibleSelected}
              onClick={deselectAllVisible}
            >
              Deselect all{query ? ' matching' : ''}
            </button>
          </div>

          {options.length > 8 ? (
            <input
              className="column-filter-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search values…"
            />
          ) : null}

          <div className="column-filter-list">
            {options.length === 0 ? (
              <div className="multi-select-empty">No values for current filters</div>
            ) : (
              <>
                {visibleOptions.map((option) => {
                  const checked = unfiltered ? true : selectedSet.has(option)
                  return (
                    <label key={option} className="multi-select-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleValue(option)}
                      />
                      <span className="multi-select-option-text">
                        <span>{option}</span>
                      </span>
                      {checked ? <Check size={14} className="multi-select-check" /> : null}
                    </label>
                  )
                })}
                {visibleOptions.length === 0 ? (
                  <div className="multi-select-empty">No matching values</div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </th>
  )
}
