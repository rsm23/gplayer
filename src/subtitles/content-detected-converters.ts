const SCC_FPS = 29.97

export type ContentDetectedCue = Readonly<{
  start: number
  end: number
  lines: readonly string[]
}>

export function contentDetectedSubtitleCues(content: string): readonly ContentDetectedCue[] | null {
  if (/<SAMI(?:\s|>)/i.test(content)) return samiCues(content)
  if (/Scenarist_SCC\s+V1\.0/i.test(content)) return sccCues(content)
  if (lrcContent(content)) return lrcCues(content)
  return csvCues(content)
}

function samiCues(content: string): readonly ContentDetectedCue[] {
  const markers = [...content.matchAll(/<SYNC\b([^>]*)>/gi)]
  const points: Array<{ start: number; lines: string[] }> = []
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]
    if (marker === undefined) continue
    const startValue = marker[1]?.match(/\bStart\s*=\s*["']?(-?\d+)/i)?.[1]
    const start = Math.max(0, Number(startValue) / 1_000)
    if (!Number.isFinite(start)) continue
    const from = (marker.index ?? 0) + marker[0].length
    const to = markers[index + 1]?.index ?? content.length
    const block = content.slice(from, to).replace(/^\s*<P\b[^>]*>/i, '')
    points.push({ start, lines: htmlCaptionLines(block) })
  }
  const cues: ContentDetectedCue[] = []
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined || point.lines.length === 0) continue
    const nextStart = points[index + 1]?.start
    cues.push(cue(point.start, nextStart !== undefined && nextStart > point.start ? nextStart : point.start + 1, point.lines))
  }
  return cues
}

function htmlCaptionLines(value: string): string[] {
  const decoded = decodeHtmlEntities(value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;?/gi, ' ')).replace(/&nbsp;?/gi, ' ')
  return decoded.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function lrcContent(content: string): boolean {
  return /^\s*(?:\[[^\]]+\])*\[\s*\d{1,3}:\d{2}(?:[.:]\d{1,3})?\s*\]\s*.*\p{L}/mu.test(content)
}

