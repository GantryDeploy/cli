import type { UpdateCacheInput } from '../generated/graphql'

import { buildAwsCacheUpdate, type AwsCacheUpdateFlags } from './clouds/aws'
import { notANumberMessage, parseNumber } from './numbers'

export interface CacheUpdateOptions extends AwsCacheUpdateFlags {
  name?: string
  size?: string
  engineVersion?: string
  backupDays?: string
}

export type CacheUpdate =
  { ok: true; input: UpdateCacheInput; warnings: string[] } | { ok: false; message: string }

/** Turns `gantry caches update` flags into the API input, with the warnings a confirmation shows. */
export function buildCacheUpdate(options: CacheUpdateOptions): CacheUpdate {
  const input: UpdateCacheInput = {}
  if (options.name !== undefined) input.name = options.name
  if (options.size !== undefined) input.size = options.size
  if (options.engineVersion !== undefined) input.engineVersion = options.engineVersion
  if (options.backupDays !== undefined) {
    const days = parseNumber(options.backupDays, true)
    if (days === null) return { ok: false, message: notANumberMessage('--backup-days', true) }
    input.backupRetentionDays = days
  }

  const aws = buildAwsCacheUpdate(options)
  if (!aws.ok) return aws
  if (Object.keys(aws.value).length > 0) input.aws = aws.value

  if (Object.keys(input).length === 0) {
    return { ok: false, message: 'Nothing to change. Pass at least one setting.' }
  }

  const warnings: string[] = []
  if (input.size !== undefined || aws.value.numCacheNodes !== undefined) {
    warnings.push("Resizing restarts the cache's nodes.")
  }
  if (input.engineVersion !== undefined) {
    warnings.push("Upgrading the engine restarts the cache's nodes, and it can't be undone.")
  }
  if (input.backupRetentionDays === 0) {
    warnings.push('Backups turn off.')
  }
  return { ok: true, input, warnings }
}
