import { isValidFqdn, validateRootDomain, type RootDomainValidationResult } from './hostname'

export { isValidFqdn, validateRootDomain }
export type { RootDomainValidationResult }

const CERT_DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

export function isValidCertificateDomain(value: string): boolean {
  if (value.startsWith('*.')) {
    return isValidFqdn(value.slice(2)) || CERT_DOMAIN_REGEX.test(value.slice(2))
  }
  return CERT_DOMAIN_REGEX.test(value) && value.length <= 253
}

export function rootDomainErrorMessage(input: string, result: RootDomainValidationResult): string {
  if (result.ok) return ''
  switch (result.reason) {
    case 'subdomain':
      return `Only root domains can be registered in Gantry. Register "${result.suggestion}" and manage "${input}" as a DNS record or route under it.`
    case 'public-suffix':
      return `"${input}" is a public suffix, not a registrable domain.`
    case 'private-suffix':
      return `"${input}" is part of a managed hosting platform. Gantry can only manage domains where you control DNS. Use a domain you own.`
    case 'invalid':
      return `"${input}" is not a valid domain name.`
  }
  return ''
}

export function parseAdditionalDomains(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((d) => d.trim())
    .filter(Boolean)
}
