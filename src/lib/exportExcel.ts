import * as XLSX from 'xlsx'

export interface ExportColumn {
  key: string
  label: string
}

export interface ExportSheet {
  name: string
  columns: ExportColumn[]
  rows: Record<string, unknown>[]
}

function sheetFromColumns(
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
): XLSX.WorkSheet {
  const header = columns.map((c) => c.label)
  const data = rows.map((row) =>
    columns.map((col) => {
      const value = row[col.key]
      if (value == null) return ''
      if (Array.isArray(value)) return value.join(', ')
      return value
    }),
  )

  const worksheet = XLSX.utils.aoa_to_sheet([header, ...data])

  const colWidths = columns.map((col, index) => {
    let max = col.label.length
    for (const dataRow of data) {
      const len = String(dataRow[index] ?? '').length
      if (len > max) max = len
    }
    return { wch: Math.min(max + 2, 50) }
  })
  worksheet['!cols'] = colWidths
  return worksheet
}

function uniqueSheetName(name: string, used: Set<string>): string {
  const base = (name || 'Sheet').slice(0, 31)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (n < 100) {
    const suffix = ` (${n})`
    const candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    n += 1
  }
  const fallback = `${base.slice(0, 28)}_${used.size}`
  used.add(fallback)
  return fallback
}

/**
 * Export rows to an Excel (.xlsx) file and trigger a browser download.
 * @param filename - Name for the downloaded file (without extension).
 * @param sheetName - Excel sheet tab name.
 * @param columns - Ordered columns with keys and display labels.
 * @param rows - Data rows as objects keyed by column.key.
 */
export function exportToExcel(
  filename: string,
  sheetName: string,
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
) {
  exportSheetsToExcel(filename, [{ name: sheetName, columns, rows }])
}

/**
 * Export multiple sheets to a single Excel (.xlsx) workbook.
 */
export function exportSheetsToExcel(filename: string, sheets: ExportSheet[]) {
  const workbook = XLSX.utils.book_new()
  const usedNames = new Set<string>()

  for (const sheet of sheets) {
    const worksheet = sheetFromColumns(sheet.columns, sheet.rows)
    XLSX.utils.book_append_sheet(workbook, worksheet, uniqueSheetName(sheet.name, usedNames))
  }

  if (workbook.SheetNames.length === 0) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['No data']]), 'Empty')
  }

  XLSX.writeFile(workbook, `${filename}.xlsx`)
}
