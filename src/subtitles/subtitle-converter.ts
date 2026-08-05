import { contentDetectedSubtitleCues } from './content-detected-converters.js'

const MICRODVD_FPS = 23.976
const EBU_STL_HEADER_BYTES = 1_024
const EBU_STL_BLOCK_BYTES = 128
const MAX_SUBTITLE_LINES = 100_000
const MAX_SUBTITLE_CUES = 100_000

type Cue = Readonly<{
  start: number
  end: number
  lines: readonly string[]
  identifier?: string
}>

export function convertSubtitleToWebVtt(input: Uint8Array | string, sourceUrl: URL): string {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const ebu = ebuStlCues(bytes)
  if (ebu !== null) return renderWebVtt(ebu)

  let content = boundedLines(decodeText(bytes))
    .replace(/^\uFEFF/, '')
    .replace(/\\x[0-9A-Fa-f]{2}/g, '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (/^WEBVTT(?:\s|$)/i.test(content)) return normalizeExistingWebVtt(content)

  const extension = sourceUrl.pathname.split('.').at(-1)?.toLowerCase() ?? ''
  let cues: readonly Cue[]
  if (sourceUrl.hostname.toLowerCase().includes('youtube.com') && extension !== 'vtt') {
    cues = youtubeTimedTextCues(content)
  } else if (extension === 'ass' || /\[Script Info\]|\[Events\]/i.test(content)) {
    cues = assCues(content)
  } else if (extension === 'dfxp' || extension === 'ttml' || /<(?:tt|DCSubtitle|Subtitle)(?:\s|>)/i.test(content)) {
    cues = timedTextMarkupCues(content)
  } else if (microDvdContent(content)) {
    cues = microDvdCues(content)
  } else if (spruceStlContent(content)) {
    cues = spruceStlCues(content)
  } else if (/\{QTtext\}/i.test(content)) {
    cues = quickTimeTextCues(content)
  } else if (subViewerContent(content) || sbvContent(content)) {
    cues = commaTimestampCues(content)
  } else {
    cues = contentDetectedSubtitleCues(content) ?? genericTextCues(content)
  }
  return renderWebVtt(cues)
}

function renderWebVtt(cues: readonly Cue[]): string {
  const valid = cues.slice(0, MAX_SUBTITLE_CUES)
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start)
    .map((cue) => Object.freeze({
      ...cue,
      lines: Object.freeze(cue.lines.map(cleanCaptionLine).filter((line) => line !== ''))
    }))
    .filter((cue) => cue.lines.length > 0)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const body = valid.map((cue) => `${cue.identifier === undefined ? '' : `${cleanCaptionLine(cue.identifier)}\n`}${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.lines.join('\n')}`).join('\n\n')
  return `WEBVTT\n\n${body}`
}

function normalizeExistingWebVtt(content: string): string {
  return content.replace(/^webvtt/i, 'WEBVTT').replace(/\{.*?\}/g, '').trim()
}

function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1] ?? 0
      swapped[index - 1] = bytes[index] ?? 0
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return decodeWindows1252(bytes)
  }
}

function decodeWindows1252(bytes: Buffer): string {
  const replacements: Readonly<Record<number, string>> = Object.freeze({
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
    0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
    0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
    0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
  })
  let output = ''
  for (const value of bytes) output += replacements[value] ?? String.fromCharCode(value)
  return output
}

function boundedLines(value: string): string {
  let lines = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue
    lines += 1
    if (lines >= MAX_SUBTITLE_LINES) return value.slice(0, index)
  }
  return value
}

function youtubeTimedTextCues(content: string): readonly Cue[] {
  const cues: Cue[] = []
  for (const match of content.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1] ?? ''
    const start = Number(attribute(attributes, 'start') ?? Number.NaN)
    const duration = Number(attribute(attributes, 'dur') ?? Number.NaN)
    const text = xmlText(match[2] ?? '')
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0 && text.length > 0) {
      cues.push(cue(start, start + duration, text.split('\n')))
    }
  }
  return cues
}

