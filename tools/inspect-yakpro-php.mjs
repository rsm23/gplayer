#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const arguments_ = process.argv.slice(2)
if (arguments_[0] === '--') arguments_.shift()
const [inputFile, methodName] = arguments_

if (!inputFile) {
  console.error('Usage: node tools/inspect-yakpro-php.mjs <file.php> [methodName]')
  process.exit(1)
}

const source = await readFile(path.resolve(inputFile), 'utf8')
const selected = methodName ? extractMethod(source, methodName) : source
if (selected === null) {
  console.error(`Method not found: ${methodName}`)
  process.exit(2)
}

process.stdout.write(formatStatements(decodeStringLiterals(selected)))

function extractMethod(php, name) {
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`)
  const match = pattern.exec(php)
  if (match === null) return null

  const openingBrace = findCharacterOutsideStrings(php, '{', match.index + match[0].length)
  if (openingBrace < 0) return null

  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openingBrace; index < php.length; index += 1) {
    const character = php[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return php.slice(match.index, index + 1)
    }
  }
  return null
}

function findCharacterOutsideStrings(value, target, start) {
  let quote = null
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === target) return index
  }
  return -1
}

function decodeStringLiterals(php) {
  return php.replace(/"(?:\\.|[^"\\])*"/gs, (literal) => {
    const content = literal.slice(1, -1)
    const decoded = content.replace(
      /\\x([0-9A-Fa-f]{2})|\\([0-7]{1,3})|\\([nrtvef$"\\])/g,
      (_match, hexadecimal, octal, simple) => {
        if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16))
        if (octal !== undefined) return String.fromCodePoint(Number.parseInt(octal, 8))
        return {
          n: '\n',
          r: '\r',
          t: '\t',
          v: '\v',
          e: '\u001b',
          f: '\f',
          $: '$',
          '"': '"',
          '\\': '\\'
        }[simple]
      }
    )
    return JSON.stringify(decoded)
  })
}

function formatStatements(php) {
  return php
    .replace(/;\s*/g, ';\n')
    .replace(/}\s*(?=(?:[A-Za-z_][A-Za-z0-9_]*:|goto\b|$))/g, '}\n')
    .replace(/\s+goto\s+/g, '\ngoto ')
    .replace(/\s+([A-Za-z_][A-Za-z0-9_]*:(?!:))\s*/g, '\n$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
