import maxmind, { type CountryResponse, type Reader } from 'maxmind'

export type CountryCodeLookup = (clientIp: string) => Promise<string>

export function createCountryCodeLookup(databasePath: string): CountryCodeLookup {
  let reader: Promise<Reader<CountryResponse>> | undefined
  return async (clientIp: string): Promise<string> => {
    const normalizedIp = clientIp.startsWith('::ffff:') ? clientIp.slice('::ffff:'.length) : clientIp
    if (!maxmind.validate(normalizedIp)) return ''
    try {
      reader ??= maxmind.open<CountryResponse>(databasePath, { cache: { max: 10_000 } })
      const record = (await reader).get(normalizedIp)
      return (record?.country?.iso_code ?? record?.registered_country?.iso_code ?? '').toUpperCase()
    } catch {
      return ''
    }
  }
}