function assCues(content: string): readonly Cue[] {
  const events = content.match(/\[Events\]([\s\S]*)/i)?.[1] ?? content
  const format = events.match(/^\s*Format\s*:\s*(.+)$/im)?.[1]
    ?.split(',').map((field) => field.trim().toLowerCase()) ?? []
  const startIndex = format.indexOf('start')
  const endIndex = format.indexOf('end')
  const textIndex = format.indexOf('text')
  const expectedFields = Math.max(format.length, 10)
  const cues: Cue[] = []
  for (const line of events.split('\n')) {
    if (!/^\s*Dialogue\s*:/i.test(line)) continue
    const values = line.slice(line.indexOf(':') + 1).split(',')
    const resolvedStart = startIndex >= 0 ? startIndex : 1
    const resolvedEnd = endIndex >= 0 ? endIndex : 2
    const resolvedText = textIndex >= 0 ? textIndex : expectedFields - 1
    if (values.length <= Math.max(resolvedStart, resolvedEnd, resolvedText)) continue
    const start = parseClock(values[resolvedStart] ?? '')
    const end = parseClock(values[resolvedEnd] ?? '')
    const text = values.slice(resolvedText).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push(cue(start, end, text.split('\n')))
  }
  return cues
}

function timedTextMarkupCues(content: string): readonly Cue[] {
  if (/<DCSubtitle(?:\s|>)/i.test(content)) return dcSubtitleCues(content)
  if (/<Subtitle(?:\s|>)/i.test(content) && /<StartMilliseconds>/i.test(content)) return paragraphXmlCues(content)

  const frameRate = positiveNumber(content.match(/\b(?:ttp:)?frameRate=["']([^"']+)["']/i)?.[1]) || 30
  const multiplier = content.match(/\b(?:ttp:)?frameRateMultiplier=["'](\d+)\s+(\d+)["']/i)
  const effectiveFps = multiplier === null ? frameRate : frameRate * Number(multiplier[1]) / Number(multiplier[2])
  const subFrameRate = positiveNumber(content.match(/\b(?:ttp:)?subFrameRate=["']([^"']+)["']/i)?.[1]) || 1
  const tickRate = positiveNumber(content.match(/\b(?:ttp:)?tickRate=["']([^"']+)["']/i)?.[1]) || effectiveFps * subFrameRate
  const cues: Cue[] = []
  for (const match of content.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attributes = match[1] ?? ''
    const start = parseTimedTextTime(attribute(attributes, 'begin') ?? '', effectiveFps, tickRate)
    const explicitEnd = parseTimedTextTime(attribute(attributes, 'end') ?? '', effectiveFps, tickRate)
    const duration = parseTimedTextTime(attribute(attributes, 'dur') ?? '', effectiveFps, tickRate)
    const end = Number.isFinite(explicitEnd) ? explicitEnd : start + duration
    const text = xmlText(match[2] ?? '')
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push(cue(start, end, text.split('\n')))
  }
  return fillCueEnds(cues)
}

function dcSubtitleCues(content: string): readonly Cue[] {
  const cues: Cue[] = []
  for (const match of content.matchAll(/<Subtitle\b([^>]*)>([\s\S]*?)<\/Subtitle>/gi)) {
    const attributes = match[1] ?? ''
    const start = parseClock(attribute(attributes, 'TimeIn') ?? '')
    const end = parseClock(attribute(attributes, 'TimeOut') ?? '')
    const text = xmlText(match[2] ?? '')
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push(cue(start, end, text.split('\n')))
  }
  return cues
}

function paragraphXmlCues(content: string): readonly Cue[] {
  const cues: Cue[] = []
  for (const match of content.matchAll(/<Paragraph\b[^>]*>([\s\S]*?)<\/Paragraph>/gi)) {
    const block = match[1] ?? ''
    const start = Number(block.match(/<StartMilliseconds>\s*(\d+)\s*<\/StartMilliseconds>/i)?.[1] ?? Number.NaN) / 1_000
    const end = Number(block.match(/<EndMilliseconds>\s*(\d+)\s*<\/EndMilliseconds>/i)?.[1] ?? Number.NaN) / 1_000
    const text = xmlText(block.match(/<Text\b[^>]*>([\s\S]*?)<\/Text>/i)?.[1] ?? '')
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push(cue(start, end, text.split('\n')))
  }
  return cues
}

function microDvdContent(content: string): boolean {
  return /^\s*\{\d+\}\{\d+\}/m.test(content)
}

function microDvdCues(content: string): readonly Cue[] {
  const cues: Cue[] = []
  for (const match of content.matchAll(/^\s*\{(\d+)\}\{(\d+)\}(?:\{[^}]*\})?(.*)$/gm)) {
    cues.push(cue(Number(match[1]) / MICRODVD_FPS, Number(match[2]) / MICRODVD_FPS, (match[3] ?? '').split('|')))
  }
  return cues
}

function spruceStlContent(content: string): boolean {
  return /^\s*\d{2}:\d{2}:\d{2}:\d{2}\s*,\s*\d{2}:\d{2}:\d{2}:\d{2}\s*,/m.test(content)
}

function spruceStlCues(content: string): readonly Cue[] {
  const lines = content.split('\n')
  const frameValues = [...content.matchAll(/\d{2}:\d{2}:\d{2}:(\d{2})/g)].map((match) => Number(match[1]))
  const maximumFrame = Math.max(0, ...frameValues)
  const fps = maximumFrame >= 30 ? maximumFrame + 1 : maximumFrame >= 25 ? 30 : 25
  const cues: Cue[] = []
  for (const line of lines) {
    const match = line.match(/^\s*(\d{2}:\d{2}:\d{2}:\d{2})\s*,\s*(\d{2}:\d{2}:\d{2}:\d{2})\s*,\s*(.*)$/)
    if (match == null) continue
    const start = parseFrameClock(match[1] ?? '', fps)
    const end = parseFrameClock(match[2] ?? '', fps)
    cues.push(cue(start, end, (match[3] ?? '').split('|')))
  }
  return cues
}

function subViewerContent(content: string): boolean {
  return /^\s*\d{2}:\d{2}:\d{2}\.\d{2}\s*,\s*\d{2}:\d{2}:\d{2}\.\d{2}\s*$/m.test(content)
}

function sbvContent(content: string): boolean {
  return /^\s*\d{1,2}:\d{2}:\d{2}\.\d{3}\s*,\s*\d{1,2}:\d{2}:\d{2}\.\d{3}\s*$/m.test(content)
}

function commaTimestampCues(content: string): readonly Cue[] {
  const normalized = content.replace(/^\s*\[[^\n]*\]\s*$/gm, '').replace(/\[br\]/gi, '\n')
  const cues: Cue[] = []
  const lines = normalized.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.trim().match(/^(\d{1,2}:\d{2}:\d{2}[.,]\d{2,3})\s*,\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{2,3})$/)
    if (match == null) continue
    const text: string[] = []
    while (index + 1 < lines.length && !/^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{2,3}\s*,/.test(lines[index + 1] ?? '')) {
      index += 1
      const line = lines[index]?.trim() ?? ''
      if (line !== '') text.push(line)
    }
    cues.push(cue(parseClock(match[1] ?? ''), parseClock(match[2] ?? ''), text))
  }
  return cues
}

