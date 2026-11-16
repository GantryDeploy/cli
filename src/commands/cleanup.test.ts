import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import type { CleanupItem } from './cleanup'

const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn(() => true))

vi.mock('@inquirer/prompts', () => ({ confirm }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { cleanupHint, registerCleanupCommand } = await import('./cleanup')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerCleanupCommand(program)
  await program.parseAsync(['node', 'gantry', ...args])
}

const moved: CleanupItem = {
  id: 'e7kq2m',
  kind: 'PREVIOUS_ROUTING',
  description: 'Previous routing for shop.example.com',
  readyToRemove: true,
  hostnames: [
    { hostname: 'shop.example.com', dnsMoved: true, dnsTarget: 'd111abcdef8.cloudfront.net' },
  ],
}

const notMoved: CleanupItem = {
  id: 'e9xr4p',
  kind: 'PREVIOUS_ROUTING',
  description: 'Previous routing for api.example.com',
  readyToRemove: false,
  hostnames: [
    {
      hostname: 'api.example.com',
      dnsMoved: false,
      dnsTarget: 'd-4f7a2b9c1e.execute-api.us-east-2.amazonaws.com',
    },
  ],
}

describe('cleanupHint', () => {
  it('says nothing when there is nothing to clean up', () => {
    expect(cleanupHint([])).toEqual([])
  })

  it('lists the items and the DNS records still to change', () => {
    expect(cleanupHint([moved, notMoved])).toEqual([
      '2 infrastructure items are waiting to be cleaned up:',
      '  Previous routing for shop.example.com',
      '  Previous routing for api.example.com',
      'DNS still points at the previous routing for: api.example.com (point it at d-4f7a2b9c1e.execute-api.us-east-2.amazonaws.com)',
      'Run "gantry cleanup" once DNS has moved.',
    ])
  })
})

describe('cleanup command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    isInteractive.mockReturnValue(true)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const printed = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  const printedErrors = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n')

  it('reports when there is nothing to clean up', async () => {
    graphqlRequest.mockResolvedValueOnce({ cleanupItems: [] })

    await run(['cleanup'])

    expect(printed()).toContain('Nothing to clean up.')
    expect(graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('removes the listed items once the user confirms', async () => {
    graphqlRequest
      .mockResolvedValueOnce({ cleanupItems: [moved] })
      .mockResolvedValueOnce({ cleanUp: { success: true, message: null, removed: ['e7kq2m'] } })
    confirm.mockResolvedValueOnce(true)

    await run(['cleanup'])

    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ ids: ['e7kq2m'] })
    expect(printed()).toContain('Removing 1 item.')
  })

  it('warns before removing routing that DNS still points at', async () => {
    graphqlRequest.mockResolvedValueOnce({ cleanupItems: [notMoved] })
    confirm.mockResolvedValueOnce(false)

    await run(['cleanup'])

    expect(printed()).toContain('Traffic may still reach the previous routing for api.example.com')
    expect(graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses to remove without --yes when there is no terminal to confirm in', async () => {
    isInteractive.mockReturnValue(false)
    graphqlRequest.mockResolvedValueOnce({ cleanupItems: [moved] })

    await expect(run(['cleanup'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('Re-run with --yes to confirm.')
    expect(graphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('removes without a prompt when given --yes', async () => {
    graphqlRequest
      .mockResolvedValueOnce({ cleanupItems: [notMoved] })
      .mockResolvedValueOnce({ cleanUp: { success: true, message: null, removed: ['e9xr4p'] } })

    await run(['cleanup', '--yes'])

    expect(confirm).not.toHaveBeenCalled()
    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ ids: ['e9xr4p'] })
  })

  it('shows the API message when removal fails', async () => {
    graphqlRequest.mockResolvedValueOnce({ cleanupItems: [moved] }).mockResolvedValueOnce({
      cleanUp: {
        success: false,
        message: 'There was an error while deleting the routing.',
        removed: [],
      },
    })

    await expect(run(['cleanup', '--yes'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('There was an error while deleting the routing.')
  })
})
