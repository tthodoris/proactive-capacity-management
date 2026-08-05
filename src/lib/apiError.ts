/** Build a user-visible Error from a failed fetch JSON body. */
export function apiErrorFromResponse(
  res: Response,
  data: Record<string, unknown> | null | undefined,
): Error {
  const body = data && typeof data === 'object' ? data : {}
  const primary =
    (typeof body.error === 'string' && body.error) ||
    (typeof body.message === 'string' && body.message) ||
    `Request failed (${res.status})`
  const hint = typeof body.hint === 'string' ? body.hint.trim() : ''
  const code = body.code != null ? String(body.code) : ''
  const parts = [primary]
  if (hint && !primary.includes(hint)) parts.push(hint)
  if (code && !primary.includes(code)) parts.push(`code ${code}`)
  return new Error(parts.join(' — '))
}
