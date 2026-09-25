import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const selectCloud = vi.hoisted(() => vi.fn())
const selectNetwork = vi.hoisted(() => vi.fn())
const selectRegion = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ selectCloud, selectNetwork, selectRegion }))

const { registerLoadBalancersCommand } = await import('./load-balancers')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerLoadBalancersCommand(program)
  await program.parseAsync(['node', 'gantry', ...args])
}

const lbTypes = {
  loadBalancerTypes: [
    {
      type: 'APPLICATION',
      displayName: 'Application Load Balancer',
      provider: 'aws',
      description: 'Regional HTTP(S) load balancer\x1b]0;pwned\x07',
      guidance: 'Use for ECS services',
      requiresNetwork: true,
      requiresRegion: true,
    },
    {
      type: 'GLOBAL',
      displayName: 'CloudFront',
      provider: 'aws',
      description: 'Global edge distribution',
      guidance: 'Use for static sites',
      requiresNetwork: false,
      requiresRegion: false,
    },
  ],
}

const created = {
  success: true,
  loadBalancer: {
    id: 'l5zq8c',
    name: 'Public ALB',
    slug: 'public-alb',
    type: 'APPLICATION',
    status: 'PENDING',
  },
  deploymentId: 'z3cy6t',
}

const flags = [
  'lb',
  'create',
  '--cloud',
  'cloud_1',
  '--name',
  'Public ALB',
  '--type',
  'APPLICATION',
  '--network',
  'h4nw8r',
  '--region',
  'us-east-1',
]

describe('load-balancers command', () => {
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
    it('prints load balancers with an uppercased status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        loadBalancers: [
          {
            id: 'l5zq8c',
            name: 'Public ALB\x1b]0;pwned\x07',
            slug: 'public-alb',
            type: 'APPLICATION',
            status: 'active',
            cloudAccountId: 'cloud_1',
            createdAt: '2026-07-04T12:00:00Z',
          },
        ],
      })

      await run(['load-balancers', 'list'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetLoadBalancers')
      expect(printed()).toContain('l5zq8c')
      expect(printed()).toContain('APPLICATION')
      expect(printed()).toContain('ACTIVE')
      expect(printed()).toContain('Jul 4, 2026')
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no load balancers', async () => {
      graphqlRequest.mockResolvedValueOnce({ loadBalancers: [] })

      await run(['lb', 'list'])

      expect(printed()).toBe('No load balancers found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['lb', 'list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('types', () => {
    it('prints each type with its network and region requirements', async () => {
      graphqlRequest.mockResolvedValueOnce(lbTypes)

      await run(['lb', 'types'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetLoadBalancerTypes')
      expect(printed()).toContain('Application Load Balancer')
      expect(printed()).toContain('CloudFront')
      expect(printed()).toContain('Required')
      expect(stripVTControlCharacters(printed())).toMatch(/│ -\s+│ -\s+│/)
      expect(printed()).not.toContain('pwned')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Service unavailable'))

      await expect(run(['lb', 'types'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Service unavailable')
    })
  })

  describe('create', () => {
    it('sends every flag without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ createLoadBalancer: created })

      await run([...flags, '--slug', 'alb'])

      expect(input).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(selectNetwork).not.toHaveBeenCalled()
      expect(selectRegion).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateLoadBalancer')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Public ALB',
          slug: 'alb',
          type: 'APPLICATION',
          networkId: 'h4nw8r',
          providerData: { region: 'us-east-1' },
        },
      })
      expect(printed()).toContain('Load balancer created: Public ALB (public-alb)')
      expect(printed()).toContain('ID: l5zq8c')
      expect(printed()).toContain('Deployment: z3cy6t')
    })

    it('requires a network and region when the chosen type needs them', async () => {
      selectCloud.mockResolvedValueOnce('cloud_1')
      input.mockResolvedValueOnce('Public ALB')
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: { ...created, deploymentId: undefined } })
      select.mockResolvedValueOnce('APPLICATION')
      selectNetwork.mockResolvedValueOnce('h4nw8r')
      selectRegion.mockResolvedValueOnce('eu-west-1')

      await run(['lb', 'create'])

      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('')).toBe('Name is required')
      expect(validate('a')).toBe(true)
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Load balancer type:',
          choices: [
            {
              name: 'Application Load Balancer — Regional HTTP(S) load balancer',
              value: 'APPLICATION',
            },
            { name: 'CloudFront — Global edge distribution', value: 'GLOBAL' },
          ],
        })
      )
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Public ALB',
          slug: 'public-alb',
          type: 'APPLICATION',
          networkId: 'h4nw8r',
          providerData: { region: 'eu-west-1' },
        },
      })
      expect(printed()).not.toContain('Deployment:')
    })

    it('makes the network optional and skips the region for a global type', async () => {
      input.mockResolvedValueOnce('Edge')
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })
      select.mockResolvedValueOnce('GLOBAL')
      selectNetwork.mockResolvedValueOnce(undefined)

      await run(['lb', 'create', '--cloud', 'cloud_1'])

      expect(selectCloud).not.toHaveBeenCalled()
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: true })
      expect(selectRegion).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Edge',
          slug: 'edge',
          type: 'GLOBAL',
          networkId: undefined,
          providerData: undefined,
        },
      })
    })

    it('treats an unknown selected type as having no requirements', async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })
      select.mockResolvedValueOnce('GATEWAY_HTTP')
      selectNetwork.mockResolvedValueOnce(undefined)

      await run(['lb', 'create', '--cloud', 'cloud_1', '--name', 'Gateway'])

      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: true })
      expect(selectRegion).not.toHaveBeenCalled()
    })

    it('strips terminal escapes from server IDs', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createLoadBalancer: {
          ...created,
          loadBalancer: { ...created.loadBalancer, id: 'l5zq8c\x1b]0;pwned\x07' },
          deploymentId: 'z3cy6t\x1b[2J',
        },
      })

      await run(flags)

      expect(printed()).toContain('ID: l5zq8c')
      expect(printed()).toContain('Deployment: z3cy6t')
      expect(printed()).not.toContain('pwned')
      expect(printed()).not.toContain('\x1b[2J')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createLoadBalancer: { success: false, message: 'ALB requires a network' },
      })

      await expect(run(flags)).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('ALB requires a network')
    })

    it('falls back to a generic message when no load balancer is returned', async () => {
      graphqlRequest.mockResolvedValueOnce({ createLoadBalancer: { success: true } })

      await expect(run(flags)).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create load balancer')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Quota exceeded'))

      await expect(run(flags)).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Quota exceeded')
    })

    it.each(['NETWORK', 'application'])(
      'rejects the unknown --type %j without calling the API',
      async (type) => {
        await expect(
          run(['lb', 'create', '--cloud', 'cloud_1', '--name', 'Public ALB', '--type', type])
        ).rejects.toThrow('process.exit(1)')

        expect(graphqlRequest).not.toHaveBeenCalled()
        expect(selectNetwork).not.toHaveBeenCalled()
        expect(printedErrors()).toContain('Unknown load balancer type.')
      }
    )
  })
})
