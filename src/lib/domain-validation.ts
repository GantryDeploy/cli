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

export const AWS_REGIONS = [
  { code: 'us-east-1', name: 'US East (N. Virginia)' },
  { code: 'us-east-2', name: 'US East (Ohio)' },
  { code: 'us-west-1', name: 'US West (N. California)' },
  { code: 'us-west-2', name: 'US West (Oregon)' },
  { code: 'eu-west-1', name: 'EU (Ireland)' },
  { code: 'eu-west-2', name: 'EU (London)' },
  { code: 'eu-west-3', name: 'EU (Paris)' },
  { code: 'eu-central-1', name: 'EU (Frankfurt)' },
  { code: 'eu-north-1', name: 'EU (Stockholm)' },
  { code: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { code: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
  { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { code: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { code: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
  { code: 'sa-east-1', name: 'South America (Sao Paulo)' },
  { code: 'ca-central-1', name: 'Canada (Central)' },
] as const
