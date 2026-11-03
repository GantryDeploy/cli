import type { UpdateDatabaseInput } from '../generated/graphql'

export interface DatabaseUpdateOptions {
  name?: string
  instanceClass?: string
  minCapacity?: string
  maxCapacity?: string
  pauseAfter?: string
  storage?: string
  storageType?: string
  iops?: string
  backupDays?: string
  multiAz?: boolean
  performanceInsights?: boolean
  masterRotation?: boolean
}

export type DatabaseUpdate =
  { ok: true; input: UpdateDatabaseInput; warnings: string[] } | { ok: false; message: string }

const NUMBER_FLAGS = [
  ['minCapacity', '--min-capacity', 'minCapacity', false],
  ['maxCapacity', '--max-capacity', 'maxCapacity', false],
  ['pauseAfter', '--pause-after', 'secondsUntilAutoPause', true],
  ['storage', '--storage', 'allocatedStorage', true],
  ['iops', '--iops', 'iops', true],
  ['backupDays', '--backup-days', 'backupRetentionPeriod', true],
] as const

/** Turns `gantry db update` flags into the API input, with the warnings a confirmation shows. */
export function buildDatabaseUpdate(options: DatabaseUpdateOptions): DatabaseUpdate {
  const input: UpdateDatabaseInput = {}
  if (options.name !== undefined) input.name = options.name
  if (options.instanceClass !== undefined) input.instanceClass = options.instanceClass
  if (options.storageType !== undefined) input.storageType = options.storageType
  if (options.multiAz !== undefined) input.multiAz = options.multiAz
  if (options.performanceInsights !== undefined) {
    input.performanceInsightsEnabled = options.performanceInsights
  }
  if (options.masterRotation !== undefined) input.masterPasswordRotation = options.masterRotation

  for (const [option, flag, field, whole] of NUMBER_FLAGS) {
    const raw = options[option]
    if (raw === undefined) continue
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) {
      return { ok: false, message: `${flag} must be a ${whole ? 'whole number' : 'number'}.` }
    }
    input[field] = value
  }

  if (Object.keys(input).length === 0) {
    return { ok: false, message: 'Nothing to change. Pass at least one setting.' }
  }

  const warnings: string[] = []
  if (input.instanceClass !== undefined) {
    warnings.push('The server restarts briefly to apply the new instance class.')
  }
  if (input.backupRetentionPeriod === 0) {
    warnings.push('Backups turn off and existing automatic backups are deleted.')
  }
  if (input.masterPasswordRotation !== undefined) {
    warnings.push(
      'Changing master password rotation sets a new master password. Anything signing in as the master user with the old password stops working. Service users are not affected.'
    )
  }
  return { ok: true, input, warnings }
}
