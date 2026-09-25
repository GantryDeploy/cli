import { parse } from 'tldts'

export type RootDomainValidationResult =
  | { ok: true; root: string }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'public-suffix' }
  | { ok: false; reason: 'private-suffix' }
  | { ok: false; reason: 'subdomain'; suggestion: string }

const FQDN_REGEX = /^(?!-)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}$/

const TLDTS_OPTIONS = { allowPrivateDomains: true } as const

function normalize(hostname: string): string {
  return hostname.trim().toLowerCase()
}

export function isValidFqdn(hostname: string): boolean {
  if (typeof hostname !== 'string') return false
  if (hostname.includes('*')) return false
  if (hostname.includes('://')) return false
  if (hostname.endsWith('/')) return false
  return FQDN_REGEX.test(hostname)
}

export function validateRootDomain(hostname: string): RootDomainValidationResult {
  if (typeof hostname !== 'string') {
    return { ok: false, reason: 'invalid' }
  }

  const normalized = normalize(hostname)

  if (!isValidFqdn(normalized)) {
    return { ok: false, reason: 'invalid' }
  }

  const parsed = parse(normalized, TLDTS_OPTIONS)

  if (parsed.isPrivate === true) {
    return { ok: false, reason: 'private-suffix' }
  }

  if (!parsed.domain) {
    if (parsed.publicSuffix) {
      return { ok: false, reason: 'public-suffix' }
    }
    return { ok: false, reason: 'invalid' }
  }

  if (parsed.subdomain && parsed.subdomain.length > 0) {
    return { ok: false, reason: 'subdomain', suggestion: parsed.domain }
  }

  return { ok: true, root: parsed.domain }
}

export function getRootDomain(hostname: string): string | null {
  if (typeof hostname !== 'string') return null

  const normalized = normalize(hostname)

  if (!isValidFqdn(normalized)) return null

  const parsed = parse(normalized, TLDTS_OPTIONS)

  if (parsed.isPrivate === true) return null
  if (!parsed.domain) return null

  return parsed.domain
}

export function isRootDomain(hostname: string): boolean {
  return validateRootDomain(hostname).ok
}
