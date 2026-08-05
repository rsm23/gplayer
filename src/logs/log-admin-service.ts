import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

const DEFAULT_CHUNK_LINES = 250
const MAX_CHUNK_LINES = 1_000
const MAX_START_LINE = 1_000_000

export type LogFileRecord = Readonly<{
  name: string
  size: number
  sizeKb: number
  modified: number
}>

export type LogReadResult = Readonly<{
  name: string
  start: number
  nextStart: number | null
  lines: readonly string[]
}>

export type LogDownload = Readonly<{
  name: string
  size: number
  stream: Readable
}>

export class LogFileError extends Error {
  public constructor(
    public readonly code: 'invalid' | 'not-found' | 'not-file',
    message: string
  ) {
    super(message)
    this.name = 'LogFileError'
  }
}

export class LogAdminService {
  private readonly root: string

  public constructor(root: string) {
    this.root = path.resolve(root)
  }

  public async list(): Promise<readonly LogFileRecord[]> {
    await this.ensureRoot()
    const entries = await readdir(this.root, { withFileTypes: true })
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && validName(entry.name))
      .map(async (entry): Promise<LogFileRecord | null> => {
        const target = this.target(entry.name)
        const details = await lstat(target).catch(() => null)
        if (details === null || !details.isFile() || details.isSymbolicLink()) return null
        return Object.freeze({
          name: entry.name,
          size: details.size,
          sizeKb: Math.trunc(details.size / 1_024),
          modified: Math.trunc(details.mtimeMs / 1_000)
        })
      }))
    return Object.freeze(records
      .filter((record): record is LogFileRecord => record !== null)
      .sort((left, right) => left.name.localeCompare(right.name, 'en')))
  }

  public async read(name: unknown, start: unknown = 1, limit: unknown = DEFAULT_CHUNK_LINES): Promise<LogReadResult> {
    const normalizedName = logFileName(name)
    const startLine = boundedInteger(start, 1, 1, MAX_START_LINE)
    const maximum = boundedInteger(limit, DEFAULT_CHUNK_LINES, 1, MAX_CHUNK_LINES)
    const handle = await this.openFile(normalizedName, constants.O_RDONLY)
    const stream = handle.createReadStream({ autoClose: false, encoding: 'utf8' })
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    const lines: string[] = []
    let current = 0
    let hasMore = false
    try {
      for await (const line of reader) {
        current += 1
        if (current < startLine) continue
        if (lines.length >= maximum) {
          hasMore = true
          break
        }
        lines.push(line)
      }
    } finally {
      reader.close()
      stream.destroy()
      await handle.close().catch(() => undefined)
    }
    return Object.freeze({
      name: normalizedName,
      start: startLine,
      nextStart: hasMore ? startLine + lines.length : null,
      lines: Object.freeze(lines)
    })
  }

  public async download(name: unknown): Promise<LogDownload> {
    const normalizedName = logFileName(name)
    const handle = await this.openFile(normalizedName, constants.O_RDONLY)
    try {
      const details = await handle.stat()
      if (!details.isFile()) throw new LogFileError('not-file', 'The selected log is not a regular file')
      const stream = handle.createReadStream({ autoClose: true })
      return Object.freeze({ name: normalizedName, size: details.size, stream })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  public async clear(name: unknown): Promise<void> {
    const normalizedName = logFileName(name)
    const handle = await this.openFile(normalizedName, constants.O_WRONLY | constants.O_TRUNC)
    await handle.close()
  }

  public async delete(name: unknown): Promise<void> {
    const normalizedName = logFileName(name)
    const target = this.target(normalizedName)
    const details = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new LogFileError('not-found', 'The selected log was not found')
      throw error
    })
    if (!details.isFile() || details.isSymbolicLink()) throw new LogFileError('not-file', 'The selected log is not a regular file')
    await unlink(target)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o750 })
    const details = await lstat(this.root)
    if (!details.isDirectory() || details.isSymbolicLink()) throw new LogFileError('not-file', 'The log directory is not a regular directory')
  }

  private target(name: string): string {
    const target = path.resolve(this.root, name)
    if (path.dirname(target) !== this.root) throw new LogFileError('invalid', 'The log filename is invalid')
    return target
  }

  private async openFile(name: string, flags: number) {
    await this.ensureRoot()
    const target = this.target(name)
    try {
      return await open(target, flags | constants.O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new LogFileError('not-found', 'The selected log was not found')
      if (code === 'ELOOP') throw new LogFileError('not-file', 'The selected log is not a regular file')
      throw error
    }
  }
}

export function logFileName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!validName(name)) throw new LogFileError('invalid', 'The log filename is invalid')
  return name
}

function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && name.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(name)
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(typeof value === 'string' ? value : '', 10)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}
