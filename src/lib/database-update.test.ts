import { describe, expect, it } from 'vitest'

import { buildDatabaseUpdate } from './database-update'

describe('buildDatabaseUpdate', () => {
  it('puts shared settings at the top level and AWS settings under aws', () => {
    expect(
      buildDatabaseUpdate({
        name: 'Orders primary',
        size: 'db.m7g.large',
        storage: '200',
        backupDays: '14',
        highAvailability: true,
        awsMinCapacity: '0.5',
        awsMaxCapacity: '16',
        awsPauseAfter: '900',
        awsStorageType: 'io2',
        awsIops: '3000',
        awsPerformanceInsights: true,
      })
    ).toEqual({
      ok: true,
      input: {
        name: 'Orders primary',
        size: 'db.m7g.large',
        storageGb: 200,
        backupRetentionDays: 14,
        highAvailability: true,
        aws: {
          minCapacity: 0.5,
          maxCapacity: 16,
          secondsUntilAutoPause: 900,
          storageType: 'io2',
          iops: 3000,
          performanceInsightsEnabled: true,
        },
      },
      warnings: ['The server restarts briefly to apply the new size.'],
    })
  })

  it('sends no AWS section when no AWS flag is passed', () => {
    expect(buildDatabaseUpdate({ backupDays: '7' })).toEqual({
      ok: true,
      input: { backupRetentionDays: 7 },
      warnings: [],
    })
  })

  it.each([
    [{ size: 'db.m7g.large' }, 'The server restarts briefly'],
    [{ backupDays: '0' }, 'existing automatic backups are deleted'],
    [{ awsNoMasterRotation: true }, 'sets a new master password'],
  ])('warns before %o', (options, warning) => {
    const update = buildDatabaseUpdate(options)

    expect(update.ok && update.warnings.join(' ')).toContain(warning)
  })

  it.each([
    [{ storage: '50.5' }, '--storage must be a whole number.'],
    [{ awsMaxCapacity: 'lots' }, '--aws-max-capacity must be a number.'],
    [{ awsIops: '' }, '--aws-iops must be a whole number.'],
    [
      { awsPerformanceInsights: true, awsNoPerformanceInsights: true },
      'Choose either --aws-performance-insights or --aws-no-performance-insights.',
    ],
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
