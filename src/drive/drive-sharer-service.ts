import type { ProviderHttpClient, ProviderHttpResponse } from '../hosting/provider-http.js'

const GOOGLE_API_ROOT = 'https://www.googleapis.com'
const GOOGLE_TOKEN_URL = `${GOOGLE_API_ROOT}/oauth2/v4/token`
const REQUEST_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 5 * 1_024 * 1_024
const TOKEN_CACHE_SECONDS = 3_500

export type DriveAccount = Readonly<{
  email: string
  apiKey: string
  clientId: string
  clientSecret: string
  refreshToken: string
}>

export type DriveMirror = Readonly<{
  sourceId: string
  mirrorId: string
  mirrorEmail: string
}>

export interface DriveStore {
  listActiveBypassAccounts(): Promise<readonly DriveAccount[]>
  listMirrors(fileId: string, limit: number): Promise<readonly DriveMirror[]>
  saveMirror(sourceId: string, mirrorId: string, email: string, created: number): Promise<boolean>
}

export type DriveBypassResult = Readonly<{ id: string; link: string }>

type DriveFile = Readonly<{
  id: string
  title: string
  description: string
  originalFilename: string
}>

type CachedToken = Readonly<{ value: string; type: string; expiresAt: number }>

export type DriveSharerOptions = Readonly<{
  now?: () => number
  requestTimeoutMs?: number
}>

export class DriveSharerService {
  private readonly now: () => number
  private readonly requestTimeoutMs: number
  private readonly tokenCache = new Map<string, CachedToken>()
  private readonly inFlight = new Map<string, Promise<DriveBypassResult | null>>()

  public constructor(
    private readonly store: DriveStore,
    private readonly http: ProviderHttpClient,
    options: DriveSharerOptions = {}
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  }

  public async bypass(input: string): Promise<DriveBypassResult | null> {
    const fileId = parseGoogleDriveId(input)
    if (fileId === null) return null
    const running = this.inFlight.get(fileId)
    if (running !== undefined) return await running
    const operation = this.copyOrReuse(fileId).finally(() => this.inFlight.delete(fileId))
    this.inFlight.set(fileId, operation)
    return await operation
  }

  private async copyOrReuse(fileId: string): Promise<DriveBypassResult | null> {
    let accounts: readonly DriveAccount[]
    try {
      accounts = await this.store.listActiveBypassAccounts()
    } catch {
      return null
    }
    if (accounts.length === 0) return null

    const accountByEmail = new Map(accounts.map((account) => [account.email.toLowerCase(), account]))
    try {
      const mirrors = await this.store.listMirrors(fileId, 5)
      for (const mirror of mirrors) {
        const account = accountByEmail.get(mirror.mirrorEmail.toLowerCase())
        if (account === undefined) continue
        const candidateId = mirror.sourceId === fileId ? mirror.mirrorId : fileId
        if (await this.fileInfo(account, candidateId) !== null) return bypassResult(candidateId)
      }
    } catch {
      // A failed mirror lookup must not prevent a fresh copy attempt.
    }

    for (const account of accounts) {
      const source = await this.fileInfo(account, fileId)
      if (source === null) continue
      const copied = await this.copyFile(account, source)
      if (copied === null || copied.id === fileId) continue
      await this.makePublic(account, copied.id).catch(() => false)
      await this.store.saveMirror(fileId, copied.id, account.email, this.now()).catch(() => false)
      const verified = await this.fileInfo(account, copied.id)
      if (verified !== null) return bypassResult(verified.id)
    }
    return null
  }

