import { link, lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const SUBTITLE_MAX_BYTES = 2_097_152
export const SUBTITLE_EXTENSIONS = Object.freeze(['srt', 'vtt', 'ass', 'sub', 'stl', 'dfxp', 'ttml', 'sbv', 'txt'] as const)

const ALLOWED_EXTENSIONS = new Set<string>(SUBTITLE_EXTENSIONS)
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ass: 'text/x-ssa',
  dfxp: 'application/ttml+xml',
  sbv: 'text/plain',
  srt: 'application/x-subrip',
  stl: 'application/octet-stream',
  sub: 'application/octet-stream',
  ttml: 'application/ttml+xml',
  txt: 'text/plain',
  vtt: 'text/vtt'
})

export type SubtitleAsset = Readonly<{
  name: string
  size: number
  mimeType: string
  url: string
}>

export interface SubtitleAssetManager {
  create(originalName: string, content: Buffer): Promise<SubtitleAsset>
  rename(currentName: string, requestedName: string): Promise<string>
  delete(name: string): Promise<boolean>
}

export class InvalidSubtitleAssetError extends Error {}

export type FileSystemSubtitleAssetManagerOptions = Readonly<{
  randomSuffix?: () => string
}>

export class FileSystemSubtitleAssetManager implements SubtitleAssetManager {
  private readonly root: string
  private readonly randomSuffix: () => string

  public constructor(
    root: string,
    private readonly baseUrl: URL,
    options: FileSystemSubtitleAssetManagerOptions = {}
  ) {
    this.root = path.resolve(root)
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(8).toString('hex'))
  }

  public async create(originalName: string, content: Buffer): Promise<SubtitleAsset> {
    if (content.length === 0) throw new InvalidSubtitleAssetError('The subtitle file is empty')
    if (content.length > SUBTITLE_MAX_BYTES) throw new InvalidSubtitleAssetError('The subtitle file exceeds the 2 MiB limit')
    if (containsPhp(content)) throw new InvalidSubtitleAssetError('Executable PHP content is not accepted')

    const extension = subtitleExtension(originalName)
    if (extension === null) throw new InvalidSubtitleAssetError('The subtitle file extension is not supported')
    const stem = safeGeneratedStem(originalName, extension)
    const name = `${stem}-${this.randomSuffix()}.${extension}`
    if (!validSubtitleName(name)) throw new InvalidSubtitleAssetError('The generated subtitle filename is invalid')

    await mkdir(this.root, { recursive: true, mode: 0o750 })
    const destination = this.filePath(name)
    const temporary = this.filePath(`.${name}.${this.randomSuffix()}.tmp`)
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o640 })
      await link(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (isAlreadyExists(error)) throw new InvalidSubtitleAssetError('The filename is already in use')
      throw error
    }
    await unlink(temporary)

    return Object.freeze({
      name,
      size: content.length,
      mimeType: MIME_TYPES[extension] ?? 'text/plain',
      url: this.publicUrl(name)
    })
  }

  public async rename(currentName: string, requestedName: string): Promise<string> {
    if (!validSubtitleName(currentName) || !validSubtitleName(requestedName)) {
      throw new InvalidSubtitleAssetError('The subtitle filename is invalid')
    }
    if (currentName === requestedName) return requestedName

    const source = this.filePath(currentName)
    const destination = this.filePath(requestedName)
    const sourceStatus = await lstat(source).catch(() => null)
    if (sourceStatus === null || !sourceStatus.isFile() || sourceStatus.isSymbolicLink()) {
      throw new InvalidSubtitleAssetError('The subtitle file was not found')
    }
    try {
      await link(source, destination)
    } catch (error) {
      if (isAlreadyExists(error)) throw new InvalidSubtitleAssetError('The filename is already in use')
      throw error
    }
    try {
      await unlink(source)
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
    return requestedName
  }

  public async delete(name: string): Promise<boolean> {
    if (!validSubtitleName(name)) return false
    const target = this.filePath(name)
    const status = await lstat(target).catch(() => null)
    if (status === null || !status.isFile() || status.isSymbolicLink()) return false
    await unlink(target)
    return true
  }

  private filePath(name: string): string {
    const target = path.resolve(this.root, name)
    if (path.dirname(target) !== this.root) throw new InvalidSubtitleAssetError('The subtitle filename is invalid')
    return target
  }

  private publicUrl(name: string): string {
    return new URL(`uploads/subtitles/${encodeURIComponent(name)}`, ensureTrailingSlash(this.baseUrl)).href
  }
}

export function validSubtitleName(value: string): boolean {
  if (value === '' || value.length > 255 || Buffer.byteLength(value, 'utf8') > 255) return false
  if (value !== path.basename(value) || value.startsWith('.') || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(value)) return false
  if (/[. ]$/u.test(value)) return false
  return subtitleExtension(value) !== null
}

export function subtitleExtension(value: string): string | null {
  const index = value.lastIndexOf('.')
  if (index <= 0 || index === value.length - 1) return null
  const extension = value.slice(index + 1).toLowerCase()
  return ALLOWED_EXTENSIONS.has(extension) ? extension : null
}

function safeGeneratedStem(originalName: string, extension: string): string {
  const withoutExtension = originalName.slice(0, -(extension.length + 1)).normalize('NFKD')
  const safe = withoutExtension
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-zA-Z0-9._ -]+/gu, '-')
    .replace(/[ ._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 200)
  return safe || 'subtitle'
}

function containsPhp(content: Buffer): boolean {
  return /<\?(?:php|=)?/iu.test(content.toString('latin1'))
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url.href)
  if (!result.pathname.endsWith('/')) result.pathname += '/'
  result.search = ''
  result.hash = ''
  return result
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
