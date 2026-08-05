import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface CheckboxMultiSelectOption {
  value: string
  label: string
  hint?: string
}

interface CheckboxMultiSelectProps {
  id?: string
  label: string
  options: CheckboxMultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  selectAllLabel?: string
  emptyLabel?: string
  /** Show search box when option count exceeds this (default 5). Set 0 to always show. */
  searchableFrom?: number
  searchPlaceholder?: string
}

interface MenuPosition {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

export function CheckboxMultiSelect({
  id,
  label,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  selectAllLabel = 'Select all',
  emptyLabel = 'No options available',
  searchableFrom = 5,
  searchPlaceholder = 'Search…',
}: CheckboxMultiSelectProps) {
  const reactId = useId()
  const controlId = id || reactId
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const selectedSet = useMemo(() => new Set(value), [value])
  const searchable = options.length >= searchableFrom

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((option) => {
      const hay = `${option.label} ${option.hint ?? ''} ${option.value}`.toLowerCase()
      return hay.includes(q)
    })
  }, [options, query])

  const allSelected = options.length > 0 && options.every((o) => selectedSet.has(o.value))
  const someSelected = options.some((o) => selectedSet.has(o.value))
  const allVisibleSelected =
    visibleOptions.length > 0 && visibleOptions.every((o) => selectedSet.has(o.value))
  const someVisibleSelected = visibleOptions.some((o) => selectedSet.has(o.value))

  const summary = useMemo(() => {
    if (options.length === 0) return emptyLabel
    if (allSelected) return `All (${options.length})`
    if (value.length === 0) return placeholder
    if (value.length === 1) {
      return options.find((o) => o.value === value[0])?.label || value[0]
    }
    return `${value.length} selected`
  }, [allSelected, emptyLabel, options, placeholder, value])

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
      const preferredMax = 360
      const spaceBelow = window.innerHeight - rect.bottom - gap - 12
      const spaceAbove = rect.top - gap - 12
      const openUp = spaceBelow < 200 && spaceAbove > spaceBelow
      const available = Math.max(160, openUp ? spaceAbove : spaceBelow)

      if (openUp) {
        setMenuPos({
          bottom: window.innerHeight - rect.top + gap,
          left: rect.left,
          width: rect.width,
          maxHeight: Math.min(preferredMax, available),
        })
      } else {
        setMenuPos({
          top: rect.bottom + gap,
          left: rect.left,
          width: rect.width,
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
  }, [open, options.length, visibleOptions.length])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus()
    })
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggleValue(optionValue: string) {
    if (selectedSet.has(optionValue)) {
      onChange(value.filter((v) => v !== optionValue))
    } else {
      onChange([...value, optionValue])
    }
  }

  function toggleAllVisible() {
    const visibleValues = visibleOptions.map((o) => o.value)
    if (allVisibleSelected) {
      const drop = new Set(visibleValues)
      onChange(value.filter((v) => !drop.has(v)))
      return
    }
    onChange([...new Set([...value, ...visibleValues])])
  }

  const selectAllText = query.trim()
    ? allVisibleSelected
      ? 'Deselect matching'
      : 'Select matching'
    : selectAllLabel

  return (
    <div className={`multi-select${disabled ? ' disabled' : ''}${open ? ' open' : ''}`} ref={rootRef}>
      <label htmlFor={controlId}>{label}</label>
      <button
        id={controlId}
        ref={triggerRef}
        type="button"
        className="multi-select-trigger"
        disabled={disabled || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{summary}</span>
        <ChevronDown size={16} />
      </button>
      {open && menuPos ? (
        <div
          ref={menuRef}
          className="multi-select-menu"
          role="listbox"
          aria-multiselectable="true"
          style={{
            top: menuPos.top,
            bottom: menuPos.bottom,
            left: menuPos.left,
            width: menuPos.width,
            maxHeight: menuPos.maxHeight,
          }}
        >
          {options.length === 0 ? (
            <div className="multi-select-empty">{emptyLabel}</div>
          ) : (
            <>
              {searchable ? (
                <div className="multi-select-search-wrap">
                  <input
                    ref={searchRef}
                    className="multi-select-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={`Filter ${label}`}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </div>
              ) : null}
              <label className="multi-select-option select-all">
                <input
                  type="checkbox"
                  checked={query.trim() ? allVisibleSelected : allSelected}
                  ref={(el) => {
                    if (!el) return
                    el.indeterminate = query.trim()
                      ? someVisibleSelected && !allVisibleSelected
                      : someSelected && !allSelected
                  }}
                  onChange={toggleAllVisible}
                  disabled={visibleOptions.length === 0}
                />
                <span>{selectAllText}</span>
                {(query.trim() ? allVisibleSelected : allSelected) ? (
                  <Check size={14} className="multi-select-check" />
                ) : null}
              </label>
              <div className="multi-select-divider" />
              <div className="multi-select-list">
                {visibleOptions.length === 0 ? (
                  <div className="multi-select-empty">No matching options</div>
                ) : (
                  visibleOptions.map((option) => {
                    const checked = selectedSet.has(option.value)
                    return (
                      <label key={option.value} className="multi-select-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleValue(option.value)}
                        />
                        <span className="multi-select-option-text">
                          <span>{option.label}</span>
                          {option.hint ? <span className="muted">{option.hint}</span> : null}
                        </span>
                        {checked ? <Check size={14} className="multi-select-check" /> : null}
                      </label>
                    )
                  })
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
