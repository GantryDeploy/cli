import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const selectCloud = vi.hoisted(() => vi.fn())
const selectRegion = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ input }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ selectCloud, selectRegion }))

const { registerNetworksCommand } = await import('./networks')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerNetworksCommand(program)
  await program.parseAsync(['node', 'gantry', 'networks', ...args])
}

describe('networks command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  function printedErrors(): string {
    return errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  describe('list', () => {
    it('prints each network with its uppercased stack status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        networks: [
          {
            id: 'h4nw8r',
            name: 'Production VPC\x1b]0;pwned\x07',
            slug: 'production-vpc',
            region: 'us-east-1',
            cloudAccountId: 'cloud_1',
            stackStatus: 'deployed',
            createdAt: '2026-02-01T12:00:00Z',
          },
          {
            id: 'b6yt2q',
            name: 'Staging',
            slug: 'staging',
            region: 'eu-west-1',
            cloudAccountId: 'cloud_1',
            createdAt: '2026-02-02T12:00:00Z',
          },
        ],
      })

      await run(['list'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetNetworks')
      expect(printed()).toContain('production-vpc')
      expect(printed()).toContain('DEPLOYED')
      expect(printed()).toContain('UNKNOWN')
      expect(printed()).toContain('eu-west-1')
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no networks', async () => {
      graphqlRequest.mockResolvedValueOnce({ networks: [] })

      await run(['list'])

      expect(printed()).toBe('No networks found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('create', () => {
    const created = {
      success: true,
      network: { id: 'x9mf3d', name: 'Production VPC', slug: 'prod', region: 'us-east-1' },
      deploymentId: 'm2xa5q',
    }

    it('sends every flag verbatim without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ createNetwork: created })

      await run([
        'create',
        '--cloud',
        'cloud_1',
        '--name',
        'Production VPC',
        '--slug',
        'prod',
        '--region',
        'us-east-1',
      ])

      expect(selectCloud).not.toHaveBeenCalled()
      expect(selectRegion).not.toHaveBeenCalled()
      expect(input).not.toHaveBeenCalled()
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateNetwork')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Production VPC',
          slug: 'prod',
          region: 'us-east-1',
        },
      })
      expect(printed()).toContain('Network created: Production VPC (prod)')
      expect(printed()).toContain('ID: x9mf3d')
      expect(printed()).toContain('Deployment: m2xa5q')
    })

    it('prompts for missing values and derives the slug from the name', async () => {
      selectCloud.mockResolvedValueOnce('cloud_1')
      selectRegion.mockResolvedValueOnce('eu-west-1')
      input.mockResolvedValueOnce('Staging Network')
      graphqlRequest.mockResolvedValueOnce({
        createNetwork: { ...created, deploymentId: undefined },
      })

      await run(['create', '--slug', ''])

      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate(' ')).toBe('Name is required')
      expect(validate('ok')).toBe(true)
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Staging Network',
          slug: 'staging-network',
          region: 'eu-west-1',
        },
      })
      expect(printed()).not.toContain('Deployment:')
    })

    it('strips terminal escapes from server IDs', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createNetwork: {
          ...created,
          network: { ...created.network, id: 'x9mf3d\x1b]0;pwned\x07' },
          deploymentId: 'm2xa5q\x1b[2J',
        },
      })

      await run(['create', '--cloud', 'c', '--name', 'n', '--region', 'us-east-1'])

      expect(printed()).toContain('ID: x9mf3d')
      expect(printed()).toContain('Deployment: m2xa5q')
      expect(printed()).not.toContain('pwned')
      expect(printed()).not.toContain('\x1b[2J')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createNetwork: { success: false, message: 'CIDR block overlaps' },
      })

      await expect(
        run(['create', '--cloud', 'c', '--name', 'n', '--region', 'us-east-1'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('CIDR block overlaps')
    })

    it('falls back to a generic message when no network is returned', async () => {
      graphqlRequest.mockResolvedValueOnce({ createNetwork: { success: true } })

      await expect(
        run(['create', '--cloud', 'c', '--name', 'n', '--region', 'us-east-1'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create network')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Rate limited'))

      await expect(
        run(['create', '--cloud', 'c', '--name', 'n', '--region', 'us-east-1'])
      ).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Rate limited')
    })
  })
})
