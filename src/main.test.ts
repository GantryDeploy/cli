import { readFileSync } from 'fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

describe('gantry --version', () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
  })

  it('prints the version from package.json', async () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
    ) as { version: string }
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
    process.argv = ['node', 'gantry', '--version']

    await expect(import('./main')).rejects.toThrow(new ExitError(0))

    expect(writeSpy).toHaveBeenCalledWith(`${version}\n`)
  })
})
