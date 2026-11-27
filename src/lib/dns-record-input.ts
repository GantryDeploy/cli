import type { UpdateDnsRecordInput } from '../generated/graphql'

import { buildAwsDnsRecordSettings, type AwsDnsRecordFlags } from './clouds/aws'
import {
  buildCloudflareDnsRecordSettings,
  type CloudflareDnsRecordFlags,
} from './clouds/cloudflare'
import { notANumberMessage, parseNumber } from './numbers'

export interface DnsRecordFlags extends AwsDnsRecordFlags, CloudflareDnsRecordFlags {
  type?: string
  name?: string
  value?: string
  priority?: string
  weight?: string
  port?: string
  caaFlags?: string
  caaTag?: string
}

const NUMBER_FLAGS = [
  ['priority', '--priority'],
  ['weight', '--weight'],
  ['port', '--port'],
  ['caaFlags', '--caa-flags'],
] as const

/**
 * The record fields and per-cloud sections the flags set. The API checks which fields the
 * record type takes, and which cloud's section the domain's DNS provider accepts.
 */
export function buildDnsRecordFields(
  flags: DnsRecordFlags
): { ok: true; input: UpdateDnsRecordInput } | { ok: false; message: string } {
  const input: UpdateDnsRecordInput = {}
  if (flags.type !== undefined) input.recordType = flags.type
  if (flags.name !== undefined) input.name = flags.name
  if (flags.value !== undefined) input.value = flags.value
  if (flags.caaTag !== undefined) input.caaTag = flags.caaTag
  for (const [option, flag] of NUMBER_FLAGS) {
    const raw = flags[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, true)
    if (value === null) return { ok: false, message: notANumberMessage(flag, true) }
    input[option] = value
  }

  const aws = buildAwsDnsRecordSettings(flags)
  if (!aws.ok) return aws
  if (aws.value) input.aws = aws.value
  const cloudflare = buildCloudflareDnsRecordSettings(flags)
  if (!cloudflare.ok) return cloudflare
  if (cloudflare.value) input.cloudflare = cloudflare.value
  if (input.aws && input.cloudflare) {
    return { ok: false, message: 'A record takes AWS or Cloudflare settings, not both.' }
  }
  return { ok: true, input }
}
