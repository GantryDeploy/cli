import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { graphqlRequest } from '../lib/client'
import { printError } from '../lib/output'

import { registerRegionsCommand } from './regions'

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

describe('regions command', () => {
  let logSpy: MockInstance

  async function regions(args: string[] = []) {
    const program = new Command()
    program.exitOverride()
    registerRegionsCommand(program)
    await program.parseAsync(['node', 'gantry', 'regions', ...args])
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

  it('lists the AWS regions by default', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      cloudRegions: [{ code: 'us-east-1', name: 'US East (N. Virginia)' }],
    })

    await regions()

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ provider: 'aws' })
    expect(String(logSpy.mock.calls[0][0])).toMatch(/us-east-1.*US East \(N\. Virginia\)/)
  })

  it('asks for the given provider and says so when it has no regions', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({ cloudRegions: [] })

    await regions(['--provider', 'gcp'])

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ provider: 'gcp' })
    expect(logSpy).toHaveBeenCalledWith('No regions found for this provider.')
  })

  it('exits with the formatted API error', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(new Error('Forbidden.'))

    await expect(regions()).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Forbidden.')
  })
})
