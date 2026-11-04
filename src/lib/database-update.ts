import type { UpdateDatabaseInput } from '../generated/graphql'

import { buildAwsDatabaseUpdate, type AwsDatabaseUpdateFlags } from './clouds/aws'
import { notANumberMessage, parseNumber } from './numbers'

export interface DatabaseUpdateOptions extends AwsDatabaseUpdateFlags {
  name?: string
  size?: string
  storage?: string
  backupDays?: string
  highAvailability?: boolean
}

export type DatabaseUpdate =
  { ok: true; input: UpdateDatabaseInput; warnings: string[] } | { ok: false; message: string }

const SHARED_NUMBER_FLAGS = [
  ['storage', '--storage', 'storageGb'],
  ['backupDays', '--backup-days', 'backupRetentionDays'],
] as const

/** Turns `gantry db update` flags into the API input, with the warnings a confirmation shows. */
export function buildDatabaseUpdate(options: DatabaseUpdateOptions): DatabaseUpdate {
  const input: UpdateDatabaseInput = {}
  if (options.name !== undefined) input.name = options.name
  if (options.size !== undefined) input.size = options.size
  if (options.highAvailability !== undefined) input.highAvailability = options.highAvailability

  for (const [option, flag, field] of SHARED_NUMBER_FLAGS) {
    const raw = options[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, true)
    if (value === null) return { ok: false, message: notANumberMessage(flag, true) }
    input[field] = value
  }

  const aws = buildAwsDatabaseUpdate(options)
  if (!aws.ok) return aws
  if (Object.keys(aws.value).length > 0) input.aws = aws.value

  if (Object.keys(input).length === 0) {
    return { ok: false, message: 'Nothing to change. Pass at least one setting.' }
  }

  const warnings: string[] = []
  if (input.size !== undefined) {
    warnings.push('The server restarts briefly to apply the new size.')
  }
  if (input.backupRetentionDays === 0) {
    warnings.push('Backups turn off and existing automatic backups are deleted.')
  }
  if (aws.value.masterPasswordRotation !== undefined) {
    warnings.push(
      'Changing master password rotation sets a new master password. Anything signing in as the master user with the old password stops working. Service users are not affected.'
    )
  }
  return { ok: true, input, warnings }
}
