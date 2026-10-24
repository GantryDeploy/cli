import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const spinner = vi.hoisted(() => ({
  fail: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  succeed: vi.fn(),
}))
const promptMocks = vi.hoisted(() => ({ input: vi.fn(), select: vi.fn() }))
const bastionMocks = vi.hoisted(() => ({
  activeOnly: vi.fn(),
  createBastionInteractive: vi.fn(),
  fetchBastionCredentials: vi.fn(),
  selectBastion: vi.fn(),
}))
const tunnelMocks = vi.hoisted(() => ({ openDirectTunnel: vi.fn(), openSshTunnel: vi.fn() }))
const cloudMocks = vi.hoisted(() => ({ selectCloud: vi.fn(), selectNetwork: vi.fn() }))

vi.mock('ora', () => ({ default: () => ({ ...spinner, start: () => spinner }) }))
vi.mock('@inquirer/prompts', () => promptMocks)
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/bastion-prompts', () => bastionMocks)
vi.mock('../lib/interactive-prompts', () => cloudMocks)
vi.mock('../lib/ssh-tunnel', () => tunnelMocks)

const { registerCachesCommand } = await import('./caches')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const versions = [
  { engine: 'valkey', version: '8.0', family: 'valkey8', supportedModes: ['serverless'] },
  { engine: 'valkey', version: '7.2', family: 'valkey7', supportedModes: ['node-based'] },
  {
    engine: 'valkey',
    version: '7.1',
    family: 'valkey7',
    supportedModes: ['serverless', 'node-based'],
  },
]

const cache = {
  id: 'cache-id-1',
  name: 'Sessions',
  slug: 'sessions',
  engine: 'VALKEY',
  status: 'ACTIVE',
  cloudAccountId: 'cloud-1',
  networkId: 'h4nw8r',
  endpoint: null,
  createdAt: '2026-01-01T00:00:00Z',
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerCachesCommand(program)
  await program.parseAsync(['node', 'gantry', 'caches', ...args])
}

function sentQuery(call: number): string {
  return String(graphqlRequest.mock.calls[call]?.[0])
}

function sentVariables(call: number): unknown {
  return graphqlRequest.mock.calls[call]?.[1]
}

const reachableCache = {
  ...cache,
  endpoint: 'sessions.abc123.use1.cache.amazonaws.com:6379',
  port: 6379,
}

const bastion = {
  bastion: { id: 'r3bq9m', instanceId: 'i-0abc123', publicIp: '203.0.113.10' },
}

