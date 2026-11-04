import type { CloudProviderEnum } from '../../generated/graphql'

export interface ResolvedCloud {
  id: string
  provider: CloudProviderEnum
}

export const CLOUD_PROVIDER_LABELS = {
  AWS: 'AWS',
  AZURE: 'Azure',
  CLOUDFLARE: 'Cloudflare',
  DIGITALOCEAN: 'DigitalOcean',
  GCP: 'Google Cloud',
  VULTR: 'Vultr',
} as const satisfies Record<CloudProviderEnum, string>

export function toCloudProvider(value: string): CloudProviderEnum {
  const upper = value.trim().toUpperCase()
  const match = Object.keys(CLOUD_PROVIDER_LABELS).find((p): p is CloudProviderEnum => p === upper)
  if (!match) {
    throw new Error(
      `Unknown cloud provider. Use one of: ${Object.keys(CLOUD_PROVIDER_LABELS)
        .map((p) => p.toLowerCase())
        .join(', ')}`
    )
  }
  return match
}

export function unsupportedCloud(feature: string): string {
  return `This cloud doesn't support ${feature} yet.`
}

/** Resource rows report their cloud in lowercase (`aws`), cloud accounts as the enum (`AWS`). */
export function isAws(provider: string): boolean {
  return provider.toUpperCase() === 'AWS'
}

/**
 * The `--aws-*` flags a command received, so a command run against another
 * cloud can refuse them instead of silently dropping them.
 */
export function awsFlagsUsed(options: object): string[] {
  return Object.entries(options)
    .filter(([key, value]) => /^aws[A-Z]/.test(key) && value !== undefined)
    .map(([key]) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
}

export function foreignAwsFlagsMessage(provider: string, options: object): string | null {
  if (isAws(provider)) return null
  const used = awsFlagsUsed(options)
  if (used.length === 0) return null
  return `${used.join(', ')} ${used.length === 1 ? 'only applies' : 'only apply'} to AWS cloud accounts.`
}
