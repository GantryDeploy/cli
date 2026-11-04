import type { AwsDatabaseSettingsInput, UpdateDatabaseInput } from '../generated/graphql'

export interface DatabaseUpdateOptions {
  name?: string
  size?: string
  minCapacity?: string
  maxCapacity?: string
  pauseAfter?: string
  storage?: string
  storageType?: string
  iops?: string
  backupDays?: string
  highAvailability?: boolean
  performanceInsights?: boolean
  masterRotation?: boolean
}

export type DatabaseUpdate =
  { ok: true; input: UpdateDatabaseInput; warnings: string[] } | { ok: false; message: string }

const SHARED_NUMBER_FLAGS = [
  ['storage', '--storage', 'storageGb'],
  ['backupDays', '--backup-days', 'backupRetentionDays'],
] as const

const AWS_NUMBER_FLAGS = [
  ['minCapacity', '--min-capacity', 'minCapacity', false],
  ['maxCapacity', '--max-capacity', 'maxCapacity', false],
  ['pauseAfter', '--pause-after', 'secondsUntilAutoPause', true],
  ['iops', '--iops', 'iops', true],
] as const

function parseNumber(raw: string, whole: boolean): number | null {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) {
    return null
  }
  return value
}

const notANumber = (flag: string, whole: boolean) => ({
  ok: false as const,
  message: `${flag} must be a ${whole ? 'whole number' : 'number'}.`,
})

/** Turns `gantry db update` flags into the API input, with the warnings a confirmation shows. */
export function buildDatabaseUpdate(options: DatabaseUpdateOptions): DatabaseUpdate {
  const input: UpdateDatabaseInput = {}
  const aws: AwsDatabaseSettingsInput = {}
  if (options.name !== undefined) input.name = options.name
  if (options.size !== undefined) input.size = options.size
  if (options.highAvailability !== undefined) input.highAvailability = options.highAvailability
  if (options.storageType !== undefined) aws.storageType = options.storageType
  if (options.performanceInsights !== undefined) {
    aws.performanceInsightsEnabled = options.performanceInsights
  }
  if (options.masterRotation !== undefined) aws.masterPasswordRotation = options.masterRotation

  for (const [option, flag, field] of SHARED_NUMBER_FLAGS) {
    const raw = options[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, true)
    if (value === null) return notANumber(flag, true)
    input[field] = value
  }
  for (const [option, flag, field, whole] of AWS_NUMBER_FLAGS) {
    const raw = options[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, whole)
    if (value === null) return notANumber(flag, whole)
    aws[field] = value
  }
  if (Object.keys(aws).length > 0) input.aws = aws

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
  if (aws.masterPasswordRotation !== undefined) {
    warnings.push(
      'Changing master password rotation sets a new master password. Anything signing in as the master user with the old password stops working. Service users are not affected.'
    )
  }
  return { ok: true, input, warnings }
}
