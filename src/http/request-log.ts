const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'adv_token',
  'api_key',
  'apikey',
  'authorization',
  'password',
  'secret',
  'token'
])

export function redactSensitiveRequestUrl(value: string): string {
  const separator = value.indexOf('?')
  if (separator < 0) return value
  const path = value.slice(0, separator)
  const query = new URLSearchParams(value.slice(separator + 1))
  let redacted = false
  for (const key of new Set(query.keys())) {
    if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) continue
    query.set(key, '[redacted]')
    redacted = true
  }
  return redacted ? `${path}?${query.toString()}` : value
}