function quickTimeTextCues(content: string): readonly Cue[] {
  const timeScale = positiveNumber(content.match(/\{timeScale:(\d+)\}/i)?.[1]) || 30
  const entries = [...content.matchAll(/^\s*\[(\d{1,2}:\d{2}:\d{2}\.\d{1,3})\]\s*$/gm)]
  const cues: Cue[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]
    const next = entries[index + 1]
    if (current === undefined) continue
    const start = parseFrameClock(current[1] ?? '', timeScale)
    const end = next === undefined ? start + 1 : parseFrameClock(next[1] ?? '', timeScale)
    const from = (current.index ?? 0) + current[0].length
    const to = next?.index ?? content.length
    const lines = content.slice(from, to).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^\{.*\}$/.test(line))
    if (lines.length > 0) cues.push(cue(start, end, lines))
  }
  return cues
}

function genericTextCues(content: string): readonly Cue[] {
  const arrow = arrowTimestampCues(content)
  if (arrow.length > 0) return arrow

  const timestamped = timestampedTextCues(content)
  if (timestamped.length > 0) return timestamped

  const paragraphs = content.split(/\n\s*\n+/).map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean)).filter((lines) => lines.length > 0)
  const groups = paragraphs.length > 1 ? paragraphs : content.split('\n').map((line) => [line.trim()]).filter((lines) => lines[0] !== '')
  return groups.map((lines, index) => cue(index, index + 1, lines))
}

function arrowTimestampCues(content: string): readonly Cue[] {
  const cues: Cue[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/([^\s]+)\s*-->\s*([^\s]+)/)
    if (match == null) continue
    const start = parseClock(match[1] ?? '')
    const end = parseClock(match[2] ?? '')
    const identifier = /^\d+$/.test(lines[index - 1]?.trim() ?? '') ? lines[index - 1]?.trim() : undefined
    const text: string[] = []
    while (index + 1 < lines.length && !/[^\s]+\s*-->\s*[^\s]+/.test(lines[index + 1] ?? '')) {
      index += 1
      const line = lines[index]?.trim() ?? ''
      if (line !== '' && !/^\d+$/.test(line)) text.push(line)
    }
    cues.push(cue(start, Number.isFinite(end) ? end : start + 1, text, identifier))
  }
  return cues
}

