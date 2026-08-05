import { webcrypto } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { BaseExtractor } from './base-extractor.js'
import type { ProviderHttpClient, ProviderHttpResponse } from './provider-http.js'

const FILEMOON_ORIGIN = 'https://filemoon.to'
const FILEMOON_USER_AGENT = `GPlayer/0.1 Node.js/${process.versions.node}`
const PROOF_TIMEOUT_MS = 20_000
const PROOF_BATCH_SIZE = 1_024
const PROOF_MEMORY_WORDS = 512
const PROOF_MEMORY_MASK = PROOF_MEMORY_WORDS - 1
const ALLOWED_API_HOSTS = new Set(['filemoon.to', 'www.filemoon.to', 'q8y5z.com', 'byse.sx'])

type JsonObject = Record<string, unknown>

export type FilemoonProofSolver = (
  nonce: string,
  difficulty: number,
  timeoutMs?: number
) => Promise<string | null>

export type FilemoonExtractorOptions = Readonly<{
  solveProof?: FilemoonProofSolver
}>

export type FilemoonDeviceFingerprint = Readonly<{
  token: string
  viewer_id: string
  device_id: string
  confidence: number
}>

export class FilemoonExtractor extends BaseExtractor {
  #loaded = false

  public constructor(
    id: string,
    private readonly http: ProviderHttpClient,
    private readonly options: FilemoonExtractorOptions = {}
  ) {
    super(normalizeFilemoonId(id))
  }

  public override async getSources() {
    await this.load()
    return this.sources
  }

  public override async getTracks() {
    await this.load()
    return this.tracks
  }

