const MAX_RULES = 50
const MAX_KEYWORDS_PER_RULE = 100
const MAX_HEADERS_PER_RULE = 100
const MAX_KEYWORD_LENGTH = 512
const MAX_HEADER_VALUE_LENGTH = 8_192
const MAX_SERIALIZED_LENGTH = 100_000
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

export type CustomHeaderRule = Readonly<{
  keywords: readonly string[]
  headers: Readonly<Record<string, string>>
}>

export type CustomHeaderParseResult =
  | Readonly<{ status: 'ok'; rules: readonly CustomHeaderRule[] }>
  | Readonly<{ status: 'invalid'; message: string }>

const DEFAULT_RULES: readonly CustomHeaderRule[] = freezeRules([
  { keywords: ['cdn.dzen.ru'], headers: { Referer: 'https://dzen.ru/' } },
  { keywords: ['basseqwevewcewcewecwcw.xyz'], headers: { Referer: 'https://embed.warezcdn.link/' } },
  { keywords: ['AbuDhabiSportsChannel'], headers: { Origin: 'https://adtv.ae', Referer: 'https://adtv.ae/' } },
  { keywords: ['cloud.mail.ru', 'datacloudmail.ru', 'cloclo'], headers: { Origin: 'https://cloud.mail.ru', Referer: 'https://cloud.mail.ru/' } },
  { keywords: ['rumble.'], headers: { Origin: 'https://rumble.com', Referer: 'https://rumble.com/' } },
  { keywords: ['mncnow.'], headers: { Origin: 'https://www.visionplus.id', Referer: 'https://www.visionplus.id/' } },
  { keywords: ['dailymotion'], headers: { Origin: 'https://www.dailymotion.com', Referer: 'https://www.dailymotion.com/' } },
  { keywords: ['vuclip'], headers: { Origin: 'https://www.viu.com', Referer: 'https://www.viu.com/' } },
  { keywords: ['cloudfront.net/RCTI', 'cloudfront.net/MNCTV', 'cloudfront.net/GTV', 'cloudfront.net/INEWS', 'rctiplus.'], headers: { Origin: 'https://www.rctiplus.com', Referer: 'https://www.rctiplus.com/' } },
  { keywords: ['www.video.com', 'live-production.secureswiftcontent.com'], headers: { Origin: 'https://www.vidio.com', Referer: 'https://www.vidio.com/' } },
  { keywords: ['ttvnw.'], headers: { Origin: 'https://www.twitch.tv', Referer: 'https://www.twitch.tv/' } }
])

export function defaultCustomHeaderRules(): readonly CustomHeaderRule[] {
  return DEFAULT_RULES
}

export function decodeCustomHeaderRules(value: string): readonly CustomHeaderRule[] {
  try {
    const decoded: unknown = JSON.parse(value)
    return normalizedRules(decoded) ?? Object.freeze([])
  } catch {
    return Object.freeze([])
  }
}

export function customHeadersForUrl(rules: readonly CustomHeaderRule[], url: string | URL): Readonly<Record<string, string>> {
  const candidate = String(url).toLowerCase()
  for (const rule of rules) {
    if (rule.keywords.some((keyword) => candidate.includes(keyword.toLowerCase()))) return rule.headers
  }
  return Object.freeze({})
}

