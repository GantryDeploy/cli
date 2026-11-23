import { describe, expect, it } from 'vitest'

import { versionTag } from './version-tag'

describe('versionTag', () => {
  it.each([
    ['Rn0GNr', 12, 'v12'],
    ['Pv8xLm', null, 'Pv8xLm'],
  ])('shows version %s numbered %s as %s', (id, number, tag) => {
    expect(versionTag(id, number)).toBe(tag)
  })
})
