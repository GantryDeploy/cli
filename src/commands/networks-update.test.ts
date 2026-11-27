import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ confirm, input: vi.fn() }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerNetworksCommand } = await import('./networks')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const production = {
  id: 'Hd3nVx6R',
  name: 'Production',
  slug: 'production-vpc',
  region: 'us-east-1',
  provider: 'AWS',
  cloudAccountId: 'Jt5wPq8N',
  stackStatus: 'deployed',
  createdAt: '2026-10-30T12:00:00Z',
}

const networks = { networks: [production] }
const applying = {
  updateNetwork: {
    success: true,
    message: 'Network settings saved. Applying them now.',
    deploymentId: 'Qs8wFj3T',
  },
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerNetworksCommand(program)
  await program.parseAsync(['node', 'gantry', 'networks', ...args])
}

describe('networks update and repair', () => {
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
    it('moves to a NAT gateway per zone after confirming', async () => {
      isInteractive.mockReturnValue(true)
      confirm.mockResolvedValue(true)
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce(applying)

      await run(['update', 'production-vpc', '--aws-nat', 'per-az'])

      expect(logOutput()).toContain('A NAT gateway in every zone costs more')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        id: 'Hd3nVx6R',
        input: { aws: { natGatewayOption: 'PER_AZ' } },
      })
      expect(logOutput()).toContain('Deployment: Qs8wFj3T')
    })

    it('warns that removing NAT cuts off private subnets', async () => {
      isInteractive.mockReturnValue(true)
      confirm.mockResolvedValue(false)
      graphqlRequest.mockResolvedValueOnce(networks)

      await run(['update', 'production-vpc', '--aws-nat', 'none'])

      expect(logOutput()).toContain('Services in private subnets lose outbound internet access.')
      expect(logOutput()).toContain('Update cancelled.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('turns internet access off with --yes', async () => {
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce(applying)

      await run(['update', 'production-vpc', '--aws-no-internet', '-y'])

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        id: 'Hd3nVx6R',
        input: { aws: { enableInternetAccess: false } },
      })
    })

    it('renames without asking', async () => {
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce({
        updateNetwork: {
          success: true,
          message: 'Network updated successfully',
          deploymentId: null,
        },
      })

      await run(['update', 'production-vpc', '--name', 'Prod', '--slug', 'prod-vpc'])

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        id: 'Hd3nVx6R',
        input: { name: 'Prod', slug: 'prod-vpc' },
      })
    })

    it.each([
      [
        ['--aws-internet', '--aws-no-internet'],
        'Choose either --aws-internet or --aws-no-internet.',
      ],
      [['--aws-nat', 'double'], '--aws-nat must be none, single or per-az'],
      [[], 'Nothing to change. Pass at least one setting.'],
    ])('refuses %j before calling the API', async (flags, message) => {
      graphqlRequest.mockResolvedValueOnce(networks)

      await expect(run(['update', 'production-vpc', ...flags])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain(message)
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses AWS flags on a network in another cloud', async () => {
      graphqlRequest.mockResolvedValueOnce({ networks: [{ ...production, provider: 'GCP' }] })

      await expect(run(['update', 'production-vpc', '--aws-nat', 'single'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('--aws-nat only applies to AWS cloud accounts.')
    })

    it("prints the API's refusal", async () => {
      isInteractive.mockReturnValue(true)
      confirm.mockResolvedValue(true)
      graphqlRequest.mockResolvedValueOnce(networks).mockResolvedValueOnce({
        updateNetwork: {
          success: false,
          message: 'A private bastion in this network needs its outbound internet access.',
          deploymentId: null,
        },
      })

      await expect(run(['update', 'production-vpc', '--aws-nat', 'none'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('A private bastion in this network needs')
    })
  })

  describe('repair', () => {
    it('repairs the network by id', async () => {
      graphqlRequest
        .mockResolvedValueOnce(networks)
        .mockResolvedValueOnce({ repairResource: { success: true, message: 'Repair initiated' } })

      await run(['repair', 'production-vpc'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({ resourceType: 'NETWORK', id: 'Hd3nVx6R' })
      expect(logOutput()).toContain('gantry networks list')
    })

    it('refuses a network that does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce(networks)

      await expect(run(['repair', 'staging-vpc'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Network not found.')
    })
  })
})