function lrcCues(content: string): readonly ContentDetectedCue[] {
  const offsetMilliseconds = Number(content.match(/\[offset:\s*\+?(-?\d+)\s*\]/i)?.[1] ?? 0)
  const offset = Number.isFinite(offsetMilliseconds) ? offsetMilliseconds / 1_000 : 0
  const points: Array<{ start: number; lines: string[] }> = []
  for (const rawLine of content.split('\n')) {
    const timestamps = [...rawLine.matchAll(/\[\s*(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\s*\]/g)]
    if (timestamps.length === 0) continue
    const text = rawLine.replace(/\[\s*\d{1,3}:\d{2}(?:[.:]\d{1,3})?\s*\]/g, '').trim()
    if (text === '') continue
    for (const timestamp of timestamps) {
      const start = lrcTime(timestamp[1] ?? '') - offset
      if (Number.isFinite(start)) points.push({ start, lines: [text] })
    }
  }
  points.sort((left, right) => left.start - right.start)
  return points.map((point, index) => cue(point.start, points[index + 1]?.start ?? point.start + 1, point.lines))
}

function lrcTime(value: string): number {
  const match = value.match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/)
  if (match === null) return Number.NaN
  const fraction = match[3] ?? '0'
  return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${fraction}`)
}

function sccCues(content: string): readonly ContentDetectedCue[] {
  const parsed: Array<{ time: number; clearDisplayAt: number | null; lines: string[] }> = []
  for (const match of content.matchAll(/^(\d{2}:\d{2}:\d{2}[;:]\d{2})\s+([0-9A-Fa-f\s]+)$/gm)) {
    const codes = (match[2] ?? '').trim().split(/\s+/).filter((value) => /^[0-9A-Fa-f]{4}$/.test(value))
    const baseTime = sccTime(match[1] ?? '', 0)
    const clearIndex = codes.findIndex((value) => (Number.parseInt(value, 16) & 0x7f7f) === 0x142c)
    parsed.push({
      time: sccTime(match[1] ?? '', codes.length * 2),
      clearDisplayAt: clearIndex < 0 ? null : baseTime + clearIndex / SCC_FPS,
      lines: decodeSccLines(codes)
    })
  }

  const cues: Array<{ start: number; end: number; lines: string[] }> = []
  for (let index = 0; index < parsed.length; index += 1) {
    const row = parsed[index]
    if (row === undefined) continue
    const previous = cues.at(-1)
    if (previous !== undefined && row.clearDisplayAt !== null) previous.end = row.clearDisplayAt
    if (row.lines.length > 0) {
      if (previous !== undefined && !Number.isFinite(previous.end)) previous.end = row.time
      cues.push({ start: row.time, end: index === parsed.length - 1 ? row.time + 1 : Number.NaN, lines: row.lines })
    } else if (previous !== undefined) {
      previous.end = row.time
    }
  }
  return cues.map((item, index) => cue(item.start, Number.isFinite(item.end) ? item.end : cues[index + 1]?.start ?? item.start + 1, item.lines))
}

function sccTime(value: string, transmittedBytes: number): number {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})([;:])(\d{2})$/)
  if (match === null) return Number.NaN
  let time = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[5]) / SCC_FPS
  time += transmittedBytes / 2 / SCC_FPS
  return match[4] === ';' ? time : time * 3_603.6 / 3_600
}

function decodeSccLines(codes: readonly string[]): string[] {
  let output = ''
  let lastCode = -1
  for (const code of codes) {
    const raw = Number.parseInt(code, 16)
    if (!Number.isFinite(raw)) continue
    const first = raw >> 8 & 0x7f
    const second = raw & 0x7f
    const normalized = first << 8 | second
    if (normalized === lastCode && first >= 0x10 && first <= 0x1f) continue
    lastCode = normalized

    const special = sccSpecial(first, second)
    if (special !== null) { output += special; continue }
    const extended = sccExtended(first, second)
    if (extended !== null) { output = output.slice(0, -1) + extended; continue }
    if (sccPositioning(first, second)) {
      if (output !== '' && !output.endsWith('\n')) output += '\n'
      continue
    }
    if (first >= 0x10 && first <= 0x1f) continue
    output += sccBasic(first) + sccBasic(second)
  }
  return output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function sccBasic(value: number): string {
  const replacements: Readonly<Record<number, string>> = Object.freeze({
    0x2a: 'á', 0x5c: 'é', 0x5e: 'í', 0x5f: 'ó', 0x60: 'ú', 0x7b: 'ç',
    0x7c: '÷', 0x7d: 'Ñ', 0x7e: 'ñ', 0x7f: '■'
  })
  return replacements[value] ?? (value >= 0x20 && value <= 0x7f ? String.fromCharCode(value) : '')
}

function sccSpecial(first: number, second: number): string | null {
  if ((first !== 0x11 && first !== 0x19) || second < 0x30 || second > 0x3f) return null
  return ['®', '°', '½', '¿', '™', '¢', '£', '♪', 'à', ' ', 'è', 'â', 'ê', 'î', 'ô', 'û'][second - 0x30] ?? ''
}

function sccExtended(first: number, second: number): string | null {
  if (second < 0x20 || second > 0x3f) return null
  const spanishFrench = ['Á', 'É', 'Ó', 'Ú', 'Ü', 'ü', '‘', '¡', '*', "'", '—', '©', '℠', '•', '“', '”', 'À', 'Â', 'Ç', 'È', 'Ê', 'Ë', 'ë', 'Î', 'Ï', 'ï', 'Ô', 'Ù', 'ù', 'Û', '«', '»']
  const portugueseGerman = ['Ã', 'ã', 'Í', 'Ì', 'ì', 'Ò', 'ò', 'Õ', 'õ', '{', '}', '\\', '^', '_', '|', '~', 'Ä', 'ä', 'Ö', 'ö', 'ß', '¥', '¤', '│', 'Å', 'å', 'Ø', 'ø', '┌', '┐', '└', '┘']
  if (first === 0x12 || first === 0x1a) return spanishFrench[second - 0x20] ?? ''
  if (first === 0x13 || first === 0x1b) return portugueseGerman[second - 0x20] ?? ''
  return null
}

function sccPositioning(first: number, second: number): boolean {
  if (first < 0x10 || first > 0x1f) return false
  if (second >= 0x40 && second <= 0x7f) return true
  return (first === 0x17 || first === 0x1f) && second >= 0x21 && second <= 0x23
}

function csvCues(content: string): readonly ContentDetectedCue[] | null {
  for (const delimiter of [',', ';', '|', '\t']) {
    const rows = parseDelimitedRows(content, delimiter).filter((row) => row.some((cell) => cell.trim() !== ''))
    if (rows.length < 2) continue
    const width = rows[0]?.length ?? 0
    if (width < 2 || rows.some((row) => row.length !== width)) continue
    const dataRows = rows.filter((row) => flexibleTime(row[0] ?? '', 25) !== null)
    if (dataRows.length === 0) continue
    const maximumFrame = Math.max(0, ...dataRows.flatMap((row) => row.slice(0, 2).map(framePart)))
    const fps = maximumFrame >= 30 ? maximumFrame + 1 : maximumFrame >= 25 ? 30 : 25
    const cues: ContentDetectedCue[] = []
    for (const row of dataRows) {
      const start = flexibleTime(row[0] ?? '', fps)
      if (start === null) continue
      const candidateEnd = flexibleTime(row[1] ?? '', fps)
      const textIndex = candidateEnd === null ? 1 : 2
      const lines = (row[textIndex] ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
      if (lines.length === 0) continue
      cues.push(cue(start, candidateEnd ?? Number.NaN, lines))
    }
    if (cues.length > 0) {
      return cues.map((item, index) => cue(item.start, Number.isFinite(item.end) && item.end > item.start ? item.end : cues[index + 1]?.start ?? item.start + 1, item.lines))
    }
  }
  return null
}

function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? ''
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') { field += '"'; index += 1 }
      else if (character === '"') quoted = false
      else field += character
      continue
    }
    if (character === '"' && field === '') { quoted = true; continue }
    if (character === delimiter) { row.push(field); field = ''; continue }
    if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += character
  }
  row.push(field)
  rows.push(row)
  return rows
}

function flexibleTime(value: string, fps: number): number | null {
  const normalized = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized)
  const frame = normalized.match(/^(\d{1,3}):(\d{2}):(\d{1,2}):(\d{1,3})$/)
  if (frame !== null) return Number(frame[1]) * 3_600 + Number(frame[2]) * 60 + Number(frame[3]) + Number(frame[4]) / fps
  const clock = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (clock === null) return null
  return Number(clock[1] ?? 0) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]) + Number(`0.${clock[4] ?? 0}`)
}

function framePart(value: string): number {
  return Number(value.trim().match(/^\d{1,3}:\d{2}:\d{1,2}:(\d{1,3})$/)?.[1] ?? 0)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
}

function safeCodePoint(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

function cue(start: number, end: number, lines: readonly string[]): ContentDetectedCue {
  return Object.freeze({ start, end, lines: Object.freeze([...lines]) })
}