  private async load(): Promise<void> {
    if (this.#loaded || !isSafeFileCode(this.id)) return
    this.#loaded = true

    const parentUrl = `${FILEMOON_ORIGIN}/e/${encodeURIComponent(this.id)}`
    this.referer = parentUrl
    this.image = `https://img-place.com/${encodeURIComponent(this.id)}.jpg`
    this.filmstrip = `https://q8y5z.com/api/videos/${encodeURIComponent(this.id)}/embed/timeslider`

    try {
      const detailsResponse = await this.http.get({
        url: `${FILEMOON_ORIGIN}/api/videos/${encodeURIComponent(this.id)}/embed/details`,
        headers: { referer: parentUrl, 'x-embed-parent': parentUrl }
      })
      if (!isSuccessfulProviderResponse(detailsResponse, new Set(['filemoon.to', 'www.filemoon.to']))) return
      const details = parseObject(detailsResponse.body)
      if (details === null || stringValue(details.error) !== '') return

      this.title = stringValue(details.title)
      const poster = safeHttpUrl(stringValue(details.poster_url))
      if (poster !== '') this.image = poster

      const embedUrl = safeProviderUrl(stringValue(details.embed_frame_url))
      if (embedUrl === null) return
      const apiOrigin = embedUrl.origin
      this.referer = embedUrl.toString()
      this.filmstrip = `${apiOrigin}/api/videos/${encodeURIComponent(this.id)}/embed/timeslider`
      const embedHeaders = {
        referer: this.referer,
        'user-agent': FILEMOON_USER_AGENT,
        'x-embed-parent': parentUrl
      }

      const settingsResponse = await this.http.get({
        url: `${apiOrigin}/api/videos/${encodeURIComponent(this.id)}/embed/settings`,
        headers: embedHeaders
      })
      if (!isSuccessfulProviderResponse(settingsResponse, new Set([embedUrl.hostname]))) return
      const settings = parseObject(settingsResponse.body)
      if (settings === null || stringValue(settings.error) !== '') return

      const fingerprint = await attestFilemoonDevice(this.http, apiOrigin, embedUrl.hostname, embedHeaders)
      if (fingerprint === null) return

      let captchaToken = ''
      if (settings.captcha_required === true) {
        captchaToken = await this.verifyProof(apiOrigin, embedUrl.hostname, embedHeaders, fingerprint)
        if (captchaToken === '') return
      }

      const playbackResponse = await this.http.post({
        url: `${apiOrigin}/api/videos/${encodeURIComponent(this.id)}/embed/playback`,
        headers: {
          ...embedHeaders,
          'content-type': 'application/json',
          ...(captchaToken === '' ? {} : { 'x-captcha-token': captchaToken })
        },
        body: JSON.stringify({ fingerprint })
      })
      if (!isSuccessfulProviderResponse(playbackResponse, new Set([embedUrl.hostname]))) return
      const playbackEnvelope = parseObject(playbackResponse.body)
      const playback = objectValue(playbackEnvelope?.playback)
      if (playback === null) return
      const decoded = await decryptFilemoonPlayback(playback)
      if (decoded === null) return

      const sourceValues = Array.isArray(decoded.sources) ? decoded.sources : []
      for (const value of sourceValues) {
        const source = objectValue(value)
        const file = safeHttpUrl(stringValue(source?.url))
        if (file === '') continue
        this.sources.push({
          file,
          type: filemoonMediaType(stringValue(source?.mime_type), file),
          label: filemoonSourceLabel(source)
        })
      }

      const trackValues = Array.isArray(decoded.tracks) ? decoded.tracks : []
      for (const value of trackValues) {
        const track = objectValue(value)
        const file = safeHttpUrl(stringValue(track?.url))
        if (file === '') continue
        const language = stringValue(track?.language)
        const title = stringValue(track?.title)
        this.tracks.push({
          file,
          label: title || language || 'Subtitles',
          ...(stringValue(track?.kind) === '' ? {} : { kind: stringValue(track?.kind) }),
          ...(track?.default === true ? { default: true } : {})
        })
      }

      const playbackPoster = safeHttpUrl(stringValue(decoded.poster_url))
      if (playbackPoster !== '') this.image = playbackPoster
    } catch {
      // Invalid, expired, restricted, or unavailable provider responses produce an empty result.
    }
  }

  private async verifyProof(
    apiOrigin: string,
    apiHostname: string,
    embedHeaders: Readonly<Record<string, string>>,
    fingerprint: FilemoonDeviceFingerprint
  ): Promise<string> {
    const captchaResponse = await this.http.post({
      url: `${apiOrigin}/api/videos/${encodeURIComponent(this.id)}/embed/captcha`,
      headers: { ...embedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint })
    })
    if (!isSuccessfulProviderResponse(captchaResponse, new Set([apiHostname]))) return ''
    const challenge = parseObject(captchaResponse.body)
    const nonce = stringValue(challenge?.pow_nonce)
    const powToken = stringValue(challenge?.pow_token)
    const difficulty = numberValue(challenge?.pow_difficulty)
    if (nonce === '' || powToken === '' || difficulty === null || difficulty < 0 || difficulty > 256) return ''

    const solver = this.options.solveProof ?? solveFilemoonProof
    const solution = await solver(nonce, difficulty, PROOF_TIMEOUT_MS)
    if (solution === null || !/^\d+$/.test(solution)) return ''

    const verifyResponse = await this.http.post({
      url: `${apiOrigin}/api/videos/${encodeURIComponent(this.id)}/embed/captcha/verify`,
      headers: { ...embedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ pow_token: powToken, solution, fingerprint })
    })
    if (!isSuccessfulProviderResponse(verifyResponse, new Set([apiHostname]))) return ''
    const verification = parseObject(verifyResponse.body)
    return verification?.status === 'ok' ? stringValue(verification.token) : ''
  }
}

