import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const resolveCloud = vi.hoisted(() =>
  vi.fn((id?: string) => Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' }))
)
const selectNetwork = vi.hoisted(() => vi.fn())
const selectRegion = vi.hoisted(() => vi.fn())

vi.mock('@inquirer/prompts', () => ({ input, select }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/interactive-prompts', () => ({ resolveCloud, selectNetwork, selectRegion }))

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
    visibility: 'PUBLIC',
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
            visibility: 'INTERNAL',
            region: 'us-east-2',
            endpoint: 'gantry-web-1234567890.us-east-2.elb.amazonaws.com',
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
      expect(printed()).toContain('Visibility')
      expect(printed()).toContain('internal')
      expect(printed()).toContain('ACTIVE')
      expect(printed()).toContain('Jul 4, 2026')
      expect(printed()).toContain('gantry-web-1234567890.us-east-2.elb.amazonaws.com')
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
    it("prints each of the cloud's types with its network and region requirements", async () => {
      graphqlRequest.mockResolvedValueOnce(lbTypes)

      await run(['lb', 'types', '--cloud', 'cloud_1'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetLoadBalancerTypes')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ provider: 'AWS' })
      expect(printed()).toContain('Application Load Balancer')
      expect(printed()).toContain('CloudFront')
      expect(printed()).toContain('Required')
      expect(stripVTControlCharacters(printed())).toMatch(/│ -\s+│ -\s+│/)
      expect(printed()).not.toContain('pwned')
    })

    it('says when the cloud has no load balancer types', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce({ loadBalancerTypes: [] })

      await run(['lb', 'types', '--cloud', 'ca_9mx4'])

      expect(printed()).toContain('This cloud has no load balancer types.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Service unavailable'))

      await expect(run(['lb', 'types'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Service unavailable')
    })
  })

  describe('create', () => {
    it('sends every flag without prompting', async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })

      await run([
        ...flags,
        '--slug',
        'alb',
        '--aws-certificate-arn',
        'arn:aws:acm:us-east-1:123456789012:certificate/4f2a',
      ])

      expect(input).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(selectNetwork).not.toHaveBeenCalled()
      expect(selectRegion).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ provider: 'AWS' })
      expect(String(graphqlRequest.mock.calls[1]?.[0])).toContain('mutation CreateLoadBalancer')
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Public ALB',
          slug: 'alb',
          type: 'APPLICATION',
          visibility: 'PUBLIC',
          networkId: 'h4nw8r',
          region: 'us-east-1',
          aws: { defaultSslCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/4f2a' },
        },
      })
      expect(printed()).toContain('Load balancer created: Public ALB (public-alb)')
      expect(printed()).toContain('ID: l5zq8c')
      expect(printed()).toContain('Deployment: z3cy6t')
      expect(printed()).toContain('Visibility: public')
    })

    it('requires a network for a type that needs one and takes its region from it', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'cloud_1', provider: 'AWS' })
      input.mockResolvedValueOnce('Public ALB')
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: { ...created, deploymentId: undefined } })
      select.mockResolvedValueOnce('APPLICATION')
      selectNetwork.mockResolvedValueOnce('h4nw8r')

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
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: false })
      expect(selectRegion).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Public ALB',
          slug: 'public-alb',
          type: 'APPLICATION',
          visibility: 'PUBLIC',
          networkId: 'h4nw8r',
          region: undefined,
        },
      })
      expect(printed()).not.toContain('Deployment:')
    })

    it("asks for a region in the cloud's list when a regional type has no network", async () => {
      graphqlRequest
        .mockResolvedValueOnce({
          loadBalancerTypes: [{ ...lbTypes.loadBalancerTypes[0], requiresNetwork: false }],
        })
        .mockResolvedValueOnce({ createLoadBalancer: created })
      selectNetwork.mockResolvedValueOnce(undefined)
      selectRegion.mockResolvedValueOnce('eu-west-1')

      await run(['lb', 'create', '--cloud', 'cloud_1', '--name', 'Edge', '--type', 'APPLICATION'])

      expect(selectRegion).toHaveBeenCalledWith('AWS')
      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({ input: { region: 'eu-west-1' } })
    })

    it('makes the network optional and skips the region for a global type', async () => {
      input.mockResolvedValueOnce('Edge')
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })
      select.mockResolvedValueOnce('GLOBAL')
      selectNetwork.mockResolvedValueOnce(undefined)

      await run(['lb', 'create', '--cloud', 'cloud_1'])

      expect(resolveCloud).toHaveBeenCalledWith('cloud_1')
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: true })
      expect(selectRegion).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Edge',
          slug: 'edge',
          type: 'GLOBAL',
          visibility: 'PUBLIC',
          networkId: undefined,
          region: undefined,
        },
      })
    })

    it('creates an internal load balancer with --internal', async () => {
      graphqlRequest.mockResolvedValueOnce(lbTypes).mockResolvedValueOnce({
        createLoadBalancer: {
          ...created,
          loadBalancer: { ...created.loadBalancer, visibility: 'INTERNAL' },
        },
      })

      await run([...flags, '--internal'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: { visibility: 'INTERNAL' },
      })
      expect(printed()).toContain('Visibility: internal')
    })

    it("looks up a --type's network and region needs before prompting", async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })
      selectNetwork.mockResolvedValueOnce('h4nw8r')

      await run(['lb', 'create', '--cloud', 'cloud_1', '--name', 'Web', '--type', 'APPLICATION'])

      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: false })
    })

    it('refuses a type the cloud does not offer', async () => {
      graphqlRequest.mockResolvedValueOnce({
        loadBalancerTypes: lbTypes.loadBalancerTypes.filter((t) => t.type === 'APPLICATION'),
      })

      await expect(
        run(['lb', 'create', '--cloud', 'cloud_1', '--name', 'Global', '--type', 'GLOBAL'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('That load balancer type is not offered on this cloud.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses a cloud with no load balancer types', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce({ loadBalancerTypes: [] })

      await expect(run(['lb', 'create', '--cloud', 'ca_9mx4'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('The load balancer configuration is not valid.')
    })

    it('refuses AWS flags on another cloud', async () => {
      resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })

      await expect(
        run(['lb', 'create', '--cloud', 'ca_9mx4', '--aws-certificate-arn', 'arn:aws:acm:x'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('--aws-certificate-arn only applies to AWS cloud accounts.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('strips terminal escapes from server IDs', async () => {
      graphqlRequest.mockResolvedValueOnce(lbTypes).mockResolvedValueOnce({
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
      graphqlRequest.mockResolvedValueOnce(lbTypes).mockResolvedValueOnce({
        createLoadBalancer: { success: false, message: 'ALB requires a network' },
      })

      await expect(run(flags)).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('ALB requires a network')
    })

    it('falls back to a generic message when no load balancer is returned', async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: { success: true } })

      await expect(run(flags)).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create load balancer')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockRejectedValueOnce(new Error('Quota exceeded'))

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

    it('sends allowed address ranges and CloudFront only', async () => {
      graphqlRequest
        .mockResolvedValueOnce(lbTypes)
        .mockResolvedValueOnce({ createLoadBalancer: created })

      await run([
        ...flags,
        '--allowed-cidr',
        '203.0.113.0/24',
        '--allowed-cidr',
        '2001:db8::/32',
        '--aws-cdn-only',
      ])

      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: { allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'], aws: { cdnOnly: true } },
      })
    })
  })

  describe('firewall', () => {
    it('attaches a firewall and prints the deployment', async () => {
      graphqlRequest.mockResolvedValueOnce({
        setLoadBalancerFirewall: { success: true, deploymentId: 'z3cy6t' },
      })

      await run(['lb', 'firewall', 'l5zq8c', 'fw3q9x'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: { id: 'l5zq8c', firewallId: 'fw3q9x' },
      })
      expect(printed()).toContain('Deployment: z3cy6t')
    })

    it('detaches the firewall with --none', async () => {
      graphqlRequest.mockResolvedValueOnce({ setLoadBalancerFirewall: { success: true } })

      await run(['lb', 'firewall', 'l5zq8c', '--none'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: { id: 'l5zq8c', firewallId: null },
      })
    })

    it.each([
      ['neither a firewall nor --none', ['lb', 'firewall', 'l5zq8c']],
      ['both a firewall and --none', ['lb', 'firewall', 'l5zq8c', 'fw3q9x', '--none']],
    ])('refuses %s without calling the API', async (_case, args) => {
      await expect(run(args)).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).not.toHaveBeenCalled()
      expect(printedErrors()).toContain('Give a firewall ID to attach, or --none to detach.')
    })

    it('prints the server message when the firewall cannot attach', async () => {
      graphqlRequest.mockResolvedValueOnce({
        setLoadBalancerFirewall: {
          success: false,
          message: 'The firewall configuration is not valid.',
        },
      })

      await expect(run(['lb', 'firewall', 'l5zq8c', 'fw3q9x'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('The firewall configuration is not valid.')
    })
  })
})
