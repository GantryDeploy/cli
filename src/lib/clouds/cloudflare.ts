import { Option } from 'commander'

import type { CloudflareDnsRecordSettingsInput } from '../../generated/graphql'

export const CLOUDFLARE_OPTIONS_GROUP = 'Cloudflare options:'

/** A flag that only applies to Cloudflare, listed under its own help heading. */
export function cloudflareOption(flags: string, description: string): Option {
  return new Option(flags, description).helpGroup(CLOUDFLARE_OPTIONS_GROUP)
}

export interface CloudflareDnsRecordFlags {
  cloudflareProxied?: boolean
  cloudflareNoProxied?: boolean
}

export function buildCloudflareDnsRecordSettings(
  flags: CloudflareDnsRecordFlags
):
  | { ok: true; value: CloudflareDnsRecordSettingsInput | undefined }
  | { ok: false; message: string } {
  if (flags.cloudflareProxied && flags.cloudflareNoProxied) {
    return { ok: false, message: 'Choose either --cloudflare-proxied or --cloudflare-no-proxied.' }
  }
  if (flags.cloudflareProxied) return { ok: true, value: { proxied: true } }
  if (flags.cloudflareNoProxied) return { ok: true, value: { proxied: false } }
  return { ok: true, value: undefined }
}