function timestampedTextCues(content: string): readonly Cue[] {
  const points: Array<{ start: number; end: number; lines: string[] }> = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line === '' || /^\d+$/.test(line)) continue
    const match = line.match(/^(\d{1,2}:\d{2}(?::\d{1,2})?(?:[.,:]\d{1,3})?)(?:\s*(?:-->|-|,)\s*(\d{1,2}:\d{2}(?::\d{1,2})?(?:[.,:]\d{1,3})?))?\s*(.*)$/)
    if (match !== null) {
      const start = parseClock(match[1] ?? '')
      const explicitEnd = parseClock(match[2] ?? '')
      points.push({ start, end: explicitEnd, lines: (match[3] ?? '').trim() === '' ? [] : [(match[3] ?? '').trim()] })
    } else if (points.length > 0) {
      points.at(-1)?.lines.push(line)
    }
  }
  return points.map((point, index) => cue(point.start, Number.isFinite(point.end) ? point.end : points[index + 1]?.start ?? point.start + 1, point.lines))
}

function fillCueEnds(input: readonly Cue[]): readonly Cue[] {
  return input.map((item, index) => Number.isFinite(item.end) && item.end > item.start
    ? item
    : cue(item.start, input[index + 1]?.start ?? item.start + 1, item.lines))
}

function ebuStlCues(bytes: Buffer): readonly Cue[] | null {
  if (bytes.length < EBU_STL_HEADER_BYTES || bytes.subarray(3, 6).toString('ascii') !== 'STL') return null
  const fps = Number(bytes.subarray(6, 8).toString('ascii'))
  if (![23, 24, 25, 29, 30].includes(fps)) return []
  const cues: Cue[] = []
  for (let offset = EBU_STL_HEADER_BYTES; offset + EBU_STL_BLOCK_BYTES <= bytes.length; offset += EBU_STL_BLOCK_BYTES) {
    const block = bytes.subarray(offset, offset + EBU_STL_BLOCK_BYTES)
    if (block[3] !== 0xff) continue
    const start = ebuTimestamp(block.subarray(5, 9), fps)
    const end = ebuTimestamp(block.subarray(9, 13), fps)
    const lines = decodeIso6937(block.subarray(16, 128)).split('\n')
    cues.push(cue(start, end, lines))
  }
  return cues
}

function ebuTimestamp(bytes: Buffer, fps: number): number {
  return (bytes[0] ?? 0) * 3_600 + (bytes[1] ?? 0) * 60 + (bytes[2] ?? 0) + (bytes[3] ?? 0) / fps
}

