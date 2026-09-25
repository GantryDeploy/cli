import { describe, expect, it } from 'vitest'

import {
  isValidCertificateDomain,
  parseAdditionalDomains,
  rootDomainErrorMessage,
  validateRootDomain,
} from './domain-validation'

describe('isValidCertificateDomain', () => {
  it.each(['example.com', 'api.example.com', '*.example.com', 'localhost', 'a-1.b-2.dev'])(
    'accepts %s',
    (value) => {
      expect(isValidCertificateDomain(value)).toBe(true)
    }
  )

  it.each([
    ['a wildcard below the leftmost label', 'api.*.example.com'],
    ['a bare wildcard', '*.'],
    ['a leading hyphen', '-example.com'],
    ['a trailing hyphen label', 'example-.com'],
    ['a trailing dot', 'example.com.'],
    ['a scheme', 'https://example.com'],
    ['more than 253 characters', `${'a'.repeat(60)}.`.repeat(4) + 'example.com'],
  ])('rejects %s', (_label, value) => {
    expect(isValidCertificateDomain(value)).toBe(false)
  })
})

describe('rootDomainErrorMessage', () => {
  it('is empty for a valid root', () => {
    expect(rootDomainErrorMessage('example.com', validateRootDomain('example.com'))).toBe('')
  })

  it('suggests the root for a subdomain', () => {
    expect(rootDomainErrorMessage('www.example.com', validateRootDomain('www.example.com'))).toBe(
      'Only root domains can be registered in Gantry. Register "example.com" and manage "www.example.com" as a DNS record or route under it.'
    )
  })

  it('explains a public suffix', () => {
    expect(rootDomainErrorMessage('co.uk', validateRootDomain('co.uk'))).toBe(
      '"co.uk" is a public suffix, not a registrable domain.'
    )
  })

  it('explains a managed hosting platform', () => {
    expect(rootDomainErrorMessage('x.github.io', validateRootDomain('x.github.io'))).toContain(
      'managed hosting platform'
    )
  })

  it('explains malformed input', () => {
    expect(rootDomainErrorMessage('nope', validateRootDomain('nope'))).toBe(
      '"nope" is not a valid domain name.'
    )
  })
})

describe('parseAdditionalDomains', () => {
  it('splits on commas and newlines and drops blanks', () => {
    expect(parseAdditionalDomains(' a.com, b.com\n\n c.com ,,')).toEqual([
      'a.com',
      'b.com',
      'c.com',
    ])
  })

  it('returns nothing for blank input', () => {
    expect(parseAdditionalDomains('  ')).toEqual([])
  })
})