export async function attestFilemoonDevice(
  http: ProviderHttpClient,
  apiOrigin: string,
  apiHostname: string,
  headers: Readonly<Record<string, string>>
): Promise<FilemoonDeviceFingerprint | null> {
  try {
    const challengeResponse = await http.post({
      url: `${apiOrigin}/api/videos/access/challenge`,
      headers
    })
    if (!isSuccessfulProviderResponse(challengeResponse, new Set([apiHostname]))) return null
    const challenge = parseObject(challengeResponse.body)
    const challengeId = stringValue(challenge?.challenge_id)
    const nonce = stringValue(challenge?.nonce)
    if (challengeId === '' || nonce === '') return null

    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )
    const publicKey = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey)
    const signature = Buffer.from(await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new TextEncoder().encode(nonce)
    )).toString('base64url')
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const attestationResponse = await http.post({
      url: `${apiOrigin}/api/videos/access/attest`,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        viewer_id: '',
        device_id: '',
        challenge_id: challengeId,
        nonce,
        signature,
        public_key: publicKey,
        client: {
          user_agent: FILEMOON_USER_AGENT,
          architecture: process.arch,
          bitness: process.arch.includes('64') ? '64' : '32',
          platform: process.platform,
          languages: ['en'],
          timezone,
          hardware_concurrency: availableParallelism(),
          touch_points: 0,
          extra: {}
        },
        storage: {},
        attributes: { entropy: 'low' }
      })
    })
    if (!isSuccessfulProviderResponse(attestationResponse, new Set([apiHostname]))) return null
    const attestation = parseObject(attestationResponse.body)
    const token = stringValue(attestation?.token)
    const viewerId = stringValue(attestation?.viewer_id)
    const deviceId = stringValue(attestation?.device_id)
    const confidence = numberValue(attestation?.confidence)
    if (token === '' || viewerId === '' || deviceId === '' || confidence === null) return null
    return { token, viewer_id: viewerId, device_id: deviceId, confidence }
  } catch {
    return null
  }
}

export async function decryptFilemoonPlayback(envelope: JsonObject): Promise<JsonObject | null> {
  const keyParts = Array.isArray(envelope.key_parts)
    ? envelope.key_parts.map(stringValue).filter((part) => part !== '')
    : []
  if (keyParts.length === 0) return null

  const selectedParts = selectedKeyParts(keyParts, stringValue(envelope.version))
  try {
    const key = Buffer.concat(selectedParts.map(decodeBase64Url))
    const iv = decodeBase64Url(stringValue(envelope.iv))
    const payload = decodeBase64Url(stringValue(envelope.payload))
    if (![16, 24, 32].includes(key.length) || iv.length < 8 || payload.length <= 16) return null
    const cryptoKey = await webcrypto.subtle.importKey('raw', Uint8Array.from(key), 'AES-GCM', false, ['decrypt'])
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(iv) },
      cryptoKey,
      Uint8Array.from(payload)
    )
    return parseObject(Buffer.from(plaintext).toString('utf8'))
  } catch {
    return null
  }
}

export async function solveFilemoonProof(
  nonce: string,
  difficulty: number,
  timeoutMs = PROOF_TIMEOUT_MS
): Promise<string | null> {
  if (nonce === '' || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) return null
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null
  if (difficulty === 0) return '0'

  const prefix = `${nonce}:`
  const started = Date.now()
  let counter = 0
  while (Date.now() - started <= timeoutMs) {
    for (let index = 0; index < PROOF_BATCH_SIZE; index += 1) {
      if (filemoonProofLeadingZeroBits(`${prefix}${counter}`) >= difficulty) return String(counter)
      counter += 1
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return null
}

export function filemoonProofLeadingZeroBits(input: string): number {
  const words = filemoonProofHash(input)
  let count = 0
  for (const word of words) {
    if (word === 0) {
      count += 32
      continue
    }
    return count + Math.clz32(word)
  }
  return count
}

function filemoonProofHash(input: string): Uint32Array {
  const state = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762])
  for (let index = 0; index < input.length; index += 1) {
    state[0] = ((state[0] ?? 0) + (input.charCodeAt(index) & 255)) >>> 0
    state[0] = rotateLeft(state[0] ?? 0, 7)
    filemoonQuarterRound(state)
  }
  for (let index = 0; index < 8; index += 1) filemoonQuarterRound(state)

  const memory = new Uint32Array(PROOF_MEMORY_WORDS)
  for (let index = 0; index < memory.length; index += 1) {
    filemoonQuarterRound(state)
    memory[index] = ((state[0] ?? 0) ^ (state[2] ?? 0)) >>> 0
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < memory.length; index += 1) {
      const mixedIndex = (memory[index] ?? 0) & PROOF_MEMORY_MASK
      let value = ((memory[index] ?? 0) + (memory[mixedIndex] ?? 0)) >>> 0
      value = rotateLeft(value, 13)
      value = (value ^ Math.imul(memory[(index + 1) & PROOF_MEMORY_MASK] ?? 0, 2654435761)) >>> 0
      memory[index] = value
      state[0] = ((state[0] ?? 0) ^ value) >>> 0
      filemoonQuarterRound(state)
    }
  }

  const result = new Uint32Array(8)
  const blockSize = PROOF_MEMORY_WORDS / result.length
  for (let index = 0; index < result.length; index += 1) {
    filemoonQuarterRound(state)
    let value = state[0] ?? 0
    const offset = index * blockSize
    for (let word = 0; word < blockSize; word += 1) {
      const memoryWord = memory[offset + word] ?? 0
      value = (value + memoryWord) >>> 0
      value = rotateLeft(value, 5)
      value = (value ^ Math.imul(memoryWord, 2246822519)) >>> 0
    }
    result[index] = (value ^ (state[2] ?? 0)) >>> 0
  }
  return result
}

