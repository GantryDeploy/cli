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

  it('lists the regions of the given provider', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({
      cloudRegions: [{ code: 'us-central1', name: 'Iowa' }],
    })

    await regions(['--provider', 'gcp'])

    expect(vi.mocked(graphqlRequest).mock.calls[0][1]).toEqual({ provider: 'GCP' })
    expect(String(logSpy.mock.calls[0][0])).toMatch(/us-central1.*Iowa/)
  })

  it("lists the regions of a cloud account's cloud", async () => {
    vi.mocked(graphqlRequest)
      .mockResolvedValueOnce({ clouds: [{ id: 'ca_7kq2', name: 'Production', provider: 'AWS' }] })
      .mockResolvedValueOnce({
        cloudRegions: [{ code: 'us-east-1', name: 'US East (N. Virginia)' }],
      })

    await regions(['--cloud', 'ca_7kq2'])

    expect(vi.mocked(graphqlRequest).mock.calls[1][1]).toEqual({ provider: 'AWS' })
    expect(String(logSpy.mock.calls[0][0])).toMatch(/us-east-1.*US East \(N\. Virginia\)/)
  })

  it('says so when the cloud has no regions', async () => {
    vi.mocked(graphqlRequest).mockResolvedValue({ cloudRegions: [] })

    await regions(['--provider', 'vultr'])

    expect(logSpy).toHaveBeenCalledWith('No regions found for this cloud.')
  })

  it.each([
    [['--cloud', 'ca_7kq2', '--provider', 'aws'], 'Pass either --cloud or --provider, not both.'],
    [[], 'Pass --cloud <id> or --provider <provider>.'],
  ])('refuses %j without calling the API', async (args, message) => {
    await expect(regions(args)).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith(message)
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('refuses an unknown provider', async () => {
    await expect(regions(['--provider', 'heroku'])).rejects.toThrow(ExitError)
    expect(vi.mocked(printError).mock.calls[0][0]).toMatch(/^Unknown cloud provider\./)
  })

  it('exits with the formatted API error', async () => {
    vi.mocked(graphqlRequest).mockRejectedValue(new Error('Forbidden.'))

    await expect(regions(['--provider', 'aws'])).rejects.toThrow(ExitError)
    expect(printError).toHaveBeenCalledWith('Forbidden.')
  })
})
