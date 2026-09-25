import { describe, expect, it } from 'vitest'

import { MIN_KNOWN_SECRET_LENGTH, redact, sanitizeTerminal } from './sanitize'

describe('sanitizeTerminal', () => {
  it.each([
    ['clear screen', 'before\x1b[2Jafter'],
    ['OSC title', 'before\x1b]0;pwned\x07after'],
    ['OSC title with spaces and ST', 'before\x1b]0;Deploy succeeded\x1b\\after'],
    ['OSC hyperlink', 'before\x1b]8;;https://evil.test/a b\x07after'],
    ['8-bit CSI', 'before\x9b2Jafter'],
    ['colour', 'before\x1b[32mafter'],
    ['bell and backspace', 'before\x07\x08after'],
    ['carriage return', 'before\rafter'],
    ['DEL and C1', 'before\x7f\x85after'],
  ])('removes %s', (_label, input) => {
    expect(sanitizeTerminal(input)).toBe('beforeafter')
  })

  it('keeps newlines, tabs and ordinary unicode', () => {
    expect(sanitizeTerminal('a\tb\nc → ✓ ü')).toBe('a\tb\nc → ✓ ü')
  })

  it.each([
    ['LRE', '\u202A'],
    ['RLE', '\u202B'],
    ['PDF', '\u202C'],
    ['LRO', '\u202D'],
    ['RLO', '\u202E'],
    ['LRI', '\u2066'],
    ['RLI', '\u2067'],
    ['FSI', '\u2068'],
    ['PDI', '\u2069'],
    ['LRM', '\u200E'],
    ['RLM', '\u200F'],
    ['zero-width space', '\u200B'],
    ['zero-width non-joiner', '\u200C'],
    ['zero-width joiner', '\u200D'],
    ['word joiner', '\u2060'],
    ['byte order mark', '\uFEFF'],
  ])('removes the %s formatting character', (_label, character) => {
    expect(sanitizeTerminal(`before${character}after`)).toBe('beforeafter')
  })

  it('cannot reorder a displayed name with a right-to-left override', () => {
    expect(sanitizeTerminal('invoice\u202Egpj.exe')).toBe('invoicegpj.exe')
  })

  it('turns line and paragraph separators into newlines', () => {
    expect(sanitizeTerminal('one\u2028two\u2029three')).toBe('one\ntwo\nthree')
  })
})

describe('redact', () => {
  it('masks Gantry personal and team tokens', () => {
    expect(redact('bad token gpat_abc123XYZ and gnat_Q-9_z')).toBe(
      'bad token [redacted] and [redacted]'
    )
  })

  it.each(['password', 'secret', 'token', 'value'])('masks a JSON "%s" pair', (key) => {
    expect(redact(`{"${key}": "hunter22", "name": "db"}`)).toBe(
      `{"${key}": "[redacted]", "name": "db"}`
    )
  })

  it('masks unquoted keys as graphql-js prints them', () => {
    expect(redact('got invalid value { key: "API_KEY", value: "s3cr3t" }')).toBe(
      'got invalid value { key: "API_KEY", value: "[redacted]" }'
    )
  })

  it('masks an unterminated value cut off by truncation', () => {
    expect(redact('{"password": "hunter2...')).toBe('{"password": "[redacted]"')
  })

  it('leaves keys that merely contain a sensitive word alone', () => {
    expect(redact('{"tokenName": "ci", "clientSecretArn": "arn"}')).toBe(
      '{"tokenName": "ci", "clientSecretArn": "arn"}'
    )
  })

  it('masks every occurrence of a submitted value', () => {
    expect(redact('echo: correct-horse, again correct-horse', ['correct-horse'])).toBe(
      'echo: [redacted], again [redacted]'
    )
  })

  it('masks the JSON-escaped form of a submitted value', () => {
    expect(redact('{"message":"bad \\"quoted\\" input"}', ['bad "quoted" input'])).toBe(
      '{"message":"[redacted]"}'
    )
  })

  it('masks a submitted value truncated at the end of the text', () => {
    expect(redact('Response: prefix correct-ho...', ['correct-horse'])).toBe(
      'Response: prefix [redacted]...'
    )
  })

  describe('a multi-word submitted secret', () => {
    const secret = 'correct horse battery'
    const fragments = ['correct', 'horse', 'battery']

    it.each([
      ['graphql-js', 'invalid value { key: "PASS", value: "correct horse battery" }'],
      ['graphql-js unquoted', 'invalid value { key: PASS, value: correct horse battery }'],
      [
        'JSON-escaped',
        '{"message":"invalid { key: \\"PASS\\", value: \\"correct horse battery\\" }"}',
      ],
      [
        'double-escaped',
        '{"body":"{\\"key\\":\\"PASS\\",\\"value\\":\\"correct horse battery\\"}"}',
      ],
      ['truncated', 'Response: {"value": "correct horse bat...'],
    ])('leaves no fragment in the %s form', (_label, text) => {
      const result = redact(text, [secret])

      for (const fragment of fragments) {
        expect(result).not.toContain(fragment)
      }
      expect(result).toContain('[redacted]')
    })
  })

  it('masks a backslash-escaped JSON pair without known secrets', () => {
    expect(redact('{"message":"{\\"value\\":\\"s3cr3t pass\\",\\"key\\":\\"A\\"}"}')).toBe(
      '{"message":"{\\"value\\":\\"[redacted]\\",\\"key\\":\\"A\\"}"}'
    )
  })

  it('masks an escaped inner quote in a backslash-escaped JSON value', () => {
    expect(redact('{\\"password\\":\\"pa\\\\\\"ss word\\"}')).toBe(
      '{\\"password\\":\\"[redacted]\\"}'
    )
  })

  it('masks the double-JSON-escaped form of a submitted value', () => {
    expect(redact('{"body":"{\\"note\\":\\"pa\\\\\\"ss\\\\\\\\word\\"}"}', ['pa"ss\\word'])).toBe(
      '{"body":"{\\"note\\":\\"[redacted]\\"}"}'
    )
  })

  it('keeps an already-masked bare value intact', () => {
    expect(redact('value: correct horse', ['correct horse'])).toBe('value: "[redacted]"')
  })

  it(`skips submitted values shorter than ${String(MIN_KNOWN_SECRET_LENGTH)} characters`, () => {
    expect(redact('on or off', ['on', 'off'])).toBe('on or off')
  })
})