function decodeIso6937(bytes: Buffer): string {
  const single: Readonly<Record<number, string>> = Object.freeze({
    0xa0: ' ', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '$', 0xa5: '¥', 0xa6: '#', 0xa7: '§', 0xa8: '¤', 0xa9: '‘', 0xaa: '“', 0xab: '«', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓',
    0xb0: '°', 0xb1: '±', 0xb2: '²', 0xb3: '³', 0xb4: '×', 0xb5: 'µ', 0xb6: '¶', 0xb7: '·', 0xb8: '÷', 0xb9: '’', 0xba: '”', 0xbb: '»', 0xbc: '¼', 0xbd: '½', 0xbe: '¾', 0xbf: '¿',
    0xd0: '―', 0xd1: '¹', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '♪', 0xd7: '‰', 0xd8: 'α', 0xdc: '⅛', 0xdd: '⅜', 0xde: '⅝', 0xdf: '⅞',
    0xe0: 'Ω', 0xe1: 'Æ', 0xe2: 'Đ', 0xe3: 'ª', 0xe4: 'Ħ', 0xe6: 'Ĳ', 0xe7: 'Ŀ', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xec: 'Þ', 0xed: 'Ŧ', 0xee: 'Ŋ', 0xef: 'ŉ',
    0xf0: 'ĸ', 0xf1: 'æ', 0xf2: 'đ', 0xf3: 'ð', 0xf4: 'ħ', 0xf5: 'ı', 0xf6: 'ĳ', 0xf7: 'ŀ', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß', 0xfc: 'þ', 0xfd: 'ŧ', 0xfe: 'ŋ', 0xff: '■'
  })
  const accents: Readonly<Record<number, Readonly<Record<string, string>>>> = Object.freeze({
    0xc1: accentMap('AEIOUaeiou', 'ÀÈÌÒÙàèìòù'),
    0xc2: accentMap('ACEILNORSUYZacegilnorsuyz', 'ÁĆÉÍĹŃÓŔŚÚÝŹáćéģíĺńóŕśúýź'),
    0xc3: accentMap('ACEGHIJOSUWYaceghijosuwy', 'ÂĈÊĜĤÎĴÔŜÛŴŶâĉêĝĥîĵôŝûŵŷ'),
    0xc4: accentMap('AINOUainou', 'ÃĨÑÕŨãĩñõũ'),
    0xc5: accentMap('AEIOUaeiou', 'ĀĒĪŌŪāēīōū'),
    0xc6: accentMap('AGUagu', 'ĂĞŬăğŭ'),
    0xc7: accentMap('CEGIZcegz', 'ĊĖĠİŻċėġż'),
    0xc8: accentMap('AEIOUYaeiouy', 'ÄËÏÖÜŸäëïöüÿ'),
    0xca: accentMap('AUau', 'ÅŮåů'),
    0xcb: accentMap('CGKLNRSTcklnrst', 'ÇĢĶĻŅŖŞŢçķļņŗşţ'),
    0xcd: accentMap('OUou', 'ŐŰőű'),
    0xce: accentMap('AEIUaeiu', 'ĄĘĮŲąęįų'),
    0xcf: accentMap('CDELNRSTZcdelnrstz', 'ČĎĚĽŇŘŠŤŽčďěľňřšťž')
  })
  let output = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] ?? 0
    if (value === 0x8f || value === 0x80 || value === 0x81 || value === 0x84 || value === 0x85 || value === 0) continue
    if (value === 0x8a) { output += '\n'; continue }
    const accent = accents[value]
    if (accent !== undefined && index + 1 < bytes.length) {
      const next = String.fromCharCode(bytes[index + 1] ?? 0)
      if (accent[next] !== undefined) { output += accent[next]; index += 1; continue }
    }
    output += single[value] ?? (value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '')
  }
  return output
}

function accentMap(ascii: string, unicode: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([...ascii].map((character, index) => [character, [...unicode][index] ?? character])))
}

function cue(start: number, end: number, lines: readonly string[], identifier?: string): Cue {
  return Object.freeze({ start, end, lines: Object.freeze([...lines]), ...(identifier === undefined ? {} : { identifier }) })
}

function parseTimedTextTime(value: string, fps: number, tickRate: number): number {
  const normalized = value.trim()
  if (normalized === '') return Number.NaN
  if (/^\d+(?:\.\d+)?ms$/i.test(normalized)) return Number(normalized.slice(0, -2)) / 1_000
  if (/^\d+(?:\.\d+)?s$/i.test(normalized)) return Number(normalized.slice(0, -1))
  if (/^\d+(?:\.\d+)?f$/i.test(normalized)) return Number(normalized.slice(0, -1)) / fps
  if (/^\d+(?:\.\d+)?t$/i.test(normalized)) return Number(normalized.slice(0, -1)) / tickRate
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized) / 1_000
  return parseClock(normalized)
}

function parseFrameClock(value: string, fps: number): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[.:](\d{1,3})$/)
  if (match === null) return Number.NaN
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + Math.min(Number(match[4]), fps - 1) / fps
}

function parseClock(value: string): number {
  const normalized = value.trim().replace(/^[\[(]|[\])]$/g, '')
  if (normalized === '') return Number.NaN
  const parts = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?$/)
  if (parts !== null) {
    const fraction = parts[4] ?? '0'
    return Number(parts[1] ?? 0) * 3_600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(`0.${fraction}`)
  }
  const short = normalized.match(/^(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/)
  if (short !== null) return Number(short[1]) * 60 + Number(short[2]) + Number(`0.${short[3] ?? 0}`)
  return Number.NaN
}

function formatTime(value: number): string {
  const milliseconds = Math.max(0, Math.round(value * 1_000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1_000).padStart(3, '0')}`
}

function attribute(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1]
}

function xmlText(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
}

function cleanCaptionLine(value: string): string {
  return decodeEntities(value)
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
}

function safeCodePoint(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

function positiveNumber(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}
