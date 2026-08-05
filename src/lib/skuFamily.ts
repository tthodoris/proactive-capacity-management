/** Normalize inventory SKU/size values to a capacity family/series label. */
export function toSkuFamily(sku?: string | null, size?: string | null): string {
  const sizeVal = String(size || '').trim()
  if (sizeVal) {
    const cleanedSize = sizeVal.replace(/\s+(family|series)\s*$/i, '').trim()
    if (
      cleanedSize &&
      !/^Standard_/i.test(cleanedSize) &&
      !/^\w+\d+[a-z]*_v?\d+$/i.test(cleanedSize)
    ) {
      return cleanedSize
    }
    if (cleanedSize && !/^Standard_/i.test(cleanedSize) && !/_\d+$/.test(cleanedSize)) {
      return cleanedSize
    }
  }

  const raw = String(sku || '').trim()
  if (!raw) return ''

  const cleaned = raw.replace(/\s+(family|series)\s*$/i, '').trim()

  const constrained = cleaned.match(/^Standard_([A-Za-z]+)\d+-\d+([a-z]*)_?(v\d+)?$/i)
  if (constrained) {
    return `${constrained[1]}${constrained[2] || ''}${constrained[3] || ''}`
  }

  const gpu = cleaned.match(/^Standard_([A-Za-z]+)(\d+)([a-z]*)_([A-Za-z]+\d+)_?(v\d+)?$/i)
  if (gpu) {
    return `${gpu[1]}${gpu[3] || ''}${gpu[4]}${gpu[5] ? `_${gpu[5]}` : ''}`
  }

  const vm = cleaned.match(/^Standard_([A-Za-z]+?)(\d+)([a-z]*)_?(v\d+)?$/i)
  if (vm) {
    const series = vm[1]
    const suffix = vm[3] || ''
    const version = vm[4] || ''
    return `${series}${suffix}${version}`
  }

  const genSized = cleaned.match(/^([A-Za-z]+)_Gen(\d+)(?:_\d+)?$/i)
  if (genSized) {
    return `${genSized[1]}_Gen${genSized[2]}`
  }

  const burstable = cleaned.match(
    /^(Burstable|Premium|GeneralPurpose|MemoryOptimized)([A-Za-z]*)\d+/i,
  )
  if (burstable) {
    return `${burstable[1]}${burstable[2] || ''}`
  }

  const stripped = cleaned.replace(/_\d+$/, '')
  if (stripped && stripped !== cleaned) return stripped

  return cleaned
}