describe('caches command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance

  const logLines = () => logSpy.mock.calls.map((c) => c.map(String).join(' '))
  const logOutput = () => logLines().join('\n')
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

  describe('engine-versions', () => {
    it('does not send deploymentMode and filters by supportedModes client-side', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheEngineVersions: versions })

      await run([
        'engine-versions',
        '--engine',
        'valkey',
        '--region',
        'us-east-1',
        '--mode',
        'serverless',
      ])

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(sentQuery(0)).toContain(
        'query GetCacheEngineVersions($engine: String, $region: String)'
      )
      expect(sentQuery(0)).not.toContain('deploymentMode')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ engine: 'valkey', region: 'us-east-1' })

      const output = String(logSpy.mock.calls[0]?.[0])
      expect(output).toContain('8.0')
      expect(output).toContain('7.1')
      expect(output).not.toContain('7.2')
    })

    it('lists every version when no mode is given', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheEngineVersions: versions })

      await run(['engine-versions'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({})
      const output = String(logSpy.mock.calls[0]?.[0])
      expect(output).toContain('8.0')
      expect(output).toContain('7.2')
    })

    it('reports when the mode filter leaves nothing', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheEngineVersions: versions })

      await run(['engine-versions', '--mode', 'provisioned'])

      expect(logSpy).toHaveBeenCalledWith('No engine versions found matching the filters.')
    })
  })

  describe('create', () => {
    it('offers only engine versions that support the chosen mode', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({
          createCache: { success: true, cache, deploymentId: 'd3pw8k' },
        })
      promptMocks.select.mockResolvedValueOnce('7.2')

      await run([
        'create',
        '--cloud',
        'cloud-1',
        '--network',
        'h4nw8r',
        '--name',
        'Sessions',
        '--engine',
        'valkey',
        '--node-type',
        'cache.t4g.micro',
        '--serverless',
      ])

      expect(sentQuery(0)).not.toContain('deploymentMode')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ engine: 'valkey' })

      const selectArgs = promptMocks.select.mock.calls[0]?.[0] as {
        choices: { value: string }[]
      }
      expect(selectArgs.choices.map((c) => c.value)).toEqual(['8.0', '7.1'])

      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: {
          engine: 'VALKEY',
          slug: 'sessions',
          providerData: { engineVersion: '7.2', deploymentMode: 'serverless' },
        },
      })
    })

    it('queries the catalogs in lower case and sends the enum name when the engine is picked', async () => {
      const cacheTypes = [
        {
          type: 'VALKEY',
          displayName: 'Valkey',
          description: 'Redis-compatible',
          supportsServerless: true,
        },
      ]
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes })
        .mockResolvedValueOnce({ cacheTypes })
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({
          cacheNodeTypes: [
            {
              nodeType: 'cache.t4g.micro',
              family: 't4g',
              size: 'micro',
              memoryGiB: 0.5,
              vcpu: 2,
            },
          ],
        })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })
      promptMocks.select
        .mockResolvedValueOnce('VALKEY')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce('7.2')
        .mockResolvedValueOnce('cache.t4g.micro')

      await run(['create', '--cloud', 'cloud-1', '--network', 'h4nw8r', '--name', 'Sessions'])

      expect(promptMocks.select).toHaveBeenCalledTimes(4)
      expect(graphqlRequest.mock.calls[2]?.[1]).toEqual({ engine: 'valkey' })
      expect(sentQuery(3)).toContain('query GetCacheNodeTypes')
      expect(graphqlRequest.mock.calls[3]?.[1]).toEqual({ engine: 'valkey' })
      expect(graphqlRequest.mock.calls[4]?.[1]).toMatchObject({
        input: {
          engine: 'VALKEY',
          providerData: {
            deploymentMode: 'node-based',
            engineVersion: '7.2',
            nodeType: 'cache.t4g.micro',
          },
        },
      })
    })

    it('rejects an unknown --engine before calling the API', async () => {
      await expect(
        run([
          'create',
          '--cloud',
          'cloud-1',
          '--network',
          'h4nw8r',
          '--name',
          'Sessions',
          '--engine',
          'postgres',
        ])
      ).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.flat().join(' ')).toContain('Unknown cache engine.')
    })

    it.each(['dragonfly', 'mysql'])('rejects the unknown --engine %j locally', async (engine) => {
      await expect(
        run(['create', '--cloud', 'c', '--network', 'n', '--name', 'Sessions', '--engine', engine])
      ).rejects.toThrow('process.exit(1)')

      expect(graphqlRequest).not.toHaveBeenCalled()
      expect(errorOutput()).toContain(
        'Unknown cache engine. Supported engines: memcached, redis, valkey'
      )
    })

    it('fails without creating anything when no network is selected', async () => {
      cloudMocks.selectNetwork.mockResolvedValueOnce(undefined)

      await expect(
        run(['create', '--cloud', 'cloud-1', '--name', 'Sessions', '--engine', 'valkey'])
      ).rejects.toThrow('process.exit(1)')

      expect(cloudMocks.selectNetwork).toHaveBeenCalledWith('cloud-1')
      expect(errorOutput()).toContain('A network is required to create a cache.')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(graphqlRequest).not.toHaveBeenCalled()
    })
  })

  describe('tunnel', () => {
    it('looks a cache up by listing and filtering on slug', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [cache] })

      await expect(run(['tunnel', 'sessions'])).rejects.toThrow(ExitError)

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(sentQuery(0)).toContain('query GetCaches')
      expect(errorSpy.mock.calls.flat().join(' ')).toContain('Cache endpoint not available')
    })

    it('accepts a cache id in place of the slug', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [cache] })

      await expect(run(['tunnel', 'cache-id-1'])).rejects.toThrow(ExitError)

      expect(errorSpy.mock.calls.flat().join(' ')).toContain('Cache endpoint not available')
    })

    it.each([
      ['REDIS', '6379'],
      ['VALKEY', '6379'],
      ['MEMCACHED', '11211'],
    ])('offers the %s default port when prompting', async (engine, port) => {
      graphqlRequest.mockResolvedValueOnce({
        caches: [
          {
            ...cache,
            engine,
            endpoint: 'sessions.abc.cache.amazonaws.com:6379',
          },
        ],
      })
      promptMocks.input.mockRejectedValueOnce(new Error('stop'))

      await expect(run(['tunnel', 'sessions'])).rejects.toThrow('process.exit(1)')

      expect(promptMocks.input).toHaveBeenCalledWith(expect.objectContaining({ default: port }))
    })

    it('prefers an exact id match over a slug match', async () => {
      graphqlRequest.mockResolvedValueOnce({
        caches: [
          { ...cache, id: 'cache-id-2', slug: 'cache-id-1', endpoint: null },
          { ...cache, endpoint: 'sessions.abc.cache.amazonaws.com:6380', port: 6380 },
        ],
      })
      promptMocks.input.mockRejectedValueOnce(new Error('stop'))

      await expect(run(['tunnel', 'cache-id-1'])).rejects.toThrow('process.exit(1)')

      expect(promptMocks.input).toHaveBeenCalledWith(expect.objectContaining({ default: '6380' }))
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('Cache endpoint not available')
    })

    it('fails when no cache matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [cache] })

      await expect(run(['tunnel', 'missing'])).rejects.toThrow('process.exit(1)')

      expect(errorSpy.mock.calls.flat().join(' ')).toContain('Cache not found.')
    })

    describe('connecting', () => {
      let sigintHandlers: (() => void)[]
      const close = vi.fn()

      beforeEach(() => {
        sigintHandlers = []
        const realOn = process.on.bind(process)
        vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
          if (event === 'SIGINT') {
            sigintHandlers.push(listener)
            return process
          }
          return realOn(event, listener)
        }) as typeof process.on)
        close.mockResolvedValue(undefined)
        bastionMocks.fetchBastionCredentials.mockResolvedValue({
          privateKey: 'fake-bastion-private-key',
          hostPublicKey: null,
          hostKeyFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
        })
        tunnelMocks.openSshTunnel.mockResolvedValue({ localPort: 16379, close })
      })

      async function runUntilSigint(args: string[]): Promise<void> {
        const pending = run(args)
        await vi.waitFor(() => {
          expect(sigintHandlers).toHaveLength(1)
        })
        sigintHandlers[0]?.()
        sigintHandlers[0]?.()
        await pending
      }

      it('tunnels through the named bastion, passes the host-key policy and closes on SIGINT', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce(bastion)

        await runUntilSigint([
          'tunnel',
          'sessions',
          '--bastion',
          'ops-bastion',
          '--port',
          '16379',
          '--trust-host-key',
        ])

        expect(bastionMocks.selectBastion).not.toHaveBeenCalled()
        expect(promptMocks.input).not.toHaveBeenCalled()
        expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('ops-bastion')
        expect(sentQuery(1)).toContain('query GetCacheTunnelBastion($slug: String!)')
        expect(sentVariables(1)).toEqual({ slug: 'ops-bastion' })

        const config = tunnelMocks.openSshTunnel.mock.calls[0]?.[0] as {
          hostKey: { pauseOutput: () => void; resumeOutput: () => void }
        }
        expect(config).toEqual({
          bastionHost: '203.0.113.10',
          hostKey: {
            hostId: 'i-0abc123',
            label: 'ops-bastion',
            expectedFingerprint: 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs',
            trustHostKey: true,
            pauseOutput: expect.any(Function) as unknown,
            resumeOutput: expect.any(Function) as unknown,
          },
          privateKey: 'fake-bastion-private-key',
          remoteHost: 'sessions.abc123.use1.cache.amazonaws.com',
          remotePort: 6379,
          localPort: 16379,
        })
        spinner.stop.mockClear()
        spinner.start.mockClear()
        config.hostKey.pauseOutput()
        expect(spinner.stop).toHaveBeenCalledTimes(1)
        expect(spinner.start).not.toHaveBeenCalled()
        config.hostKey.resumeOutput()
        expect(spinner.start).toHaveBeenCalledTimes(1)

        expect(spinner.succeed).toHaveBeenCalledWith('Tunnel connected')
        expect(logLines()).toEqual([
          '  Host:     localhost',
          '  Port:     16379',
          '  Engine:   VALKEY',
          '  Cache:    sessions.abc123.use1.cache.amazonaws.com',
          '',
          '  Press Ctrl+C to close the tunnel.',
          '\n  Closing tunnel...',
        ])
        expect(close).toHaveBeenCalledTimes(1)
        expect(tunnelMocks.openDirectTunnel).not.toHaveBeenCalled()
      })

      it('uses the bastion chosen from the network', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce(bastion)
        bastionMocks.selectBastion.mockResolvedValueOnce({ slug: 'net-bastion' })

        await runUntilSigint(['tunnel', 'sessions', '--port', '16379'])

        expect(bastionMocks.selectBastion).toHaveBeenCalledWith({
          networkId: 'h4nw8r',
          includeCreateOption: true,
          filter: bastionMocks.activeOnly,
        })
        expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('net-bastion')
        expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
          expect.objectContaining({
            hostKey: expect.objectContaining({ trustHostKey: undefined }) as unknown,
          })
        )
      })

      it('creates a bastion when asked and waits for it', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce(bastion)
        bastionMocks.selectBastion.mockResolvedValueOnce('create')
        bastionMocks.createBastionInteractive.mockResolvedValueOnce({ slug: 'new-bastion' })

        await runUntilSigint(['tunnel', 'sessions', '--port', '16379'])

        expect(bastionMocks.createBastionInteractive).toHaveBeenCalledWith({
          cloudAccountId: 'cloud-1',
          networkId: 'h4nw8r',
          waitForActive: true,
        })
        expect(bastionMocks.fetchBastionCredentials).toHaveBeenCalledWith('new-bastion')
      })

      it.each([
        ['REDIS', '6379'],
        ['VALKEY', '6379'],
        ['MEMCACHED', '11211'],
      ])('tunnels to the %s default port with the prompted local port', async (engine, port) => {
        graphqlRequest
          .mockResolvedValueOnce({
            caches: [{ ...cache, engine, endpoint: 'sessions.cache.internal' }],
          })
          .mockResolvedValueOnce(bastion)
        promptMocks.input.mockResolvedValueOnce('20000')

        await runUntilSigint(['tunnel', 'sessions', '--bastion', 'ops-bastion'])

        const prompt = promptMocks.input.mock.calls[0]?.[0] as {
          default: string
          validate: (v: string) => unknown
        }
        expect(prompt.default).toBe(port)
        expect(prompt.validate('0')).toBe('Enter a valid port (1-65535)')
        expect(prompt.validate('65536')).toBe('Enter a valid port (1-65535)')
        expect(prompt.validate('six')).toBe('Enter a valid port (1-65535)')
        expect(prompt.validate('20000')).toBe(true)
        expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
          expect.objectContaining({ remotePort: Number(port), localPort: 20000 })
        )
      })

      it('offers the provider port for an unknown engine', async () => {
        graphqlRequest
          .mockResolvedValueOnce({
            caches: [
              {
                ...cache,
                engine: 'DRAGONFLY',
                endpoint: 'sessions.cache.internal',
                port: 6380,
              },
            ],
          })
          .mockResolvedValueOnce(bastion)
        promptMocks.input.mockResolvedValueOnce('6380')

        await runUntilSigint(['tunnel', 'sessions', '--bastion', 'ops-bastion'])

        expect(promptMocks.input).toHaveBeenCalledWith(expect.objectContaining({ default: '6380' }))
        expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
          expect.objectContaining({ remotePort: 6380 })
        )
      })

      it('tunnels to the cache picked from the prompt', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce(bastion)
        promptMocks.select.mockResolvedValueOnce('cache-id-1')

        await runUntilSigint(['tunnel', '--bastion', 'ops-bastion', '--port', '16379'])

        expect(tunnelMocks.openSshTunnel).toHaveBeenCalledWith(
          expect.objectContaining({ remoteHost: 'sessions.abc123.use1.cache.amazonaws.com' })
        )
      })

      it('fails when the bastion has no public IP', async () => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce({ bastion: null })

        await expect(
          run(['tunnel', 'sessions', '--bastion', 'ops-bastion', '--port', '16379'])
        ).rejects.toThrow('process.exit(1)')

        expect(spinner.fail).toHaveBeenCalledWith('Bastion host does not have a public IP address.')
        expect(tunnelMocks.openSshTunnel).not.toHaveBeenCalled()
      })

      it.each([
        [new Error('Host key verification failed'), 'Host key verification failed'],
        ['ETIMEDOUT', 'ETIMEDOUT'],
      ])('reports an SSH failure (%s)', async (failure, message) => {
        graphqlRequest
          .mockResolvedValueOnce({ caches: [reachableCache] })
          .mockResolvedValueOnce(bastion)
        tunnelMocks.openSshTunnel.mockRejectedValueOnce(failure)

        await expect(
          run(['tunnel', 'sessions', '--bastion', 'ops-bastion', '--port', '16379'])
        ).rejects.toThrow('process.exit(1)')

        expect(spinner.fail).toHaveBeenCalledWith(`Failed to connect: ${message}`)
      })
    })

    it('fails clearly for an unknown engine with no provider port', async () => {
      graphqlRequest.mockResolvedValueOnce({
        caches: [{ ...cache, engine: 'DRAGONFLY', endpoint: 'sessions.cache.internal' }],
      })

      await expect(run(['tunnel', 'sessions', '--bastion', 'ops-bastion'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorOutput()).toContain('Unknown database or cache engine.')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(tunnelMocks.openSshTunnel).not.toHaveBeenCalled()
    })

    it('prompts with only active caches', async () => {
      graphqlRequest.mockResolvedValueOnce({
        caches: [cache, { ...cache, id: 'cache-id-2', slug: 'queue', status: 'PENDING' }],
      })
      promptMocks.select.mockResolvedValueOnce('cache-id-gone')

      await expect(run(['tunnel'])).rejects.toThrow('process.exit(1)')

      expect(promptMocks.select).toHaveBeenCalledWith({
        message: 'Select a cache:',
        choices: [{ name: 'Sessions (VALKEY) — sessions', value: 'cache-id-1' }],
      })
      expect(errorOutput()).toContain('Cache not found.')
    })

    it('fails when there are no active caches', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [{ ...cache, status: 'FAILED' }] })

      await expect(run(['tunnel'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('No active caches found.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['tunnel', 'sessions'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Unauthorized')
    })
  })

  describe('list', () => {
    it('prints a row per cache with an upper-cased status', async () => {
      graphqlRequest.mockResolvedValueOnce({
        caches: [
          cache,
          { ...cache, id: 'cache-id-2', slug: 'queue', engine: 'REDIS', status: 'pending' },
        ],
      })

      await run(['list'])

      expect(sentQuery(0)).toContain('query GetCaches')
      const output = logOutput()
      expect(output).toContain('sessions')
      expect(output).toContain('queue')
      expect(output).toContain('REDIS')
      expect(output).toContain('PENDING')
    })

    it('says so when there are no caches', async () => {
      graphqlRequest.mockResolvedValueOnce({ caches: [] })

      await run(['list'])

      expect(logSpy).toHaveBeenCalledWith('No caches found.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Unauthorized'))

      await expect(run(['list'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Unauthorized')
    })
  })

  describe('engines', () => {
    it('lists each engine with its serverless and cluster-mode support', async () => {
      graphqlRequest.mockResolvedValueOnce({
        cacheTypes: [
          {
            type: 'VALKEY',
            displayName: 'Valkey',
            description: 'Redis-compatible',
            supportsServerless: true,
            supportsClusterMode: true,
          },
          {
            type: 'MEMCACHED',
            displayName: 'Memcached',
            description: 'Simple key-value',
            supportsServerless: false,
            supportsClusterMode: false,
          },
        ],
      })

      await run(['engines'])

      const output = logOutput()
      expect(output).toContain('Valkey')
      expect(output).toContain('Memcached')
      expect(output).toContain('Yes')
      expect(output).toContain('No')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engines'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('engine-versions errors', () => {
    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engine-versions'])).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('boom')
    })
  })

  describe('node-types', () => {
    it('sends the catalog engine and region and prints each node type', async () => {
      graphqlRequest.mockResolvedValueOnce({
        cacheNodeTypes: [
          { nodeType: 'cache.r7g.large', family: 'r7g', size: 'large', memoryGiB: 13.07, vcpu: 2 },
        ],
      })

      await run(['node-types', '--engine', 'REDIS', '--region', 'us-west-2'])

      expect(sentQuery(0)).toContain('query GetCacheNodeTypes')
      expect(sentVariables(0)).toEqual({ engine: 'redis', region: 'us-west-2' })
      const output = logOutput()
      expect(output).toContain('cache.r7g.large')
      expect(output).toContain('13.07')
    })

    it('reports when nothing matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheNodeTypes: [] })

      await run(['node-types'])

      expect(sentVariables(0)).toEqual({})
      expect(logSpy).toHaveBeenCalledWith('No node types found matching the filters.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['node-types'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('create outcomes', () => {
    const fullArgs = [
      'create',
      '--cloud',
      'cloud-1',
      '--network',
      'h4nw8r',
      '--name',
      'Sessions',
      '--engine',
      'redis',
      '--engine-version',
      '7.1',
      '--node-type',
      'cache.t4g.micro',
    ]

    it('uses every flag without prompting and prints the deployment', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: 'REDIS', supportsServerless: false }] })
        .mockResolvedValueOnce({
          createCache: { success: true, cache, deploymentId: 'h6cz1y' },
        })

      await run([...fullArgs, '--slug', 'session-store'])

      expect(promptMocks.select).not.toHaveBeenCalled()
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(cloudMocks.selectCloud).not.toHaveBeenCalled()
      expect(sentVariables(1)).toEqual({
        input: {
          cloudAccountId: 'cloud-1',
          networkId: 'h4nw8r',
          name: 'Sessions',
          slug: 'session-store',
          engine: 'REDIS',
          providerData: {
            deploymentMode: 'node-based',
            nodeType: 'cache.t4g.micro',
            engineVersion: '7.1',
          },
        },
      })
      const output = logOutput()
      expect(output).toContain('Cache created: Sessions (sessions)')
      expect(output).toContain('  ID: cache-id-1')
      expect(output).toContain('  Deployment: h6cz1y')
    })

    it.each([
      ['memcached', 'MEMCACHED'],
      ['MEMCACHED', 'MEMCACHED'],
      ['Redis', 'REDIS'],
      ['VALKEY', 'VALKEY'],
    ])('--engine %s sends %s', async (flag, enumName) => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: enumName, supportsServerless: false }] })
        .mockResolvedValueOnce({ cacheEngineVersions: [] })
        .mockResolvedValueOnce({ cacheNodeTypes: [] })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })

      await run([
        'create',
        '--cloud',
        'c',
        '--network',
        'n',
        '--name',
        'Sessions',
        '--engine',
        flag,
      ])

      expect(promptMocks.select).not.toHaveBeenCalled()
      expect(sentVariables(1)).toEqual({ engine: enumName.toLowerCase() })
      expect(sentVariables(2)).toEqual({ engine: enumName.toLowerCase() })
      expect(sentVariables(3)).toEqual({
        input: {
          cloudAccountId: 'c',
          networkId: 'n',
          name: 'Sessions',
          slug: 'sessions',
          engine: enumName,
          providerData: { deploymentMode: 'node-based' },
        },
      })
    })

    it('prompts for cloud, network and name and filters versions to node-based', async () => {
      cloudMocks.selectCloud.mockResolvedValueOnce('cloud-9')
      cloudMocks.selectNetwork.mockResolvedValueOnce('x9mf3d')
      promptMocks.input.mockResolvedValueOnce('Rate Limits')
      promptMocks.select.mockResolvedValueOnce('7.2').mockResolvedValueOnce('cache.t4g.small')
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: 'VALKEY', supportsServerless: false }] })
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({
          cacheNodeTypes: [
            { nodeType: 'cache.t4g.small', family: 't4g', size: 'small', memoryGiB: 1.37, vcpu: 2 },
          ],
        })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })

      await run(['create', '--engine', 'valkey'])

      expect(cloudMocks.selectNetwork).toHaveBeenCalledWith('cloud-9')
      const nameValidate = (
        promptMocks.input.mock.calls[0]?.[0] as { validate: (v: string) => unknown }
      ).validate
      expect(nameValidate(' ')).toBe('Name is required')
      expect(nameValidate('Rate Limits')).toBe(true)

      const choices = (i: number) =>
        (promptMocks.select.mock.calls[i]?.[0] as { choices: { name: string; value: string }[] })
          .choices
      expect(choices(0)).toEqual([
        { name: '7.2 (valkey7)', value: '7.2' },
        { name: '7.1 (valkey7)', value: '7.1' },
      ])
      expect(choices(1)).toEqual([
        { name: 'cache.t4g.small — 2 vCPU, 1.37 GiB RAM', value: 'cache.t4g.small' },
      ])
      expect(sentVariables(3)).toEqual({
        input: {
          cloudAccountId: 'cloud-9',
          networkId: 'x9mf3d',
          name: 'Rate Limits',
          slug: 'rate-limits',
          engine: 'VALKEY',
          providerData: {
            deploymentMode: 'node-based',
            nodeType: 'cache.t4g.small',
            engineVersion: '7.2',
          },
        },
      })
    })

    it('skips node types when serverless is chosen interactively', async () => {
      promptMocks.select.mockResolvedValueOnce(true).mockResolvedValueOnce('8.0')
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: 'VALKEY', supportsServerless: true }] })
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })

      await run([
        'create',
        '--cloud',
        'c',
        '--network',
        'n',
        '--name',
        'Sessions',
        '--engine',
        'valkey',
      ])

      const versionChoices = (
        promptMocks.select.mock.calls[1]?.[0] as { choices: { value: string }[] }
      ).choices.map((c) => c.value)
      expect(versionChoices).toEqual(['8.0', '7.1'])
      expect(sentQuery(2)).toContain('mutation CreateCache')
      expect(sentVariables(2)).toMatchObject({
        input: { providerData: { engineVersion: '8.0', deploymentMode: 'serverless' } },
      })
    })

    it('derives the slug from the name when --slug is empty', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [] })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })

      await run([...fullArgs, '--slug', ''])

      expect(sentVariables(1)).toMatchObject({ input: { slug: 'sessions' } })
    })

    it.each([
      [
        { success: false, message: 'Network has no private subnets' },
        'Network has no private subnets',
      ],
      [{ success: false }, 'Failed to create cache'],
      [{ success: true }, 'Failed to create cache'],
    ])('fails when the mutation result is %j', async (createCache, message) => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [] })
        .mockResolvedValueOnce({ createCache })

      await expect(run(fullArgs)).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain(message)
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('Forbidden'))

      await expect(run(fullArgs)).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('Forbidden')
    })
  })
})
