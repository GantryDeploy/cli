import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertSupportedNodeVersion, isSupportedNodeVersion } from './node-version'

describe('isSupportedNodeVersion', () => {
  it.each(['22.22.2', 'v22.22.2', '22.22.10', '22.23.0', '24.15.0', '24.22.1', '25.1.0', '26.0.0'])(
    'accepts %s',
    (version) => {
      expect(isSupportedNodeVersion(version)).toBe(true)
    }
  )

  it.each([
    '18.20.4',
    '20.19.0',
    '22.13.0',
    '22.21.9',
    '22.22.1',
    '23.11.0',
    '24.0.0',
    '24.14.9',
    'v20.17.0',
  ])('rejects %s', (version) => {
    expect(isSupportedNodeVersion(version)).toBe(false)
  })

  it.each(['', 'node', '22', '22.22', 'abc.def.ghi'])(
    'rejects unparseable version %j',
    (version) => {
      expect(isSupportedNodeVersion(version)).toBe(false)
    }
  )
})

describe('assertSupportedNodeVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing on a supported version', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assertSupportedNodeVersion('24.15.0')

    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('exits with a clear message on an unsupported version', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assertSupportedNodeVersion('20.19.0')

    expect(errorSpy).toHaveBeenCalledWith(
      'Gantry CLI requires Node.js ^22.22.2 || >=24.15.0. You are running Node.js 20.19.0.'
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('checks the running Node.js version by default', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assertSupportedNodeVersion()

    expect(exitSpy).toHaveBeenCalledTimes(isSupportedNodeVersion(process.versions.node) ? 0 : 1)
  })
})
