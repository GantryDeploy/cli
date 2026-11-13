import { describe, expect, it } from 'vitest'

import { DotenvError, formatDotenv, parseAssignment, parseDotenv } from './dotenv'

describe('parseDotenv', () => {
  it('reads plain, quoted and exported entries and skips comments', () => {
    const content = [
      '# staging settings',
      'APP_NAME=shop',
      'export TZ=UTC',
      'GREETING="hello world"',
      "RAW='a \\n stays'",
      'MULTILINE="line one\\nline two"',
      'EMPTY=',
      '',
    ].join('\n')

    expect(parseDotenv(content, '.env.staging')).toEqual({
      APP_NAME: 'shop',
      TZ: 'UTC',
      GREETING: 'hello world',
      RAW: 'a \\n stays',
      MULTILINE: 'line one\nline two',
      EMPTY: '',
    })
  })

  it.each([
    ['NO_EQUALS', 'Invalid entry at .env line 1. Expected KEY=value.'],
    ['=value', 'Invalid entry at .env line 1. Expected KEY=value.'],
    ['TOKEN="abc', 'Unclosed quote at .env line 1.'],
    ['TOKEN="abc" trailing', 'Text after the closing quote at .env line 1.'],
    [
      'DATABASE_URL postgres://app:s3cret@db/shop?sslmode=require',
      'Invalid entry at .env line 1. Expected KEY=value.',
    ],
    ['TZ=UTC\nTZ=Europe/London', '.env line 2 sets a variable already set on line 1.'],
  ])('refuses %j without echoing the line', (content, message) => {
    expect(() => parseDotenv(content, '.env')).toThrow(new DotenvError(message))
  })
})

describe('formatDotenv', () => {
  it('round-trips through parseDotenv', () => {
    const values = {
      APP_NAME: 'shop',
      DSN: 'postgres://app:p@ss#1@db.internal:5432/shop?sslmode=require',
      PEM: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      QUOTED: 'say "hi" \\ bye',
      EMPTY: '',
    }

    expect(parseDotenv(formatDotenv(values), '.env')).toEqual(values)
  })

  it('sorts keys and leaves simple values unquoted', () => {
    expect(formatDotenv({ TZ: 'UTC', APP_NAME: 'shop' })).toBe('APP_NAME=shop\nTZ=UTC\n')
  })
})

describe('parseAssignment', () => {
  it('splits on the first equals sign', () => {
    expect(parseAssignment('QUERY=a=b', 1)).toEqual(['QUERY', 'a=b'])
  })

  it.each(['s3cret', 'DATABASE_URL postgres://app:s3cret@db/shop?sslmode=require'])(
    'names the argument position, not its content, for %j',
    (text) => {
      expect(() => parseAssignment(text, 2)).toThrow(
        new DotenvError('Argument 2 is not KEY=value.')
      )
    }
  )
})
