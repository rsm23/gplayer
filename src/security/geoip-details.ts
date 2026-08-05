import maxmind, { type AsnResponse, type CountryResponse, type Reader } from 'maxmind'

export type GeoIpDetails = Readonly<{
  asn: number | null
  organization: string
  country: string
  continent: string
}>

export type GeoIpDetailsLookup = (clientIp: string) => Promise<GeoIpDetails | null>

export function createGeoIpDetailsLookup(countryDatabasePath: string, asnDatabasePath: string): GeoIpDetailsLookup {
  let countryReader: Promise<Reader<CountryResponse>> | undefined
  let asnReader: Promise<Reader<AsnResponse>> | undefined
  return async (clientIp: string): Promise<GeoIpDetails | null> => {
    const normalizedIp = clientIp.startsWith('::ffff:') ? clientIp.slice('::ffff:'.length) : clientIp
    if (!maxmind.validate(normalizedIp)) return null
    try {
      countryReader ??= maxmind.open<CountryResponse>(countryDatabasePath, { cache: { max: 10_000 } })
      asnReader ??= maxmind.open<AsnResponse>(asnDatabasePath, { cache: { max: 10_000 } })
      const [countryRecord, asnRecord] = await Promise.all([
        (await countryReader).get(normalizedIp),
        (await asnReader).get(normalizedIp)
      ])
      const country = (countryRecord?.country?.iso_code ?? countryRecord?.registered_country?.iso_code ?? '').toUpperCase()
      const continent = (countryRecord?.continent?.code ?? '').toUpperCase()
      const asn = Number(asnRecord?.autonomous_system_number)
      const organization = String(asnRecord?.autonomous_system_organization ?? '').slice(0, 255)
      if (country === '' && continent === '' && !Number.isSafeInteger(asn)) return null
      return Object.freeze({
        asn: Number.isSafeInteger(asn) && asn > 0 && asn <= 4_294_967_295 ? asn : null,
        organization,
        country: /^[A-Z]{2,5}$/.test(country) ? country : '',
        continent: /^[A-Z]{2}$/.test(continent) ? continent : ''
      })
    } catch {
      return null
    }
  }
}
