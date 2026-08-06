import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

const CIPHER = 'aes-256-cbc'
const LEGACY_CIPHER = 'aes-128-cbc'
const BLOCK_SIZE = 16
const HMAC_SIZE = 32
const RESPONSE_DERIVED_KEY_SIZE = 48
const RESPONSE_PBKDF2_ITERATIONS = 10_000
const DEFAULT_KEY_SEED = 'GDPlayer~F1r3b4Ll'
const API_SALT = 'kntlMmkLuCoeg'

export interface SecurityTokenCache {
  get(key: string): string | undefined
  set(key: string, value: string, ttlMilliseconds: number): void
}

type CacheEntry = Readonly<{
  value: string
  expiresAt: number
}>

export class MemorySecurityTokenCache implements SecurityTokenCache {
  readonly #entries = new Map<string, CacheEntry>()

  get(key: string): string | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: string, ttlMilliseconds: number): void {
    this.#entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMilliseconds
    })
  }
}

export type SecurityOptions = Readonly<{
  keySeed?: string
  cache?: SecurityTokenCache
  cacheTtlMilliseconds?: number
  randomBytes?: (size: number) => Buffer
}>

/**
 * Versioned compatibility token codec.
 *
 * `decrypt` deliberately preserves the legacy fallback of returning an invalid
 * input unchanged. Route guards must use `decryptStrict` or `decryptURLStrict`
 * so malformed or unauthenticated tokens cannot be mistaken for plaintext.
 */
export class Security {
  readonly #key: Buffer
  readonly #cache: SecurityTokenCache
  readonly #cacheTtlMilliseconds: number
  readonly #randomBytes: (size: number) => Buffer

