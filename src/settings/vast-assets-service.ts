import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_URL_LENGTH = 4_096
const MAX_TITLE_LENGTH = 500
const MAX_DURATION_SECONDS = 359_999
const VAST_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xml$/i

export type VastAsset = Readonly<{
  name: string
  url: string
}>

export type VastAssetInput = Readonly<{
  adTitle?: unknown
  adClickThrough?: unknown
  adMediaFile?: unknown
  adDuration?: unknown
  adSkipOffset?: unknown
  adFilename?: unknown
}>

export interface VastAssetManager {
  list(): Promise<readonly VastAsset[]>
  create(input: VastAssetInput, siteName: string): Promise<VastAsset>
  delete(name: string): Promise<boolean>
}

export class InvalidVastAssetError extends Error {}

export class FileSystemVastAssetManager implements VastAssetManager {
  private readonly uploadRoot: string

  public constructor(uploadRoot: string, private readonly baseUrl: URL) {
    this.uploadRoot = path.resolve(uploadRoot)
  }

  public async list(): Promise<readonly VastAsset[]> {
    let entries
    try {
      entries = await readdir(this.uploadRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFile(error)) return Object.freeze([])
      throw error
    }

    return Object.freeze(entries
      .filter((entry) => entry.isFile() && isSafeVastAssetName(entry.name))
      .map((entry) => this.asset(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name)))
  }

  public async create(input: VastAssetInput, siteName: string): Promise<VastAsset> {
    const normalized = normalizeVastInput(input)
    const safeSiteName = boundedText(siteName, 100) || 'GPlayer'
    const xml = vastXml({ ...normalized, siteName: safeSiteName })
    const target = this.target(normalized.filename)

    await mkdir(this.uploadRoot, { recursive: true })
    const temporary = path.join(this.uploadRoot, `.${normalized.filename}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, xml, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
    return this.asset(normalized.filename)
  }

  public async delete(name: string): Promise<boolean> {
    if (!isSafeVastAssetName(name)) throw new InvalidVastAssetError('The VAST filename is invalid')
    const target = this.target(name)
    try {
      const stats = await lstat(target)
      if (!stats.isFile() || stats.isSymbolicLink()) return false
      await unlink(target)
      return true
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }
  }

  private asset(name: string): VastAsset {
    return Object.freeze({
      name,
      url: new URL(`uploads/${encodeURIComponent(name)}`, ensureTrailingSlash(this.baseUrl)).toString()
    })
  }

  private target(name: string): string {
    if (!isSafeVastAssetName(name)) throw new InvalidVastAssetError('The VAST filename must end in .xml and contain only letters, numbers, dots, dashes, or underscores')
    const target = path.resolve(this.uploadRoot, name)
    if (path.dirname(target) !== this.uploadRoot) throw new InvalidVastAssetError('The VAST filename is invalid')
    return target
  }
}

export function isSafeVastAssetName(value: string): boolean {
  return VAST_FILENAME.test(value) && path.basename(value) === value
}

function normalizeVastInput(input: VastAssetInput): Readonly<{
  title: string
  clickThrough: string
  mediaFile: string
  duration: string
  skipOffset: string
  filename: string
}> {
  const title = boundedText(input.adTitle, MAX_TITLE_LENGTH)
  if (title === null) throw new InvalidVastAssetError(`The ad title must not exceed ${MAX_TITLE_LENGTH} characters`)

  const clickThrough = httpUrl(input.adClickThrough)
  if (clickThrough === null) throw new InvalidVastAssetError('The click-through URL must be a valid HTTP(S) URL without embedded credentials')

  const mediaFile = httpUrl(input.adMediaFile)
  if (mediaFile === null) throw new InvalidVastAssetError('The media file must be a valid HTTP(S) URL without embedded credentials')

  const durationSeconds = boundedSeconds(input.adDuration, false)
  if (durationSeconds === null) throw new InvalidVastAssetError('The ad duration must be a whole number of seconds between 0 and 359999')
  const skipSeconds = boundedSeconds(input.adSkipOffset, true)
  if (skipSeconds === null) throw new InvalidVastAssetError('The skip offset must be blank or a whole number of seconds between 0 and 359999')

  const filename = normalizedFilename(input.adFilename)
  if (filename === null) throw new InvalidVastAssetError('The VAST filename must contain only letters, numbers, dots, dashes, or underscores')

  return Object.freeze({
    title: title ?? '',
    clickThrough,
    mediaFile,
    duration: formatDuration(durationSeconds),
    skipOffset: `skipoffset="${formatDuration(skipSeconds ?? 0)}"`,
    filename
  })
}

function vastXml(input: Readonly<{
  siteName: string
  title: string
  clickThrough: string
  mediaFile: string
  duration: string
  skipOffset: string
}>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="vast.xsd" version="3.0">
    <Ad id="1">
        <InLine>
            <AdSystem>${escapeXml(input.siteName)}</AdSystem>
            <AdTitle>${escapeXml(input.title)}</AdTitle>
            <Creatives>
                <Creative id="2" sequence="1">
                    <Linear ${input.skipOffset}>
                        <Duration>${input.duration}</Duration>
                        <VideoClicks>
                            <ClickThrough id="blog"><![CDATA[${cdata(input.clickThrough)}]]></ClickThrough>
                            <CustomClick>${escapeXml(input.clickThrough)}</CustomClick>
                        </VideoClicks>
                        <MediaFiles>
                            <MediaFile id="3" delivery="progressive" type="video/mp4" scalable="1" maintainAspectRatio="1" codec="0" apiFramework="VAST"><![CDATA[${cdata(input.mediaFile)}]]></MediaFile>
                        </MediaFiles>
                    </Linear>
                </Creative>
            </Creatives>
        </InLine>
    </Ad>
</VAST>
`
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value.at(-1))
  return typeof value === 'string' ? value.trim() : ''
}

function boundedText(value: unknown, maximum: number): string | null {
  const result = scalar(value)
  return result.length <= maximum ? result : null
}

function normalizedFilename(value: unknown): string | null {
  const raw = scalar(value)
  if (raw === '' || raw.length > 132 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) return null
  const stem = path.parse(raw).name
  const filename = `${stem}.xml`
  return isSafeVastAssetName(filename) ? filename : null
}

function httpUrl(value: unknown): string | null {
  const raw = scalar(value)
  if (raw === '' || raw.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null
    return url.toString()
  } catch {
    return null
  }
}

function boundedSeconds(value: unknown, optional: false): number | null
function boundedSeconds(value: unknown, optional: true): number | undefined | null
function boundedSeconds(value: unknown, optional: boolean): number | undefined | null {
  const raw = scalar(value)
  if (optional && raw === '') return undefined
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return null
  const result = Number(raw)
  return Number.isSafeInteger(result) && result <= MAX_DURATION_SECONDS ? result : null
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function cdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>')
}

function ensureTrailingSlash(value: URL): URL {
  const result = new URL(value)
  if (!result.pathname.endsWith('/')) result.pathname = `${result.pathname}/`
  return result
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