  private async accessToken(account: DriveAccount): Promise<CachedToken | null> {
    const cached = this.tokenCache.get(account.email)
    if (cached !== undefined && cached.expiresAt > this.now() + 15) return cached
    const body = new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token'
    }).toString()
    const response = await this.request('post', {
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    })
    const json = response === null ? null : responseJson(response)
    const accessToken = stringField(json, 'access_token', 8, 8_192)
    const tokenTypeValue = stringField(json, 'token_type', 1, 50)
    const tokenType = tokenTypeValue !== null && /^[A-Za-z]{1,50}$/.test(tokenTypeValue) ? tokenTypeValue : 'Bearer'
    if (accessToken === null || /[\u0000-\u0020\u007f]/.test(accessToken)) return null
    const statedLifetime = numberField(json, 'expires_in')
    const lifetime = Math.max(60, Math.min(TOKEN_CACHE_SECONDS, statedLifetime ?? TOKEN_CACHE_SECONDS))
    const token = Object.freeze({ value: accessToken, type: tokenType, expiresAt: this.now() + lifetime })
    this.tokenCache.set(account.email, token)
    return token
  }

  private async fileInfo(account: DriveAccount, fileId: string): Promise<DriveFile | null> {
    const token = await this.accessToken(account)
    if (token === null) return null
    const url = new URL(`${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('acknowledgeAbuse', 'true')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('key', account.apiKey)
    const response = await this.request('get', {
      url,
      headers: { authorization: `${token.type} ${token.value}`, accept: 'application/json' }
    })
    const json = response === null ? null : responseJson(response)
    const id = stringField(json, 'id', 10, 50)
    if (id === null || parseGoogleDriveId(id) === null) return null
    const title = stringField(json, 'title', 1, 255) ?? 'GPlayer copy'
    return Object.freeze({
      id,
      title,
      description: stringField(json, 'description', 0, 10_000) ?? '',
      originalFilename: stringField(json, 'originalFilename', 1, 255) ?? title
    })
  }

  private async copyFile(account: DriveAccount, source: DriveFile): Promise<DriveFile | null> {
    const token = await this.accessToken(account)
    if (token === null) return null
    const url = new URL(`${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(source.id)}/copy`)
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('key', account.apiKey)
    const response = await this.request('post', {
      url,
      headers: {
        authorization: `${token.type} ${token.value}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        copyable: true,
        parents: [{ id: 'root' }],
        title: source.title,
        description: 'Copy created by the GPlayer Drive bypass tool.',
        originalFilename: source.originalFilename
      })
    })
    const json = response === null ? null : responseJson(response)
    const id = stringField(json, 'id', 10, 50)
    if (id === null || parseGoogleDriveId(id) === null) return null
    return Object.freeze({ ...source, id })
  }

  private async makePublic(account: DriveAccount, fileId: string): Promise<boolean> {
    const token = await this.accessToken(account)
    if (token === null) return false
    const url = new URL(`${GOOGLE_API_ROOT}/drive/v2/files/${encodeURIComponent(fileId)}/permissions`)
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('alt', 'json')
    return await this.request('post', {
      url,
      headers: {
        authorization: `${token.type} ${token.value}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    }) !== null
  }

  private async request(
    method: 'get' | 'post',
    request: Parameters<ProviderHttpClient['post']>[0]
  ): Promise<ProviderHttpResponse | null> {
    try {
      const signal = AbortSignal.timeout(this.requestTimeoutMs)
      const response = method === 'get'
        ? await this.http.get({ ...request, signal })
        : await this.http.post({ ...request, signal })
      if (response.status < 200 || response.status >= 300 || Buffer.byteLength(response.body) > MAX_JSON_BYTES) return null
      return response
    } catch {
      return null
    }
  }
}

export class RecaptchaVerifier {
  public constructor(
    private readonly http: ProviderHttpClient,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS
  ) {}

  public async verify(secret: string, responseToken: string, remoteIp: string): Promise<boolean> {
    if (secret.trim() === '') return true
    if (responseToken.trim() === '' || responseToken.length > 8_192) return false
    try {
      const response = await this.http.post({
        url: 'https://www.google.com/recaptcha/api/siteverify',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ secret, response: responseToken, remoteip: remoteIp }).toString(),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      })
      if (response.status < 200 || response.status >= 400 || Buffer.byteLength(response.body) > MAX_JSON_BYTES) return false
      return responseJson(response)?.success === true
    } catch {
      return false
    }
  }
}

export function parseGoogleDriveId(input: string): string | null {
  const value = input.trim()
  if (isDriveId(value)) return value
  if (value.length === 0 || value.length > 2_048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname.toLowerCase()) || url.username !== '' || url.password !== '') return null
    const queryId = url.searchParams.get('id')
    if (queryId !== null && isDriveId(queryId)) return queryId
    const parts = url.pathname.split('/').filter(Boolean)
    const marker = parts.findIndex((part) => part === 'd' || part === 'folders')
    const pathId = marker >= 0 ? parts[marker + 1] : undefined
    return pathId !== undefined && isDriveId(pathId) ? pathId : null
  } catch {
    return null
  }
}

function isDriveId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,50}$/.test(value)
}

function bypassResult(id: string): DriveBypassResult {
  return Object.freeze({ id, link: `https://drive.google.com/file/d/${id}/view` })
}

function responseJson(response: ProviderHttpResponse): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(response.body)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringField(value: Record<string, unknown> | null, key: string, minimum: number, maximum: number): string | null {
  const field = value?.[key]
  if (typeof field !== 'string') return null
  const normalized = field.trim()
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : null
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key]
  const number = typeof field === 'number' ? field : typeof field === 'string' ? Number(field) : Number.NaN
  return Number.isFinite(number) && number > 0 ? number : null
}