  constructor(secureSalt: string, options: SecurityOptions = {}) {
    if (secureSalt.length === 0) throw new Error('SECURE_SALT cannot be empty')

    this.#key = normalizeOpenSslKey(
      phpBase64Decode((options.keySeed ?? DEFAULT_KEY_SEED) + secureSalt),
      32
    )
    this.#cache = options.cache ?? new MemorySecurityTokenCache()
    this.#cacheTtlMilliseconds = options.cacheTtlMilliseconds ?? 10_800_000
    this.#randomBytes = options.randomBytes ?? randomBytes
  }

  encrypt(plainText = ''): string {
    if (plainText.length === 0) return ''

    const cacheKey = `encrypt:${plainText}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined) return cached

    const iv = this.#randomBytes(BLOCK_SIZE)
    if (iv.length !== BLOCK_SIZE) {
      throw new Error(`Random byte source returned ${iv.length} bytes; expected ${BLOCK_SIZE}`)
    }

    const cipher = createCipheriv(CIPHER, this.#key, iv)
    const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    const hmac = createHmac('sha256', this.#key).update(cipherText).digest()
    const encrypted = Buffer.concat([iv, hmac, cipherText]).toString('base64')

    this.#cache.set(cacheKey, encrypted, this.#cacheTtlMilliseconds)
    return encrypted
  }

  decryptStrict(encryptedText = ''): string | null {
    if (encryptedText.length === 0) return ''

    const envelope = decodeCanonicalBase64(encryptedText)
    if (envelope === null || envelope.length < BLOCK_SIZE + HMAC_SIZE + BLOCK_SIZE) return null

    const iv = envelope.subarray(0, BLOCK_SIZE)
    const includedHmac = envelope.subarray(BLOCK_SIZE, BLOCK_SIZE + HMAC_SIZE)
    const cipherText = envelope.subarray(BLOCK_SIZE + HMAC_SIZE)
    if (cipherText.length === 0 || cipherText.length % BLOCK_SIZE !== 0) return null

    const calculatedHmac = createHmac('sha256', this.#key).update(cipherText).digest()
    if (!timingSafeEqual(includedHmac, calculatedHmac)) return null

    try {
      const decipher = createDecipheriv(CIPHER, this.#key, iv)
      return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  decrypt(encryptedText = ''): string {
    return this.decryptStrict(encryptedText) ?? encryptedText
  }

  encryptURL(value: string | null = ''): string {
    if (value === null || value.length === 0) return ''
    return encodeLegacyBase64Url(this.encrypt(value))
  }

  decryptURLStrict(value: string | null = ''): string | null {
    if (value === null || value.length === 0) return ''
    const encrypted = decodeLegacyBase64Url(value)
    return encrypted === null ? null : this.decryptStrict(encrypted)
  }

  decryptURL(value: string | null = ''): string {
    if (value === null || value.length === 0) return ''
    const encrypted = decodeLegacyBase64Url(value)
    if (encrypted === null) return value
    return this.decrypt(encrypted)
  }

  encryptApiSalt(): string {
    return this.encryptURL(API_SALT)
  }

  validateApiSalt(securityKey = ''): boolean {
    return this.decryptURLStrict(securityKey) === API_SALT
  }

  encryptResponse(plainText: string, password: string): string {
    const salt = this.#randomBytes(BLOCK_SIZE)
    if (salt.length !== BLOCK_SIZE) {
      throw new Error(`Random byte source returned ${salt.length} bytes; expected ${BLOCK_SIZE}`)
    }

    const material = pbkdf2Sync(
      password,
      salt,
      RESPONSE_PBKDF2_ITERATIONS,
      RESPONSE_DERIVED_KEY_SIZE,
      'sha256'
    )
    const key = material.subarray(0, 32)
    const iv = material.subarray(32, RESPONSE_DERIVED_KEY_SIZE)
    const cipher = createCipheriv(CIPHER, key, iv)
    const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    return Buffer.concat([salt, cipherText]).toString('base64')
  }

  decryptResponseStrict(encryptedText: string, password: string): string | null {
    const envelope = decodeCanonicalBase64(encryptedText)
    if (envelope === null || envelope.length < BLOCK_SIZE * 2) return null

    const salt = envelope.subarray(0, BLOCK_SIZE)
    const cipherText = envelope.subarray(BLOCK_SIZE)
    if (cipherText.length === 0 || cipherText.length % BLOCK_SIZE !== 0) return null

    const material = pbkdf2Sync(
      password,
      salt,
      RESPONSE_PBKDF2_ITERATIONS,
      RESPONSE_DERIVED_KEY_SIZE,
      'sha256'
    )

    try {
      const decipher = createDecipheriv(
        CIPHER,
        material.subarray(0, 32),
        material.subarray(32, RESPONSE_DERIVED_KEY_SIZE)
      )
      return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }
}

/** Reproduces SecurityHelper::decryptData for pre-4.8 AES-128-CBC values. */
export function decryptLegacyData(data: string | null, secureSalt: string): string {
  if (data === null || data.length === 0) return ''

  try {
    const decodedUri = decodeURIComponent(data)
    const outer = Buffer.from(decodedUri, 'base64').toString('utf8')
    const separator = outer.indexOf('::')
    if (separator < 0) return ''

    const cipherText = outer.slice(0, separator)
    const ivText = outer.slice(separator + 2)
    if (ivText.length !== BLOCK_SIZE) return ''

    const decodedSalt = phpBase64Decode(secureSalt)
    const keySource = decodedSalt.length > 0 ? decodedSalt : Buffer.from(secureSalt, 'utf8')
    const key = normalizeOpenSslKey(keySource, 16)
    const cipherBytes = decodeCanonicalBase64(cipherText)
    if (cipherBytes === null || cipherBytes.length === 0 || cipherBytes.length % BLOCK_SIZE !== 0) {
      return ''
    }

    const decipher = createDecipheriv(LEGACY_CIPHER, key, Buffer.from(ivText, 'utf8'))
    return Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

export function encodeLegacyBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', ',')
}

export function decodeLegacyBase64Url(value: string): string | null {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').replaceAll(',', '=')
  const decoded = decodeCanonicalBase64(normalized)
  return decoded?.toString('utf8') ?? null
}

function phpBase64Decode(value: string): Buffer {
  // PHP base64_decode(value, false) discards non-alphabet characters. Node's
  // decoder also accepts base64url characters, so filter first to avoid treating
  // the legacy '-' in SECURE_SALT as a valid character.
  return Buffer.from(value.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
}

function normalizeOpenSslKey(source: Buffer, size: number): Buffer {
  const key = Buffer.alloc(size)
  source.copy(key, 0, 0, size)
  return key
}

function decodeCanonicalBase64(value: string): Buffer | null {
  const compact = value.replace(/\s/g, '')
  if (compact.length === 0 || compact.length % 4 !== 0) return null
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    return null
  }
  return Buffer.from(compact, 'base64')
}
