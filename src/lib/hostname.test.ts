import { describe, expect, it } from 'vitest'

import { getRootDomain, isRootDomain, isValidFqdn, validateRootDomain } from './hostname'

describe('isValidFqdn', () => {
  it.each(['example.com', 'api.example.com', 'a-b.example.co.uk', 'xn--bcher-kva.example'])(
    'accepts %s',
    (hostname) => {
      expect(isValidFqdn(hostname)).toBe(true)
    }
  )

  it.each([
    ['a wildcard', '*.example.com'],
    ['a URL', 'https://example.com'],
    ['a trailing slash', 'example.com/'],
    ['a single label', 'localhost'],
    ['a leading hyphen', '-example.com'],
    ['a numeric TLD', 'example.123'],
    ['an empty label', 'example..com'],
    ['a label over 63 characters', `${'a'.repeat(64)}.com`],
    ['an empty string', ''],
    ['whitespace', ' example.com'],
  ])('rejects %s', (_label, hostname) => {
    expect(isValidFqdn(hostname)).toBe(false)
  })

  it('rejects a non-string at runtime', () => {
    expect(isValidFqdn(undefined as unknown as string)).toBe(false)
  })
})

describe('validateRootDomain', () => {
  it('accepts a registrable root and normalises case and whitespace', () => {
    expect(validateRootDomain('  Example.COM ')).toEqual({ ok: true, root: 'example.com' })
  })

  it('accepts a root under a multi-label public suffix', () => {
    expect(validateRootDomain('example.co.uk')).toEqual({ ok: true, root: 'example.co.uk' })
  })

  it('rejects a subdomain and suggests its root', () => {
    expect(validateRootDomain('www.shop.example.co.uk')).toEqual({
      ok: false,
      reason: 'subdomain',
      suggestion: 'example.co.uk',
    })
  })

  it('rejects a bare public suffix', () => {
    expect(validateRootDomain('co.uk')).toEqual({ ok: false, reason: 'public-suffix' })
  })

  it('rejects a domain on a managed hosting platform', () => {
    expect(validateRootDomain('my-app.github.io')).toEqual({ ok: false, reason: 'private-suffix' })
  })

  it('rejects malformed input', () => {
    expect(validateRootDomain('not a domain')).toEqual({ ok: false, reason: 'invalid' })
    expect(validateRootDomain('https://example.com')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('treats an unlisted TLD as a public suffix, per the PSL default rule', () => {
    expect(validateRootDomain('example.notarealtld')).toEqual({
      ok: true,
      root: 'example.notarealtld',
    })
  })

  it('rejects a non-string at runtime', () => {
    expect(validateRootDomain(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('getRootDomain', () => {
  it('returns the registrable root of a subdomain', () => {
    expect(getRootDomain('API.Staging.Example.com')).toBe('example.com')
  })

  it('returns null for a managed hosting platform', () => {
    expect(getRootDomain('app.vercel.app')).toBeNull()
  })

  it('returns null for a bare public suffix', () => {
    expect(getRootDomain('co.uk')).toBeNull()
  })

  it('returns null for malformed or non-string input', () => {
    expect(getRootDomain('*.example.com')).toBeNull()
    expect(getRootDomain(null as unknown as string)).toBeNull()
  })
})

describe('isRootDomain', () => {
  it('is true only for a registrable root', () => {
    expect(isRootDomain('example.com')).toBe(true)
    expect(isRootDomain('www.example.com')).toBe(false)
    expect(isRootDomain('co.uk')).toBe(false)
  })
})
