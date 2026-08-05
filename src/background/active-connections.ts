import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ActiveConnectionCounter {
  count(): Promise<number | null>
}

export class SystemActiveConnectionCounter implements ActiveConnectionCounter {
  public constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  public async count(): Promise<number | null> {
    if (this.platform === 'linux') {
      const contents = await Promise.all([
        readFile('/proc/net/tcp', 'utf8').catch(() => null),
        readFile('/proc/net/tcp6', 'utf8').catch(() => null)
      ])
      if (contents.every((content) => content === null)) return null
      return contents.reduce((total, content) => total + countLinuxEstablished(content ?? ''), 0)
    }
    if (this.platform === 'darwin' || this.platform === 'win32') {
      const command = this.platform === 'win32' ? 'netstat.exe' : 'netstat'
      const { stdout } = await execFileAsync(command, ['-an'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 10 * 1_024 * 1_024 }).catch(() => ({ stdout: null }))
      return typeof stdout === 'string' ? countNetstatEstablished(stdout) : null
    }
    return null
  }
}

export function countLinuxEstablished(content: string): number {
  let count = 0
  for (const line of content.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] === '01') count += 1
  }
  return count
}

export function countNetstatEstablished(content: string): number {
  return content.split(/\r?\n/).filter((line) => /\bESTABLISHED\b/i.test(line)).length
}
