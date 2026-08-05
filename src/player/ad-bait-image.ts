import { randomInt } from 'node:crypto'
import sharp from 'sharp'

export const LEGACY_AD_BAIT_SIZE = 300

let cachedImage: Promise<Buffer> | undefined

export function legacyAdBaitImage(): Promise<Buffer> {
  if (cachedImage !== undefined) return cachedImage
  cachedImage = createLegacyAdBaitImage().catch((error: unknown) => {
    cachedImage = undefined
    throw error
  })
  return cachedImage
}

async function createLegacyAdBaitImage(): Promise<Buffer> {
  const size = LEGACY_AD_BAIT_SIZE
  const pixels = Buffer.alloc(size * size * 3)
  fill(pixels, size, randomColor())
  for (let index = 0; index < 10; index += 1) {
    const color = randomColor()
    const x1 = randomInt(0, size)
    const y1 = randomInt(0, size)
    if (randomInt(0, 2) === 0) {
      drawRectangle(pixels, size, x1, y1, randomInt(0, size), randomInt(0, size), color)
    } else {
      drawEllipse(pixels, size, x1, y1, randomInt(10, 51), randomInt(10, 51), color)
    }
  }
  return await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()
}

type Rgb = readonly [number, number, number]

function randomColor(): Rgb {
  return [randomInt(0, 256), randomInt(0, 256), randomInt(0, 256)]
}

function fill(pixels: Buffer, size: number, color: Rgb): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) setPixel(pixels, size, x, y, color)
  }
}

function drawRectangle(pixels: Buffer, size: number, x1: number, y1: number, x2: number, y2: number, color: Rgb): void {
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) setPixel(pixels, size, x, y, color)
  }
}

function drawEllipse(pixels: Buffer, size: number, centerX: number, centerY: number, radiusX: number, radiusY: number, color: Rgb): void {
  const left = Math.max(0, centerX - radiusX)
  const right = Math.min(size - 1, centerX + radiusX)
  const top = Math.max(0, centerY - radiusY)
  const bottom = Math.min(size - 1, centerY + radiusY)
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const normalizedX = (x - centerX) / radiusX
      const normalizedY = (y - centerY) / radiusY
      if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) setPixel(pixels, size, x, y, color)
    }
  }
}

function setPixel(pixels: Buffer, size: number, x: number, y: number, color: Rgb): void {
  const offset = (y * size + x) * 3
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
}
