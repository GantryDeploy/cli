import { describe, expect, it } from 'vitest'

import { isTerminalStatus } from './deployment-status'

describe('isTerminalStatus', () => {
  it.each(['COMPLETE', 'FAILED', 'CANCELLED', 'SKIPPED'] as const)(
    'treats %s as terminal',
    (status) => {
      expect(isTerminalStatus(status)).toBe(true)
    }
  )

  it.each(['PENDING', 'PLANNING', 'INITIALIZING', 'RUNNING', 'BLOCKED', 'CANCELLING'] as const)(
    'keeps polling while %s',
    (status) => {
      expect(isTerminalStatus(status)).toBe(false)
    }
  )
})
