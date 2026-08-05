import path from 'node:path'

const XXH_PRIME_1 = 0x9e3779b1
const XXH_PRIME_2 = 0x85ebca77
const XXH_PRIME_3 = 0xc2b2ae3d
const XXH_PRIME_4 = 0x27d4eb2f
const XXH_PRIME_5 = 0x165667b1

export type MediaCachePaths = Readonly<{
  directory: string
  temporary: string
  complete: string
  error: string
}>

export function legacyXxh32(value: string): string {
  const input = Buffer.from(value)
  let offset = 0
  let hash: number
  if (input.length >= 16) {
    let v1 = (XXH_PRIME_1 + XXH_PRIME_2) >>> 0
    let v2 = XXH_PRIME_2
    let v3 = 0
    let v4 = (-XXH_PRIME_1) >>> 0
    const limit = input.length - 16
    while (offset <= limit) {
      v1 = xxhRound(v1, input.readUInt32LE(offset)); offset += 4
      v2 = xxhRound(v2, input.readUInt32LE(offset)); offset += 4
      v3 = xxhRound(v3, input.readUInt32LE(offset)); offset += 4
      v4 = xxhRound(v4, input.readUInt32LE(offset)); offset += 4
    }
    hash = (rotateLeft(v1, 1) + rotateLeft(v2, 7) + rotateLeft(v3, 12) + rotateLeft(v4, 18)) >>> 0
  } else {
    hash = XXH_PRIME_5
  }

  hash = (hash + input.length) >>> 0
  while (offset + 4 <= input.length) {
    hash = Math.imul(rotateLeft((hash + Math.imul(input.readUInt32LE(offset), XXH_PRIME_3)) >>> 0, 17), XXH_PRIME_4) >>> 0
    offset += 4
  }
  while (offset < input.length) {
    hash = Math.imul(rotateLeft((hash + Math.imul(input[offset] ?? 0, XXH_PRIME_5)) >>> 0, 11), XXH_PRIME_1) >>> 0
    offset += 1
  }
  hash ^= hash >>> 15
  hash = Math.imul(hash, XXH_PRIME_2) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, XXH_PRIME_3) >>> 0
  hash ^= hash >>> 16
  return hash.toString(16).padStart(8, '0')
}

export function mediaCachePaths(cacheRoot: string, host: string, hostId: string, label: string): MediaCachePaths {
  const root = path.resolve(cacheRoot, 'files')
  const safeHost = /^[a-z0-9_-]{1,50}$/.test(host) ? host : `host-${legacyXxh32(host)}`
  const safeLabel = legacyCacheLabel(label)
  const directory = path.resolve(root, safeHost, legacyXxh32(hostId))
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) throw new Error('Media cache path escaped its configured root')
  const base = path.join(directory, safeLabel)
  return Object.freeze({
    directory,
    temporary: `${base}.tmp`,
    complete: `${base}.mp4`,
    error: `${base}.error`
  })
}

export function legacyCacheLabel(value: string): string {
  const lowered = value.trim().toLowerCase().replaceAll('\0', '').replace(/[\\/]/g, '_').slice(0, 120)
  const safe = lowered === '' || lowered === '.' || lowered === '..' ? 'original' : lowered
  return `${safe[0]?.toUpperCase() ?? 'O'}${safe.slice(1)}`
}

function xxhRound(accumulator: number, input: number): number {
  return Math.imul(rotateLeft((accumulator + Math.imul(input, XXH_PRIME_2)) >>> 0, 13), XXH_PRIME_1) >>> 0
}

function rotateLeft(value: number, count: number): number {
  return (value << count | value >>> (32 - count)) >>> 0
}
