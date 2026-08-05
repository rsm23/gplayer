import { describe, expect, it } from 'vitest'
import { convertSubtitleToWebVtt } from '../src/subtitles/subtitle-converter.js'

describe('legacy subtitle format conversion', () => {
  it('decodes UTF-16LE SubRip files before emitting WebVTT', () => {
    const text = '1\r\n00:00:01,250 --> 00:00:03,500\r\nHéllo\r\n'
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const output = convertSubtitleToWebVtt(bytes, new URL('https://media.example/caption.srt'))
    expect(output).toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:03.500\nHéllo')
  })

  it('decodes legacy Windows-1252 captions when the bytes are not valid UTF-8', () => {
    const bytes = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9 \x93quoted\x94', 'latin1')
    const output = convertSubtitleToWebVtt(bytes, new URL('https://media.example/caption.srt'))
    expect(output).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nCafé “quoted”')
  })

  it('normalizes existing WebVTT and removes legacy brace directives', () => {
    const output = convertSubtitleToWebVtt('webvtt\n\n00:00:01.000 --> 00:00:02.000\n{y:i}Caption', new URL('https://media.example/caption.vtt'))
    expect(output).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nCaption')
  })

  it('honors ASS event column order and strips override tags', () => {
    const output = convertSubtitleToWebVtt(`
[Script Info]
[Events]
Format: Text, End, Start
Dialogue: {\\i1}First\\Nsecond{\\i0},0:00:04.25,0:00:02.10
`, new URL('https://media.example/caption.ass'))
    expect(output).toContain('00:00:02.100 --> 00:00:04.250')
    expect(output).toContain('First\nsecond')
  })

  it('converts MicroDVD frame ranges using the supplied legacy default frame rate', () => {
    const output = convertSubtitleToWebVtt('{24}{72}{y:i}First|second', new URL('https://media.example/caption.sub'))
    expect(output).toBe('WEBVTT\n\n00:00:01.001 --> 00:00:03.003\nFirst\nsecond')
  })

  it('converts SubViewer headers, centisecond timestamps, and line separators', () => {
    const output = convertSubtitleToWebVtt('[INFORMATION]\n00:00:01.50,00:00:03.75\nFirst[br]second', new URL('https://media.example/caption.sub'))
    expect(output).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.750\nFirst\nsecond')
  })

  it('converts Spruce STL frame timestamps and pipe-separated lines', () => {
    const output = convertSubtitleToWebVtt('00:00:01:12 , 00:00:03:24 , First | second', new URL('https://media.example/caption.stl'))
    expect(output).toBe('WEBVTT\n\n00:00:01.480 --> 00:00:03.960\nFirst\nsecond')
  })

  it('converts SBV comma timestamp blocks', () => {
    const output = convertSubtitleToWebVtt('0:00:01.250,0:00:03.500\nFirst\nsecond', new URL('https://media.example/caption.sbv'))
    expect(output).toBe('WEBVTT\n\n00:00:01.250 --> 00:00:03.500\nFirst\nsecond')
  })

  it('converts QuickTime text using its declared time scale', () => {
    const output = convertSubtitleToWebVtt(`
{QTtext} {font:Tahoma}
{timeScale:30}
[00:00:01.15]
First
second
[00:00:03.00]
`, new URL('https://media.example/caption.txt'))
    expect(output).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nFirst\nsecond')
  })

  it('converts EBU STL binary blocks and ISO-6937 accents without text decoding loss', () => {
    const output = convertSubtitleToWebVtt(ebuStlFixture(), new URL('https://media.example/caption.stl'))
    expect(output).toBe('WEBVTT\n\n01:00:02.500 --> 01:00:05.000\nCafé\nline two')
  })

  it('supports TTML frame timing, frame-rate multipliers, durations, and entity decoding', () => {
    const output = convertSubtitleToWebVtt(`
<tt ttp:frameRate="60" ttp:frameRateMultiplier="1 2">
  <body><p begin="360f" dur="60f">Tom &amp; Jerry<br/>again</p></body>
</tt>
`, new URL('https://media.example/caption.ttml'))
    expect(output).toBe('WEBVTT\n\n00:00:12.000 --> 00:00:14.000\nTom & Jerry\nagain')
  })

  it('supports DFXP tick timing using the document tick rate', () => {
    const output = convertSubtitleToWebVtt(`
<tt ttp:tickRate="10000000">
  <body><p begin="1374000000t" end="1404000000t">First<br/>second</p></body>
</tt>
`, new URL('https://media.example/caption.dfxp'))
    expect(output).toBe('WEBVTT\n\n00:02:17.400 --> 00:02:20.400\nFirst\nsecond')
  })

  it('retains untimed plaintext paragraphs as sequential one-second cues', () => {
    const output = convertSubtitleToWebVtt('First line\ncontinued\n\nSecond cue', new URL('https://media.example/caption.txt'))
    expect(output).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst line\ncontinued\n\n00:00:01.000 --> 00:00:02.000\nSecond cue')
  })

  it('auto-detects SAMI blocks, HTML entities, line breaks, and blank terminators behind TXT URLs', () => {
    const output = convertSubtitleToWebVtt(`
<SAMI><BODY>
<SYNC Start=137400><P>Senator, we&#039;re making<br>our final approach.</P></SYNC>
<SYNC Start=140400><P>&nbsp;</P></SYNC>
</BODY></SAMI>
`, new URL('https://media.example/caption.txt'))
    expect(output).toBe("WEBVTT\n\n00:02:17.400 --> 00:02:20.400\nSenator, we're making\nour final approach.")
  })

  it('auto-detects LRC offsets and grouped timestamps behind TXT URLs', () => {
    const output = convertSubtitleToWebVtt(`
[offset:+500]
[00:01.10] First
[00:02.20][00:05.00] Grouped
[00:03.25] Third
`, new URL('https://media.example/caption.txt'))
    expect(output).toBe('WEBVTT\n\n00:00:00.600 --> 00:00:01.700\nFirst\n\n00:00:01.700 --> 00:00:02.750\nGrouped\n\n00:00:02.750 --> 00:00:04.500\nThird\n\n00:00:04.500 --> 00:00:05.500\nGrouped')
  })

  it('auto-detects Scenarist SCC display timing, positioning, parity bits, and CEA-608 text', () => {
    const output = convertSubtitleToWebVtt(`Scenarist_SCC V1.0

00:02:18;20 94ae 94ae 9420 9420 1370 1370 d3e5 6e61 f4ef f22c 20f7 e5a7 f2e5 206d 616b e96e 6780 94d0 94d0 ef75 f220 e6e9 6e61 ec20 6170 70f2 ef61 e368 20e9 6ef4 ef80 9470 9470 43ef f275 73e3 616e f4ae 942f 942f

00:02:24;28 942c 942c
`, new URL('https://media.example/caption.txt'))
    expect(output).toBe("WEBVTT\n\n00:02:20.002 --> 00:02:25.001\nSenator, we're making\nour final approach into\nCoruscant.")
  })

  it('auto-detects timestamped CSV delimiters, quoted newlines, and frame clocks behind TXT URLs', () => {
    const output = convertSubtitleToWebVtt(`Start;End;Text;Layer
00:00:01:00;00:00:02:00;"First\nline";1
00:00:02:00;00:00:03:00;Second;1`, new URL('https://media.example/caption.txt'))
    expect(output).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst\nline\n\n00:00:02.000 --> 00:00:03.000\nSecond')
  })
})

function ebuStlFixture(): Buffer {
  const result = Buffer.alloc(1_024 + 128, 0x20)
  result.write('850STL30', 0, 'ascii')
  const offset = 1_024
  result[offset + 3] = 0xff
  result.set([1, 0, 2, 15], offset + 5)
  result.set([1, 0, 5, 0], offset + 9)
  result.fill(0x8f, offset + 16, offset + 128)
  result.set(Buffer.from([0x43, 0x61, 0x66, 0xc2, 0x65, 0x8a, 0x6c, 0x69, 0x6e, 0x65, 0x20, 0x74, 0x77, 0x6f]), offset + 16)
  return result
}