export function parseCustomHeaderSubmission(input: Readonly<Record<string, unknown>>): CustomHeaderParseResult {
  const rows = submittedRows(input)
  if (rows.length > MAX_RULES) return invalid(`No more than ${MAX_RULES} custom-header rules are allowed`)
  const rules: CustomHeaderRule[] = []

  for (const [index, row] of rows.entries()) {
    const keywords = lines(row.keywords)
    const headerLines = lines(row.headers)
    if (keywords.length === 0 && headerLines.length === 0) continue
    if (keywords.length > MAX_KEYWORDS_PER_RULE) return invalid(`Custom-header rule ${index + 1} has too many keywords`)
    if (headerLines.length > MAX_HEADERS_PER_RULE) return invalid(`Custom-header rule ${index + 1} has too many headers`)
    if (keywords.some((keyword) => keyword.length > MAX_KEYWORD_LENGTH || hasControlCharacters(keyword))) {
      return invalid(`Custom-header rule ${index + 1} contains an invalid keyword`)
    }

    const headers: Record<string, string> = {}
    for (const line of headerLines) {
      const separator = line.indexOf(':')
      if (separator <= 0) return invalid(`Custom-header rule ${index + 1} contains a malformed header`)
      const name = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim()
      const normalizedName = name.toLowerCase()
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(normalizedName)) {
        return invalid(`Custom-header rule ${index + 1} contains the unsafe header ${name || '(empty)'}`)
      }
      if (value.length > MAX_HEADER_VALUE_LENGTH || hasControlCharacters(value, true)) {
        return invalid(`Custom-header rule ${index + 1} contains an invalid ${name} value`)
      }
      headers[name] = value
    }
    rules.push(Object.freeze({ keywords: Object.freeze(keywords), headers: Object.freeze(headers) }))
  }

  if (JSON.stringify(rules).length > MAX_SERIALIZED_LENGTH) return invalid('The custom-header configuration is too large')
  return Object.freeze({ status: 'ok', rules: Object.freeze(rules) })
}

function submittedRows(input: Readonly<Record<string, unknown>>): Array<Readonly<{ keywords: string; headers: string }>> {
  const indexed = new Map<number, { keywords: string; headers: string }>()
  for (const [key, value] of Object.entries(input)) {
    const match = key.match(/^items\[(\d{1,3})\]\[(keywords|headers)\]$/)
    if (match === null) continue
    const index = Number(match[1])
    if (!Number.isSafeInteger(index)) continue
    const row = indexed.get(index) ?? { keywords: '', headers: '' }
    row[match[2] as 'keywords' | 'headers'] = scalarValue(value)
    indexed.set(index, row)
  }

  if (indexed.size === 0 && Array.isArray(input.items)) {
    input.items.slice(0, MAX_RULES + 1).forEach((value, index) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const row = value as Record<string, unknown>
      indexed.set(index, { keywords: scalarValue(row.keywords), headers: scalarValue(row.headers) })
    })
  }
  return [...indexed.entries()].sort(([left], [right]) => left - right).map(([, row]) => Object.freeze(row))
}

function normalizedRules(value: unknown): readonly CustomHeaderRule[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULES) return null
  const rules: CustomHeaderRule[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (!Array.isArray(row.keywords) || typeof row.headers !== 'object' || row.headers === null || Array.isArray(row.headers)) return null
    const keywords = row.keywords.filter((keyword): keyword is string => typeof keyword === 'string').map((keyword) => keyword.trim()).filter(Boolean)
    if (keywords.length > MAX_KEYWORDS_PER_RULE || keywords.some((keyword) => keyword.length > MAX_KEYWORD_LENGTH || hasControlCharacters(keyword))) return null
    const headers: Record<string, string> = {}
    for (const [name, headerValue] of Object.entries(row.headers as Record<string, unknown>)) {
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase()) || typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE_LENGTH || hasControlCharacters(headerValue, true)) continue
      headers[name] = headerValue
    }
    if (Object.keys(headers).length > MAX_HEADERS_PER_RULE) return null
    rules.push(Object.freeze({ keywords: Object.freeze(keywords), headers: Object.freeze(headers) }))
  }
  return Object.freeze(rules)
}

function freezeRules(rules: readonly { keywords: readonly string[]; headers: Readonly<Record<string, string>> }[]): readonly CustomHeaderRule[] {
  return Object.freeze(rules.map((rule) => Object.freeze({ keywords: Object.freeze([...rule.keywords]), headers: Object.freeze({ ...rule.headers }) })))
}

function lines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
}

function hasControlCharacters(value: string, allowTab = false): boolean {
  return allowTab ? /[\u0000-\u0008\u000A-\u001F\u007F]/.test(value) : /[\u0000-\u001F\u007F]/.test(value)
}

function scalarValue(value: unknown): string {
  const source = Array.isArray(value) ? value.at(-1) : value
  return typeof source === 'string' || typeof source === 'number' ? String(source) : ''
}

function invalid(message: string): CustomHeaderParseResult {
  return Object.freeze({ status: 'invalid', message })
}
