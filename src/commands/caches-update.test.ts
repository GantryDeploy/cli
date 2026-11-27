import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ confirm, input: vi.fn(), select: vi.fn() }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerCachesCommand } = await import('./caches')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const sessions = {
  id: 'Rm4tKw8Q',
  name: 'Sessions',
  slug: 'sessions',
  engine: 'VALKEY',
  status: 'ACTIVE',
  cloudAccountId: 'Jt5wPq8N',
  networkId: 'Hd3nVx6R',
  provider: 'AWS',
  endpoint: 'sessions.abc123.cache.amazonaws.com',
  port: 6379,
  createdAt: '2026-11-02T12:00:00Z',
}

const caches = { caches: [sessions] }
const applying = {
  updateCache: {
    success: true,
    message: 'Cache settings saved. Applying them now.',
    deploymentId: 'Vb7nHq2X',
  },
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerCachesCommand(program)
  await program.parseAsync(['node', 'gantry', 'caches', ...args])
}

describe('caches update and repair', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance
  const logOutput = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('update', () => {
    it('resizes after confirming and prints the deployment', async () => {
      isInteractive.mockReturnValue(true)
      confirm.mockResolvedValue(true)
      graphqlRequest.mockResolvedValueOnce(caches).mockResolvedValueOnce(applying)

      await run(['update', 'sessions', '--size', 'cache.t4g.medium'])

      expect(confirm).toHaveBeenCalledWith({ message: 'Update "sessions"?', default: false })
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        id: 'Rm4tKw8Q',
        input: { size: 'cache.t4g.medium' },
      })
      expect(logOutput()).toContain('Deployment: Vb7nHq2X')
    })

    it('skips the prompt with --yes', async () => {
      graphqlRequest.mockResolvedValueOnce(caches).mockResolvedValueOnce(applying)

      await run(['update', 'sessions', '--aws-replicas', '2', '-y'])

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        id: 'Rm4tKw8Q',
        input: { aws: { replicasPerNodeGroup: 2 } },
      })
    })

    it('stops when the confirmation is declined', async () => {
      isInteractive.mockReturnValue(true)
      confirm.mockResolvedValue(false)
      graphqlRequest.mockResolvedValueOnce(caches)

      await run(['update', 'sessions', '--size', 'cache.t4g.medium'])

      expect(logOutput()).toContain('Update cancelled.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('asks for --yes where there is no terminal', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest.mockResolvedValueOnce(caches)

      await expect(run(['update', 'sessions', '--size', 'cache.t4g.medium'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('Re-run with --yes to confirm.')
    })

    it('refuses AWS flags on a cache in another cloud', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [{ ...sessions, provider: 'GCP' }] })

      await expect(run(['update', 'sessions', '--aws-replicas', '2', '-y'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('--aws-replicas only applies to AWS cloud accounts.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it("prints the API's refusal", async () => {
      graphqlRequest.mockResolvedValueOnce(caches).mockResolvedValueOnce({
        updateCache: {
          success: false,
          message: "Deployment mode can't be changed after the cache is created.",
          deploymentId: null,
        },
      })

      await expect(run(['update', 'sessions', '--name', 'Session store'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain("Deployment mode can't be changed")
    })

    it('refuses an update with nothing to change before calling the API', async () => {
      await expect(run(['update', 'sessions'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Nothing to change.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })
  })

  describe('repair', () => {
    it('repairs the cache by id', async () => {
      graphqlRequest
        .mockResolvedValueOnce(caches)
        .mockResolvedValueOnce({ repairResource: { success: true, message: 'Repair initiated' } })

      await run(['repair', 'sessions'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ resourceType: 'CACHE', id: 'Rm4tKw8Q' })
      expect(logOutput()).toContain('Repairing sessions.')
    })

    it('refuses a cache that does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce(caches)

      await expect(run(['repair', 'queue-cache'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Cache not found.')
    })
  })
})
