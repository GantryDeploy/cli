import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderer, shouldUseFallbackRenderer } from './listr'

function setStdoutTty(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

describe('listr renderer selection', () => {
  const originalTty = process.stdout.isTTY
  const originalCi = process.env.CI

  beforeEach(() => {
    delete process.env.CI
    setStdoutTty(true)
  })

  afterEach(() => {
    setStdoutTty(originalTty)
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
  })

  it('uses the default renderer on an interactive terminal', () => {
    expect(resolveRenderer(false)).toBe('default')
    expect(shouldUseFallbackRenderer()).toBe(false)
  })

  it('uses the verbose renderer on request, even in CI', () => {
    process.env.CI = 'true'

    expect(resolveRenderer(true)).toBe('verbose')
  })

  it('falls back to the simple renderer in CI', () => {
    process.env.CI = 'true'

    expect(resolveRenderer(false)).toBe('simple')
    expect(shouldUseFallbackRenderer()).toBe(true)
  })

  it('falls back to the simple renderer without a TTY', () => {
    setStdoutTty(undefined)

    expect(resolveRenderer(false)).toBe('simple')
    expect(shouldUseFallbackRenderer()).toBe(true)
  })

  it('treats only CI=true as CI', () => {
    process.env.CI = '1'

    expect(resolveRenderer(false)).toBe('default')
  })
})
