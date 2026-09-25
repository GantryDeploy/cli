import { stripVTControlCharacters } from 'util'

/** Shorter values are too likely to occur by chance in ordinary text to mask safely. */
export const MIN_KNOWN_SECRET_LENGTH = 4

const REDACTED = '[redacted]'

/* eslint-disable no-control-regex -- matching control characters is the point */

// OSC, DCS, SOS, PM and APC carry a free-text payload that stripVTControlCharacters
// only removes when it has no spaces, which would leave a spoofed title visible.
const STRING_SEQUENCES =
  /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g

const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/* eslint-enable no-control-regex */

// Bidi overrides/isolates and zero-width characters let untrusted text reorder
// or hide what the terminal displays.
const INVISIBLE_FORMATTING = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g

const LINE_SEPARATORS = /[\u2028\u2029]/g

const API_TOKEN = /\bg[pn]at_[A-Za-z0-9_-]+/g

// Values come quoted, JSON-in-JSON quoted (`\"…\"`, where `\\\"` is an inner quote
// and `\\\\` a backslash), or bare as graphql-js prints them.
const SENSITIVE_PAIR =
  /((?:\\?["'])?)\b(password|secret|token|value)\1(\s*:\s*)(\[redacted\]|\\"(?:\\\\\\"|\\\\|[^\\"])*(?:\\")?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s,}\]]+)/gi

/**
 * Strips ANSI/VT escape sequences, every other C0 and C1 control character
 * except newline and tab, and invisible bidi/zero-width formatting, so
 * untrusted text cannot move the cursor, clear the screen, retitle the
 * terminal or reorder what is shown.
 */
export function sanitizeTerminal(text: string): string {
  return stripVTControlCharacters(text.replace(STRING_SEQUENCES, ''))
    .replace(CONTROL_CHARACTERS, '')
    .replace(INVISIBLE_FORMATTING, '')
    .replace(LINE_SEPARATORS, '\n')
}

/**
 * Masks any of `knownSecrets` (values the user just submitted) at least
 * MIN_KNOWN_SECRET_LENGTH long, including a truncated tail of one, then Gantry
 * API tokens and JSON-ish `password`/`secret`/`token`/`value` pairs. Known
 * secrets go first: a pair pattern that caught only the first word of a
 * multi-word secret would otherwise break the exact match.
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text
  for (const secret of maskableSecrets(knownSecrets)) {
    result = maskTruncatedTail(result.split(secret).join(REDACTED), secret)
  }
  return result
    .replace(
      SENSITIVE_PAIR,
      (_match, quote: string, key: string, separator: string, value: string) => {
        const valueQuote = value.startsWith('\\"') ? '\\"' : '"'
        return `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`
      }
    )
    .replace(API_TOKEN, REDACTED)
}

function jsonEscape(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

function maskableSecrets(knownSecrets: readonly string[]): string[] {
  const forms = knownSecrets.flatMap((secret) => [
    secret,
    jsonEscape(secret),
    jsonEscape(jsonEscape(secret)),
  ])
  return [...new Set(forms)]
    .filter((secret) => secret.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
}

function maskTruncatedTail(text: string, secret: string): string {
  const ellipsis = text.endsWith('...') ? '...' : ''
  const body = ellipsis ? text.slice(0, -ellipsis.length) : text
  for (let length = secret.length - 1; length >= MIN_KNOWN_SECRET_LENGTH; length--) {
    if (body.endsWith(secret.slice(0, length))) {
      return `${body.slice(0, -length)}${REDACTED}${ellipsis}`
    }
  }
  return text
}
