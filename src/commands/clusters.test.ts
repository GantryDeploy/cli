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

const { registerClustersCommand } = await import('./clusters')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerClustersCommand(program)
  await program.parseAsync(['node', 'gantry', 'clusters', ...args])
}

const clusterTypes = {
  clusterTypes: [
    {
      type: 'ECS',
      displayName: 'Amazon ECS',
      provider: 'aws',
      description: 'Managed containers\x1b]0;pwned\x07',
      guidance: null,
    },
  ],
}

const created = {
  success: true,
  cluster: {
    id: 'clu_3',
    name: 'Web',
    slug: 'web',
    type: 'ECS',
    status: 'PENDING',
    region: 'us-east-1',
  },
  deploymentId: 'n5qr8w',
}

const flags = [
  'create',
  '--cloud',
  'cloud_1',
  '--name',
  'Web',
  '--type',
  'ECS',
  '--region',
  'us-east-1',
  '--network',
  'h4nw8r',
]

describe('clusters command', () => {
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
    it('prints clusters with an uppercased status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        clusters: [
          {
            id: 'clu_3',
            name: 'Web\x1b]0;pwned\x07',
            slug: 'web',
            type: 'ECS',
            status: 'active',
            region: 'us-east-1',
            cloudAccountId: 'cloud_1',
            createdAt: '2026-06-01T12:00:00Z',
          },
        ],
      })

      await run(['list'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetClusters')
      expect(printed()).toContain('clu_3')
      expect(printed()).toContain('ECS')
      expect(printed()).toContain('ACTIVE')
      expect(printed()).toContain('us-east-1')
      expect(printed()).not.toContain('pwned')
    })

    it('reports when there are no clusters', async () => {
      graphqlRequest.mockResolvedValueOnce({ clusters: [] })

      await run(['list'])

      expect(printed()).toBe('No clusters found.')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Unauthorized')
    })
  })

  describe('types', () => {
    it('prints each type with a sanitised description', async () => {
      graphqlRequest.mockResolvedValueOnce(clusterTypes)

      await run(['types'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetClusterTypes')
      expect(printed()).toContain('Amazon ECS')
      expect(printed()).toContain('AWS')
      expect(printed()).toContain('Managed containers')
      expect(printed()).not.toContain('pwned')
    })

    it('prints the API error and exits non-zero', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Service unavailable'))

      await expect(run(['types'])).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Service unavailable')
    })
  })

  describe('create', () => {
    it('sends every flag without prompting', async () => {
      graphqlRequest.mockResolvedValueOnce({ createCluster: created })

      await run([...flags, '--slug', 'web-prod'])

      expect(input).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
      expect(selectNetwork).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('mutation CreateCluster')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Web',
          slug: 'web-prod',
          type: 'ECS',
          region: 'us-east-1',
          networkId: 'h4nw8r',
        },
      })
      expect(printed()).toContain('Cluster created: Web (web)')
      expect(printed()).toContain('ID: clu_3')
      expect(printed()).toContain('Deployment: n5qr8w')
    })

    it('prompts for everything, offering cluster types from the API', async () => {
      selectCloud.mockResolvedValueOnce('cloud_1')
      input.mockResolvedValueOnce('Worker Pool')
      graphqlRequest
        .mockResolvedValueOnce(clusterTypes)
        .mockResolvedValueOnce({ createCluster: { ...created, deploymentId: undefined } })
      select.mockResolvedValueOnce('ECS')
      selectRegion.mockResolvedValueOnce('ap-southeast-2')
      selectNetwork.mockResolvedValueOnce(undefined)

      await run(['create'])

      const { validate } = input.mock.calls[0]?.[0] as { validate: (v: string) => string | true }
      expect(validate('')).toBe('Name is required')
      expect(validate('w')).toBe(true)
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Cluster type:',
          choices: [{ name: 'Amazon ECS — Managed containers', value: 'ECS' }],
        })
      )
      expect(selectNetwork).toHaveBeenCalledWith('cloud_1', { allowNone: true })
      expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud_1',
          name: 'Worker Pool',
          slug: 'worker-pool',
          type: 'ECS',
          region: 'ap-southeast-2',
          networkId: undefined,
        },
      })
      expect(printed()).not.toContain('Deployment:')
    })

    it('strips terminal escapes from server IDs', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createCluster: {
          ...created,
          cluster: { ...created.cluster, id: 'clu_3\x1b]0;pwned\x07' },
          deploymentId: 'n5qr8w\x1b[2J',
        },
      })

      await run(flags)

      expect(printed()).toContain('ID: clu_3')
      expect(printed()).toContain('Deployment: n5qr8w')
      expect(printed()).not.toContain('pwned')
      expect(printed()).not.toContain('\x1b[2J')
    })

    it('exits with the server message when creation fails', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createCluster: { success: false, message: 'Network is not deployed' },
      })

      await expect(run(flags)).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Network is not deployed')
    })

    it('falls back to a generic message when no cluster is returned', async () => {
      graphqlRequest.mockResolvedValueOnce({ createCluster: { success: true } })

      await expect(run(flags)).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create cluster')
    })

    it('prints the API error when the mutation throws', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Invalid region'))

      await expect(run(flags)).rejects.toThrow('process.exit(1)')

      expect(printedErrors()).toContain('Invalid region')
    })

    it.each(['EKS', 'ecs'])(
      'rejects the unknown --type %j without calling the API',
      async (type) => {
        await expect(
          run([
            'create',
            '--cloud',
            'cloud_1',
            '--name',
            'Web',
            '--type',
            type,
            '--region',
            'us-east-1',
          ])
        ).rejects.toThrow('process.exit(1)')

        expect(graphqlRequest).not.toHaveBeenCalled()
        expect(printedErrors()).toContain('Unknown cluster type.')
      }
    )
  })
})
