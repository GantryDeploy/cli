import { describe, expect, it } from 'vitest'

import { buildCacheUpdate } from './cache-update'

describe('buildCacheUpdate', () => {
  it('maps shared and AWS flags to the API input', () => {
    expect(
      buildCacheUpdate({
        name: 'Session store',
        size: 'cache.t4g.medium',
        backupDays: '7',
        awsReplicas: '2',
        awsSnapshotTime: '03:30',
      })
    ).toEqual({
      ok: true,
      input: {
        name: 'Session store',
        size: 'cache.t4g.medium',
        backupRetentionDays: 7,
        aws: { replicasPerNodeGroup: 2, dailySnapshotTime: '03:30' },
      },
      warnings: ["Resizing restarts the cache's nodes."],
    })
  })

  it('sends a rename with no warnings and no AWS section', () => {
    expect(buildCacheUpdate({ name: 'Session store' })).toEqual({
      ok: true,
      input: { name: 'Session store' },
      warnings: [],
    })
  })

  it.each([
    [
      { engineVersion: '8.1' },
      "Upgrading the engine restarts the cache's nodes, and it can't be undone.",
    ],
    [{ awsNodes: '3' }, "Resizing restarts the cache's nodes."],
    [{ backupDays: '0' }, 'Backups turn off.'],
  ])('warns before %j', (options, warning) => {
    const update = buildCacheUpdate(options)
    expect(update.ok && update.warnings).toEqual([warning])
  })

  it.each([
    [{}, 'Nothing to change. Pass at least one setting.'],
    [{ backupDays: 'week' }, '--backup-days must be a whole number.'],
    [{ awsMaxEcpu: '1.5' }, '--aws-max-ecpu must be a whole number.'],
    [{ awsSnapshotTime: '3am' }, '--aws-snapshot-time must be a UTC time like 03:30.'],
    [{ awsSnapshotTime: '24:00' }, '--aws-snapshot-time must be a UTC time like 03:30.'],
  ])('refuses %j', (options, message) => {
    expect(buildCacheUpdate(options)).toEqual({ ok: false, message })
  })
})
