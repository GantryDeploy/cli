import { describe, expect, it } from 'vitest'

import { buildDatabaseUpdate } from './database-update'

describe('buildDatabaseUpdate', () => {
  it('maps flags to the API fields', () => {
    expect(
      buildDatabaseUpdate({
        name: 'Orders primary',
        minCapacity: '0.5',
        maxCapacity: '16',
        pauseAfter: '900',
        storage: '200',
        storageType: 'io2',
        iops: '3000',
        backupDays: '14',
        performanceInsights: true,
      })
    ).toEqual({
      ok: true,
      input: {
        name: 'Orders primary',
        minCapacity: 0.5,
        maxCapacity: 16,
        secondsUntilAutoPause: 900,
        allocatedStorage: 200,
        storageType: 'io2',
        iops: 3000,
        backupRetentionPeriod: 14,
        performanceInsightsEnabled: true,
      },
      warnings: [],
    })
  })

  it.each([
    [{ instanceClass: 'db.m7g.large' }, 'The server restarts briefly'],
    [{ backupDays: '0' }, 'existing automatic backups are deleted'],
    [{ masterRotation: false }, 'sets a new master password'],
  ])('warns before %o', (options, warning) => {
    const update = buildDatabaseUpdate(options)

    expect(update.ok && update.warnings.join(' ')).toContain(warning)
  })

  it.each([
    [{ storage: '50.5' }, '--storage must be a whole number.'],
    [{ maxCapacity: 'lots' }, '--max-capacity must be a number.'],
    [{ iops: '' }, '--iops must be a whole number.'],
  ])('refuses %o', (options, message) => {
    expect(buildDatabaseUpdate(options)).toEqual({ ok: false, message })
  })

  it('refuses an update with nothing to change', () => {
    expect(buildDatabaseUpdate({})).toEqual({
      ok: false,
      message: 'Nothing to change. Pass at least one setting.',
    })
  })
})
