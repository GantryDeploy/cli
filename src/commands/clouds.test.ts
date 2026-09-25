import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { graphqlRequest } from '../lib/client'
import { printError } from '../lib/output'

import { registerCloudsCommand } from './clouds'

vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: vi.fn(),
}))
vi.mock(import('../lib/output'), async (importOriginal) => ({
  ...(await importOriginal()),
  printError: vi.fn(),
}))

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

describe('clouds command', () => {
  let logSpy: MockInstance

  async function clouds() {
    const program = new Command()
    program.exitOverride()
    registerCloudsCommand(program)
    await program.parseAsync(['node', 'gantry', 'clouds'])
  }

  beforeEach(() => {
    vi.mocked(graphqlRequest).mockReset()
    vi.mocked(printError).mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists cloud accounts with their provider upper-cased', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      clouds: [
        { id: 'ca_1', name: 'Prod\x1b[2J', provider: 'aws', createdAt: '2026-03-15T12:00:00Z' },
      ],
    })

    await clouds()

    const table = String(logSpy.mock.calls[0][0])
    expect(table).toMatch(/ca_1.*Prod.*AWS.*Mar 15, 2026/)
    expect(table).not.toContain('\x1b[2J')
  })

  it('says so when there are none', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({ clouds: [] })

    await clouds()

    expect(logSpy).toHaveBeenCalledWith('No cloud accounts found.')
  })

  it('exits with the formatted API error', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(new Error('Not authenticated.'))

    await expect(clouds()).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Not authenticated.')
  })
})
