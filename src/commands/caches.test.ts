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
const cloudMocks = vi.hoisted(() => ({
  resolveCloud: vi.fn((id?: string) => Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' })),
  selectNetwork: vi.fn(),
}))

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
  {
    engine: 'VALKEY',
    version: '8.0',
    providerData: { provider: 'aws', parameterGroupFamily: 'valkey8' },
  },
  {
    engine: 'VALKEY',
    version: '7.2',
    providerData: { provider: 'aws', parameterGroupFamily: 'valkey7' },
  },
  {
    engine: 'VALKEY',
    version: '7.1',
    providerData: { provider: 'aws', parameterGroupFamily: 'valkey7' },
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
  bastion: { id: 'r3bq9m', publicIp: '203.0.113.10' },
}

describe('caches command', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance

  const logLines = () => logSpy.mock.calls.map((c) => c.map(String).join(' '))
  const logOutput = () => logLines().join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    cloudMocks.resolveCloud.mockImplementation((id?: string) =>
      Promise.resolve({ id: id ?? 'cloud_1', provider: 'AWS' })
    )
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
    it('sends the engine, region and AWS mode and labels each version with its family', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheEngineVersions: versions })

      await run([
        'engine-versions',
        '--cloud',
        'cloud-1',
        '--engine',
        'valkey',
        '--region',
        'us-east-1',
        '--aws-mode',
        'serverless',
      ])

      expect(sentQuery(0)).toContain('query GetCacheEngineVersions')
      expect(sentVariables(0)).toEqual({
        provider: 'AWS',
        engine: 'VALKEY',
        region: 'us-east-1',
        aws: { deploymentMode: 'SERVERLESS' },
      })
      const output = String(logSpy.mock.calls[0]?.[0])
      expect(output).toContain('8.0 (valkey8)')
      expect(output).toContain('7.1 (valkey7)')
    })

    it('reports when nothing matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheEngineVersions: [] })

      await run(['engine-versions', '--cloud', 'cloud-1'])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      expect(logSpy).toHaveBeenCalledWith('No engine versions found matching the filters.')
    })

    it('refuses an unknown --aws-mode', async () => {
      await expect(
        run(['engine-versions', '--cloud', 'cloud-1', '--aws-mode', 'cluster'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('--aws-mode must be serverless or node-based')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses AWS filters on another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })

      await expect(
        run(['engine-versions', '--cloud', 'ca_9mx4', '--aws-mode', 'serverless'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('--aws-mode only applies to AWS cloud accounts.')
    })
  })

  describe('create', () => {
    const valkey = {
      type: 'VALKEY',
      displayName: 'Valkey',
      description: 'Redis-compatible',
      supportsServerless: true,
    }

    it('asks for serverless versions when --aws-serverless is passed', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [valkey] })
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({
          createCache: { success: true, cache, deploymentId: 'd3pw8k' },
        })
      promptMocks.select.mockResolvedValueOnce('8.0')

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
        '--aws-serverless',
      ])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      expect(sentVariables(1)).toEqual({
        provider: 'AWS',
        engine: 'VALKEY',
        aws: { deploymentMode: 'SERVERLESS' },
      })
      expect(sentVariables(2)).toMatchObject({
        input: {
          engine: 'VALKEY',
          slug: 'sessions',
          engineVersion: '8.0',
          aws: { deploymentMode: 'SERVERLESS' },
        },
      })
    })

    it('offers the engines, versions and sizes of the cloud when nothing is passed', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [valkey] })
        .mockResolvedValueOnce({ cacheEngineVersions: versions })
        .mockResolvedValueOnce({
          cacheSizes: [{ size: 'cache.t4g.micro', family: 't4g', memoryGiB: 0.5, vcpu: 2 }],
        })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })
      promptMocks.select
        .mockResolvedValueOnce('VALKEY')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce('7.2')
        .mockResolvedValueOnce('cache.t4g.micro')

      await run(['create', '--cloud', 'cloud-1', '--network', 'h4nw8r', '--name', 'Sessions'])

      expect(promptMocks.select).toHaveBeenCalledTimes(4)
      expect(sentVariables(1)).toEqual({
        provider: 'AWS',
        engine: 'VALKEY',
        aws: { deploymentMode: 'NODE_BASED' },
      })
      expect(sentQuery(2)).toContain('query GetCacheSizes')
      expect(sentVariables(2)).toEqual({ provider: 'AWS', engine: 'VALKEY' })
      expect(sentVariables(3)).toMatchObject({
        input: {
          engine: 'VALKEY',
          engineVersion: '7.2',
          size: 'cache.t4g.micro',
          aws: { deploymentMode: 'NODE_BASED' },
        },
      })
    })

    it.each(['postgres', 'dragonfly', 'mysql'])(
      'rejects the unknown --engine %j before calling the API',
      async (engine) => {
        await expect(
          run([
            'create',
            '--cloud',
            'c',
            '--network',
            'n',
            '--name',
            'Sessions',
            '--engine',
            engine,
          ])
        ).rejects.toThrow('process.exit(1)')

        expect(graphqlRequest).not.toHaveBeenCalled()
        expect(errorOutput()).toContain(
          'Unknown cache engine. Supported engines: memcached, redis, valkey'
        )
      }
    )

    it('fails without creating anything when no network is selected', async () => {
      cloudMocks.selectNetwork.mockResolvedValueOnce(undefined)
      graphqlRequest.mockResolvedValueOnce({ cacheTypes: [valkey] })

      await expect(
        run(['create', '--cloud', 'cloud-1', '--name', 'Sessions', '--engine', 'valkey'])
      ).rejects.toThrow('process.exit(1)')

      expect(cloudMocks.selectNetwork).toHaveBeenCalledWith('cloud-1')
      expect(errorOutput()).toContain('A network is required to create a cache.')
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses a cloud with no cache engines', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce({ cacheTypes: [] })

      await expect(run(['create', '--cloud', 'ca_9mx4', '--name', 'Sessions'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorOutput()).toContain("This cloud doesn't support caches yet.")
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('refuses AWS flags on another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })

      await expect(run(['create', '--cloud', 'ca_9mx4', '--aws-serverless'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorOutput()).toContain('--aws-serverless only applies to AWS cloud accounts.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses an engine the cloud does not offer', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheTypes: [valkey] })

      await expect(
        run(['create', '--cloud', 'c', '--network', 'n', '--name', 'Sessions', '--engine', 'redis'])
      ).rejects.toThrow('process.exit(1)')

      expect(errorOutput()).toContain('That engine is not offered. See "gantry caches engines".')
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
          sshUser: 'ubuntu',
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
          bastionUsername: 'ubuntu',
          hostKey: {
            hostId: 'bastion-r3bq9m@203.0.113.10',
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
    const cacheTypes = [
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
    ]

    it('lists each engine with its AWS serverless and cluster-mode support', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheTypes })

      await run(['engines', '--cloud', 'cloud-1'])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      const output = logOutput()
      expect(output).toContain('Valkey')
      expect(output).toContain('Memcached')
      expect(output).toContain('Cluster Mode')
      expect(output).toContain('Yes')
      expect(output).toContain('No')
    })

    it('shows only the shared columns for another cloud', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'ca_9mx4', provider: 'GCP' })
      graphqlRequest.mockResolvedValueOnce({ cacheTypes })

      await run(['engines', '--cloud', 'ca_9mx4'])

      expect(logOutput()).not.toContain('Cluster Mode')
    })

    it('says when the cloud has no cache engines', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheTypes: [] })

      await run(['engines', '--cloud', 'cloud-1'])

      expect(logLines()).toEqual(["This cloud doesn't support caches yet."])
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engines', '--cloud', 'cloud-1'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('engine-versions errors', () => {
    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['engine-versions', '--cloud', 'cloud-1'])).rejects.toThrow(
        'process.exit(1)'
      )

      expect(errorOutput()).toContain('boom')
    })
  })

  describe('sizes', () => {
    it('sends the engine and region and prints each size', async () => {
      graphqlRequest.mockResolvedValueOnce({
        cacheSizes: [{ size: 'cache.r7g.large', family: 'r7g', memoryGiB: 13.07, vcpu: 2 }],
      })

      await run(['sizes', '--cloud', 'cloud-1', '--engine', 'REDIS', '--region', 'us-west-2'])

      expect(sentQuery(0)).toContain('query GetCacheSizes')
      expect(sentVariables(0)).toEqual({ provider: 'AWS', engine: 'REDIS', region: 'us-west-2' })
      const output = logOutput()
      expect(output).toContain('cache.r7g.large')
      expect(output).toContain('13.07')
    })

    it('reports when nothing matches', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheSizes: [] })

      await run(['sizes', '--cloud', 'cloud-1'])

      expect(sentVariables(0)).toEqual({ provider: 'AWS' })
      expect(logSpy).toHaveBeenCalledWith('No sizes found matching the filters.')
    })

    it('exits non-zero when the API fails', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('boom'))

      await expect(run(['sizes', '--cloud', 'cloud-1'])).rejects.toThrow('process.exit(1)')
    })
  })

  describe('create outcomes', () => {
    const redis = { type: 'REDIS', displayName: 'Redis', supportsServerless: false }
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
      '--size',
      'cache.t4g.micro',
    ]

    it('uses every flag without prompting and prints the deployment', async () => {
      graphqlRequest.mockResolvedValueOnce({ cacheTypes: [redis] }).mockResolvedValueOnce({
        createCache: { success: true, cache, deploymentId: 'h6cz1y' },
      })

      await run([...fullArgs, '--slug', 'session-store'])

      expect(promptMocks.select).not.toHaveBeenCalled()
      expect(promptMocks.input).not.toHaveBeenCalled()
      expect(cloudMocks.resolveCloud).toHaveBeenCalledWith('cloud-1')
      expect(sentVariables(1)).toEqual({
        input: {
          cloudAccountId: 'cloud-1',
          networkId: 'h4nw8r',
          name: 'Sessions',
          slug: 'session-store',
          engine: 'REDIS',
          engineVersion: '7.1',
          size: 'cache.t4g.micro',
          aws: { deploymentMode: 'NODE_BASED' },
        },
      })
      const output = logOutput()
      expect(output).toContain('Cache created: Sessions (sessions)')
      expect(output).toContain('  ID: cache-id-1')
      expect(output).toContain('  Deployment: h6cz1y')
    })

    it('sends --backup-days as a shared setting', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [redis] })
        .mockResolvedValueOnce({ createCache: { success: true, cache } })

      await run([...fullArgs, '--backup-days', '7'])

      expect(sentVariables(1)).toMatchObject({ input: { backupRetentionDays: 7 } })
    })

    it.each(['-1', '1.5', 'week'])(
      'rejects --backup-days %s before calling the API',
      async (days) => {
        await expect(run([...fullArgs, '--backup-days', days])).rejects.toThrow('process.exit(1)')

        expect(graphqlRequest).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['memcached', 'MEMCACHED'],
      ['MEMCACHED', 'MEMCACHED'],
      ['Redis', 'REDIS'],
      ['VALKEY', 'VALKEY'],
    ])('--engine %s sends %s', async (flag, enumName) => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: enumName, supportsServerless: false }] })
        .mockResolvedValueOnce({ cacheEngineVersions: [] })
        .mockResolvedValueOnce({ cacheSizes: [] })
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
      expect(sentVariables(1)).toMatchObject({ engine: enumName })
      expect(sentVariables(2)).toEqual({ provider: 'AWS', engine: enumName })
      expect(sentVariables(3)).toEqual({
        input: {
          cloudAccountId: 'c',
          networkId: 'n',
          name: 'Sessions',
          slug: 'sessions',
          engine: enumName,
          aws: { deploymentMode: 'NODE_BASED' },
        },
      })
    })

    it('prompts for cloud, network and name and asks for node-based versions', async () => {
      cloudMocks.resolveCloud.mockResolvedValueOnce({ id: 'cloud-9', provider: 'AWS' })
      cloudMocks.selectNetwork.mockResolvedValueOnce('x9mf3d')
      promptMocks.input.mockResolvedValueOnce('Rate Limits')
      promptMocks.select.mockResolvedValueOnce('7.2').mockResolvedValueOnce('cache.t4g.small')
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: 'VALKEY', supportsServerless: false }] })
        .mockResolvedValueOnce({ cacheEngineVersions: versions.slice(1) })
        .mockResolvedValueOnce({
          cacheSizes: [{ size: 'cache.t4g.small', family: 't4g', memoryGiB: 1.37, vcpu: 2 }],
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
          engineVersion: '7.2',
          size: 'cache.t4g.small',
          aws: { deploymentMode: 'NODE_BASED' },
        },
      })
    })

    it('skips sizes when serverless is chosen interactively', async () => {
      promptMocks.select.mockResolvedValueOnce(true).mockResolvedValueOnce('8.0')
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [{ type: 'VALKEY', supportsServerless: true }] })
        .mockResolvedValueOnce({ cacheEngineVersions: [versions[0], versions[2]] })
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

      expect(sentVariables(1)).toMatchObject({ aws: { deploymentMode: 'SERVERLESS' } })
      expect(sentQuery(2)).toContain('mutation CreateCache')
      expect(sentVariables(2)).toMatchObject({
        input: { engineVersion: '8.0', aws: { deploymentMode: 'SERVERLESS' } },
      })
    })

    it('derives the slug from the name when --slug is empty', async () => {
      graphqlRequest
        .mockResolvedValueOnce({ cacheTypes: [redis] })
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
        .mockResolvedValueOnce({ cacheTypes: [redis] })
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