function filemoonQuarterRound(state: Uint32Array): void {
  state[0] = ((state[0] ?? 0) + (state[1] ?? 0)) >>> 0
  state[3] = rotateLeft((state[3] ?? 0) ^ (state[0] ?? 0), 16)
  state[2] = ((state[2] ?? 0) + (state[3] ?? 0)) >>> 0
  state[1] = rotateLeft((state[1] ?? 0) ^ (state[2] ?? 0), 12)
  state[0] = ((state[0] ?? 0) + (state[1] ?? 0)) >>> 0
  state[3] = rotateLeft((state[3] ?? 0) ^ (state[0] ?? 0), 8)
  state[2] = ((state[2] ?? 0) + (state[3] ?? 0)) >>> 0
  state[1] = rotateLeft((state[1] ?? 0) ^ (state[2] ?? 0), 7)
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits | value >>> (32 - bits)) >>> 0
}

function selectedKeyParts(parts: readonly string[], version: string): readonly string[] {
  const versionNumber = Number(version)
  if (!Number.isInteger(versionNumber) || versionNumber < 1 || versionNumber > 20) return parts
  const indexes = [versionNumber, 31 - versionNumber]
  if (indexes.some((index) => index < 1 || index > parts.length)) return parts
  const selected = indexes.map((index) => parts[index - 1]).filter((part): part is string => part !== undefined && part !== '')
  return selected.length > 0 ? selected : parts
}

function decodeBase64Url(value: string): Buffer {
  if (value === '' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid base64url value')
  return Buffer.from(value, 'base64url')
}

function filemoonMediaType(mimeType: string, file: string): 'hls' | 'mpd' | 'video/mp4' {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(file)) return 'hls'
  if (normalized.includes('dash') || normalized.includes('mpd') || /\.mpd(?:$|[?#])/i.test(file)) return 'mpd'
  return 'video/mp4'
}

function filemoonSourceLabel(source: JsonObject | null): string {
  const explicit = stringValue(source?.label) || stringValue(source?.quality)
  if (explicit !== '') return explicit
  const height = numberValue(source?.height)
  return height !== null && height > 0 ? `${Math.trunc(height)}p` : 'Original'
}

function normalizeFilemoonId(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    if (!ALLOWED_API_HOSTS.has(url.hostname.toLowerCase())) return ''
    return url.pathname.split('/').filter(Boolean)[1] ?? ''
  } catch {
    return trimmed.split(/[/?#]/, 1)[0] ?? ''
  }
}

function safeProviderUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && ALLOWED_API_HOSTS.has(url.hostname.toLowerCase())
      ? url
      : null
  } catch {
    return null
  }
}

function safeHttpUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

function isSuccessfulProviderResponse(response: ProviderHttpResponse, allowedHosts: ReadonlySet<string>): boolean {
  return response.status >= 200 && response.status < 300 && allowedHosts.has(response.url.hostname.toLowerCase())
}

function isSafeFileCode(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function parseObject(value: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
