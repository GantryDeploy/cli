/**
 * The `.env` dialect `gantry env pull` writes and `gantry env push` reads. Values that need it are
 * double-quoted with `\\`, `\"` and `\n` escapes, so a pulled file pushes back unchanged.
 */

const EXPORT_PREFIX = /^export\s+/
const NEEDS_QUOTES = /[\s"'#\\=]|^$/

export class DotenvError extends Error {}

function unquote(raw: string, where: string): string {
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) throw new DotenvError(`Unclosed quote at ${where}.`)
    return raw.slice(1, -1)
  }
  if (!raw.startsWith('"')) return raw
  let value = ''
  for (let i = 1; i < raw.length; i++) {
    const char = raw[i]
    if (char === '"') {
      if (i !== raw.length - 1) throw new DotenvError(`Text after the closing quote at ${where}.`)
      return value
    }
    if (char === '\\' && i + 1 < raw.length) {
      i++
      value += raw[i] === 'n' ? '\n' : raw[i]
    } else {
      value += char
    }
  }
  throw new DotenvError(`Unclosed quote at ${where}.`)
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Errors name the line, never its content: a line may hold a credential, and one missing its `=`
 * would otherwise be read as a key with the value inside it.
 */
export function parseDotenv(content: string, source: string): Record<string, string> {
  const values: Record<string, string> = {}
  const lineOf = new Map<string, number>()
  content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return
      const where = `${source} line ${String(index + 1)}`
      const entry = trimmed.replace(EXPORT_PREFIX, '')
      const eq = entry.indexOf('=')
      const key = entry.slice(0, Math.max(eq, 0)).trim()
      if (!KEY_PATTERN.test(key)) {
        throw new DotenvError(`Invalid entry at ${where}. Expected KEY=value.`)
      }
      const earlier = lineOf.get(key)
      if (earlier !== undefined) {
        throw new DotenvError(`${where} sets a variable already set on line ${String(earlier)}.`)
      }
      lineOf.set(key, index + 1)
      values[key] = unquote(entry.slice(eq + 1).trim(), where)
    })
  return values
}

/** One `KEY=value` from the command line. The value is taken as typed, quotes included. */
export function parseAssignment(text: string, position: number): [string, string] {
  const eq = text.indexOf('=')
  const key = text.slice(0, Math.max(eq, 0))
  if (!KEY_PATTERN.test(key)) {
    throw new DotenvError(`Argument ${String(position)} is not KEY=value.`)
  }
  return [key, text.slice(eq + 1)]
}

function quote(value: string): string {
  if (!NEEDS_QUOTES.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

export function formatDotenv(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}=${quote(values[key])}\n`)
    .join('')
}
